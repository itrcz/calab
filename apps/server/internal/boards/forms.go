package boards

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func (s *Service) formPlan(ctx context.Context, ws uuid.UUID) (plans.Limits, error) {
	if s.plans == nil {
		return plans.Limits{}, nil
	}
	l, err := s.plans.Effective(ctx, ws)
	if err == nil && l.BoardFormsDisabled {
		err = plans.FeatureError("board_forms")
	}
	return l, err
}

func formDefinition(row sqlc.BoardForm) (*v1.BoardFormDefinition, error) {
	d := &v1.BoardFormDefinition{}
	err := protojson.Unmarshal(row.Definition, d)
	return d, err
}

func (s *Service) formProto(row sqlc.BoardForm) (*v1.BoardForm, error) {
	d, err := formDefinition(row)
	if err != nil {
		return nil, err
	}
	return &v1.BoardForm{Id: row.ID.String(), BoardId: row.BoardID.String(), Url: strings.TrimRight(s.PublicURL, "/") + "/f/" + row.Code,
		Definition: d, Revision: uint32(row.Revision), CreatedBy: idp(row.CreatedBy), CreatedAt: timestamppb.New(row.CreatedAt), UpdatedAt: timestamppb.New(row.UpdatedAt)}, nil //nolint:gosec // positive DB revision
}

func (s *Service) listForms(w http.ResponseWriter, r *http.Request) error {
	id, _, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListBoardForms(r.Context(), id)
	if err != nil {
		return err
	}
	out := &v1.ListBoardFormsResponse{}
	for _, row := range rows {
		f, err := s.formProto(row)
		if err != nil {
			return err
		}
		out.Forms = append(out.Forms, f)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// Re-resolve management rights under the write transaction.
func formManager(ctx context.Context, q *sqlc.Queries, boardID, user uuid.UUID) error {
	acc, err := perm.NewResolver(q).Board(ctx, boardID, user)
	if err != nil {
		return err
	}
	if acc.Archived || !acc.Bits.Has(perm.ViewBoard|perm.ManageBoard) {
		return httpx.NotFound("form")
	}
	return writable(acc)
}

func validateFormTarget(ctx context.Context, q *sqlc.Queries, b sqlc.Board, d *v1.BoardFormDefinition) error {
	statuses, err := q.ListBoardStatuses(ctx, []uuid.UUID{b.ID})
	if err != nil {
		return err
	}
	found := false
	for _, st := range statuses {
		if st.ID.String() == d.StatusId {
			found = true
		}
	}
	if !found {
		return httpx.Conflict("form target is unavailable").WithDetails("FORM_TARGET_UNAVAILABLE", 0, 0)
	}
	if err := requireFeature(b.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_PRIORITY, "priority", d.Priority != v1.TaskPriority_TASK_PRIORITY_NONE); err != nil {
		return err
	}
	for _, raw := range d.AllowedUserIds {
		u, _ := uuid.Parse(raw)
		if _, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: b.WorkspaceID, UserID: u}); err != nil {
			if db.IsNotFound(err) {
				return httpx.Validation("allowedUserIds", "workspace member required")
			}
			return err
		}
	}
	return nil
}

func (s *Service) createForm(w http.ResponseWriter, r *http.Request) error {
	id, _, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	var req v1.CreateBoardFormRequest
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if err := validateForm(req.Definition); err != nil {
		return err
	}
	data, err := protojson.Marshal(req.Definition)
	if err != nil {
		return err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	var row sqlc.BoardForm
	err = s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		b, err := q.GetBoardForUpdate(r.Context(), id)
		if err != nil {
			return err
		}
		if err := formManager(r.Context(), q, id, uid(r)); err != nil {
			return err
		}
		l, err := s.formPlan(r.Context(), b.WorkspaceID)
		if err != nil {
			return err
		}
		n, err := q.CountBoardForms(r.Context(), id)
		if err != nil {
			return err
		}
		if l.BoardFormsPerBoard > 0 && n >= int64(l.BoardFormsPerBoard) {
			return httpx.Conflict("board form limit reached").WithDetails(httpx.ReasonPlanLimit, uint64(max(n, 0)), uint64(l.BoardFormsPerBoard))
		} //nolint:gosec // count is nonnegative
		if err := validateFormTarget(r.Context(), q, b, req.Definition); err != nil {
			return err
		}
		me := uid(r)
		row, err = q.InsertBoardForm(r.Context(), sqlc.InsertBoardFormParams{BoardID: id, Code: base64.RawURLEncoding.EncodeToString(secret), Definition: data, CreatedBy: &me})
		return err
	})
	if err != nil {
		return err
	}
	return s.respondForm(w, row, http.StatusCreated)
}

func (s *Service) updateForm(w http.ResponseWriter, r *http.Request) error {
	id, _, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	fid, err := httpx.PathUUID(r, "fid", "form")
	if err != nil {
		return err
	}
	var req v1.UpdateBoardFormRequest
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if err := validateForm(req.Definition); err != nil {
		return err
	}
	if req.Revision == 0 || req.Revision >= 2147483647 {
		return httpx.Validation("revision", "invalid revision")
	}
	data, err := protojson.Marshal(req.Definition)
	if err != nil {
		return err
	}
	var row sqlc.BoardForm
	err = s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		b, err := q.GetBoardForUpdate(r.Context(), id)
		if err != nil {
			return err
		}
		if err := formManager(r.Context(), q, id, uid(r)); err != nil {
			return err
		}
		if _, err := s.formPlan(r.Context(), b.WorkspaceID); err != nil {
			return err
		}
		if err := validateFormTarget(r.Context(), q, b, req.Definition); err != nil {
			return err
		}
		if _, err := q.GetBoardForm(r.Context(), sqlc.GetBoardFormParams{ID: fid, BoardID: id}); err != nil {
			if db.IsNotFound(err) {
				return httpx.NotFound("form")
			}
			return err
		}
		row, err = q.UpdateBoardForm(r.Context(), sqlc.UpdateBoardFormParams{ID: fid, BoardID: id, Definition: data, Revision: int32(req.Revision)}) //nolint:gosec // checked above
		if db.IsNotFound(err) {
			return httpx.Conflict("form changed").WithDetails("FORM_CHANGED", 0, 0)
		}
		return err
	})
	if err != nil {
		return err
	}
	return s.respondForm(w, row, http.StatusOK)
}

func (s *Service) respondForm(w http.ResponseWriter, row sqlc.BoardForm, status int) error {
	f, err := s.formProto(row)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.Write(w, status, &v1.BoardFormResponse{Form: f})
	return nil
}

func (s *Service) deleteForm(w http.ResponseWriter, r *http.Request) error {
	id, _, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	fid, err := httpx.PathUUID(r, "fid", "form")
	if err != nil {
		return err
	}
	err = s.tx(r.Context(), func(q *sqlc.Queries, _ pgx.Tx) error {
		if _, err := q.GetBoardForUpdate(r.Context(), id); err != nil {
			return err
		}
		if err := formManager(r.Context(), q, id, uid(r)); err != nil {
			return err
		}
		n, err := q.DeleteBoardForm(r.Context(), sqlc.DeleteBoardFormParams{ID: fid, BoardID: id})
		if err == nil && n == 0 {
			return httpx.NotFound("form")
		}
		return err
	})
	if err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *Service) previewForm(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := manageBoard(r, false)
	if err != nil {
		return err
	}
	if _, err := s.formPlan(r.Context(), acc.WorkspaceID); err != nil {
		return err
	}
	var req v1.PreviewBoardFormRequest
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	if err := validateForm(req.Definition); err != nil {
		return err
	}
	b, err := s.db.Q.GetBoard(r.Context(), id)
	if err != nil {
		return err
	}
	if err := validateFormTarget(r.Context(), s.db.Q, b, req.Definition); err != nil {
		return err
	}
	if _, _, err := formAnswers(req.Definition, req.Answers); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.FormSubmissionResponse{Preview: true})
	return nil
}
