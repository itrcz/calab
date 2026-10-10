package boards

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"slices"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func anonymousForm(r *http.Request) bool { return strings.HasPrefix(r.URL.Path, "/api/public/forms/") }

func (s *Service) formAccess(r *http.Request, q *sqlc.Queries, row sqlc.BoardForm, b sqlc.Board) (*v1.BoardFormDefinition, error) {
	if b.ArchivedAt != nil || Disabled(b.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_FORMS) {
		return nil, httpx.NotFound("form")
	}
	ws, err := q.GetWorkspace(r.Context(), b.WorkspaceID)
	if err != nil {
		return nil, err
	}
	if ws.SuspendedAt != nil {
		return nil, moderation.ErrSuspended
	}
	// A workspace suspended for unpaid billing takes no submissions either (public ones included).
	if err := s.plans.CheckBillingOpen(r.Context(), q, b.WorkspaceID); err != nil {
		return nil, err
	}
	d, err := formDefinition(row)
	if err != nil {
		return nil, err
	}
	if anonymousForm(r) {
		if d.IsPrivate {
			return nil, httpx.Unauthenticated("sign in to open this form")
		}
		if err := auth.CheckPublicCapability(r.Context(), q, b.WorkspaceID); err != nil {
			return nil, err
		}
	} else {
		me := uid(r)
		if d.IsPrivate && !slices.Contains(d.AllowedUserIds, me.String()) {
			return nil, httpx.NotFound("form")
		}
		if _, err := q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: b.WorkspaceID, UserID: me}); err != nil {
			if db.IsNotFound(err) {
				return nil, httpx.NotFound("form")
			}
			return nil, err
		}
		u, err := q.GetUser(r.Context(), me)
		if err != nil {
			return nil, err
		}
		if u.DisabledAt != nil {
			return nil, httpx.NotFound("form")
		}
	}
	if _, err := s.formPlan(r.Context(), b.WorkspaceID); err != nil {
		return nil, err
	}
	return d, nil
}

func (s *Service) publicForm(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Cache-Control", "no-store")
	if s.FormReadLimit != nil {
		if err := s.FormReadLimit.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
			return err
		}
	}
	row, err := s.db.Q.GetBoardFormByCode(r.Context(), r.PathValue("code"))
	if db.IsNotFound(err) {
		return httpx.NotFound("form")
	}
	if err != nil {
		return err
	}
	b, err := s.db.Q.GetBoard(r.Context(), row.BoardID)
	if err != nil {
		return formLookupError(err)
	}
	d, err := s.formAccess(r, s.db.Q, row, b)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.PublicBoardFormResponse{Title: d.Title, Description: d.Description, Fields: d.Fields, Revision: uint32(row.Revision)}) //nolint:gosec // positive revision
	return nil
}

func (s *Service) submitForm(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Cache-Control", "no-store")
	if anonymousForm(r) {
		if s.FormIPLimit != nil {
			if err := s.FormIPLimit.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
				return err
			}
		}
	} else if err := take(r, s.FormUserLimit); err != nil {
		return err
	}
	var req v1.SubmitBoardFormRequest
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	if err := httpx.DecodeStrict(w, r, &req); err != nil {
		return err
	}
	nonce, err := uuid.Parse(req.Nonce)
	if err != nil || nonce == uuid.Nil {
		return httpx.Validation("nonce", "UUID required")
	}
	initial, err := s.db.Q.GetBoardFormByCode(r.Context(), r.PathValue("code"))
	if db.IsNotFound(err) {
		return httpx.NotFound("form")
	}
	if err != nil {
		return err
	}
	if s.FormSubmitLimit != nil {
		if err := s.FormSubmitLimit.Take(r.Context(), initial.ID.String()); err != nil {
			return err
		}
	}
	var actor *uuid.UUID
	if !anonymousForm(r) {
		me := uid(r)
		actor = &me
	}
	// Canonical answer order makes harmless JSON ordering changes idempotent.
	answers := append([]*v1.BoardFormAnswer(nil), req.Answers...)
	for _, a := range answers {
		if a == nil {
			return httpx.Validation("answers", "answer required")
		}
		slices.Sort(a.Values) // multiple choices are an unordered set for idempotency
	}
	slices.SortFunc(answers, func(a, b *v1.BoardFormAnswer) int { return strings.Compare(a.FieldId, b.FieldId) })
	payload, err := json.Marshal(struct {
		Revision uint32
		Actor    *uuid.UUID
		Answers  []*v1.BoardFormAnswer
	}{req.Revision, actor, answers})
	if err != nil {
		return err
	}
	hash := sha256.Sum256(payload)
	var receipt, taskID uuid.UUID
	repeated := false
	var c change
	err = s.taskTx(r.Context(), &c, func(q *sqlc.Queries, _ pgx.Tx) error {
		// Public writes have no user admission. Take the same workspace source lock before
		// the board lock so policy/suspension changes cannot race the capability check.
		if anonymousForm(r) {
			b, err := q.GetBoard(r.Context(), initial.BoardID)
			if err != nil {
				return err
			}
			if _, err := q.LockIdentityWorkspaceShared(r.Context(), b.WorkspaceID); err != nil {
				return err
			}
		}
		b, err := q.GetBoardForUpdate(r.Context(), initial.BoardID)
		if err != nil {
			return err
		}
		row, err := q.GetBoardForm(r.Context(), sqlc.GetBoardFormParams{ID: initial.ID, BoardID: b.ID})
		if db.IsNotFound(err) {
			return httpx.NotFound("form")
		}
		if err != nil {
			return err
		}
		d, err := s.formAccess(r, q, row, b)
		if err != nil {
			return err
		}
		old, err := q.GetBoardFormSubmission(r.Context(), sqlc.GetBoardFormSubmissionParams{FormID: row.ID, Nonce: nonce})
		if err == nil {
			if !bytes.Equal(old.RequestHash, hash[:]) {
				return httpx.Conflict("nonce already used").WithDetails("NONCE_CONFLICT", 0, 0)
			}
			receipt, repeated = old.ID, true
			return nil
		}
		if !db.IsNotFound(err) {
			return err
		}
		if int64(req.Revision) != int64(row.Revision) {
			return httpx.Conflict("form changed").WithDetails("FORM_CHANGED", 0, 0)
		} //nolint:gosec // positive revision
		title, description, err := formAnswers(d, answers)
		if err != nil {
			return err
		}
		// A submission is a new task: refused in the restricted mode (ADR-0086 amendment),
		// public forms included.
		if err := s.plans.CheckActive(r.Context(), b.WorkspaceID, plans.RestrictedCreate); err != nil {
			return err
		}
		// ACL members may have left since the definition was saved: only the caller is
		// checked by formAccess. Other departed recipients do not block this submission.
		target := &v1.BoardFormDefinition{StatusId: d.StatusId, Priority: d.Priority}
		if err := validateFormTarget(r.Context(), q, b, target); err != nil {
			return err
		}
		n, err := q.CountLiveTasks(r.Context(), b.ID)
		if err != nil {
			return err
		}
		if n >= MaxTasks {
			return httpx.Conflict("board task limit reached").WithDetails(ReasonBoardTaskLimit, uint64(n), MaxTasks)
		} //nolint:gosec // count nonnegative
		number, err := q.NextTaskNumber(r.Context(), b.ID)
		if err != nil {
			return err
		}
		room, err := q.CreateTaskRoom(r.Context(), sqlc.CreateTaskRoomParams{WorkspaceID: &b.WorkspaceID, Name: TaskKey(b.Key, number)})
		if err != nil {
			return err
		}
		status, _ := uuid.Parse(d.StatusId)
		pos, err := place(r.Context(), q, status, uuid.Nil, nil, nil)
		if err != nil {
			return err
		}
		statuses, err := q.ListBoardStatuses(r.Context(), []uuid.UUID{b.ID})
		if err != nil {
			return err
		}
		priority, err := validPriority(d.Priority)
		if err != nil {
			return err
		}
		t := taskRow{BoardID: b.ID, WorkspaceID: b.WorkspaceID, Number: number, Title: title, Description: description, StatusID: status, Priority: priority, CreatedBy: actor, RoomID: room, Position: pos}
		for _, st := range statuses {
			if st.ID == status {
				now := s.Now()
				if st.Type == "started" {
					t.StartedAt = &now
				}
				if st.Type == "completed" || st.Type == "cancelled" {
					t.CompletedAt, t.CompletedBy = &now, actor
				}
			}
		}
		taskID, err = q.InsertTask(r.Context(), sqlc.InsertTaskParams{BoardID: b.ID, Number: number, Title: title, Description: description, StatusID: status, Priority: t.Priority, CreatedBy: actor, RoomID: room, Position: pos, StartedAt: t.StartedAt, CompletedAt: t.CompletedAt, CompletedBy: t.CompletedBy})
		if err != nil {
			return err
		}
		after, err := json.Marshal(map[string]any{"title": title, "status_id": d.StatusId, "priority": int(d.Priority), "form_id": row.ID.String(), "form_title": d.Title})
		if err != nil {
			return err
		}
		act, err := q.InsertTaskActivity(r.Context(), sqlc.InsertTaskActivityParams{TaskID: taskID, BoardID: b.ID, ActorID: actor, Kind: "created", After: after})
		if err != nil {
			return err
		}
		c.acts = append(c.acts, act)
		c.journal = append(c.journal, journalEntry{task: taskID, board: b.ID, row: &act})
		saved, err := q.InsertBoardFormSubmission(r.Context(), sqlc.InsertBoardFormSubmissionParams{FormID: row.ID, Nonce: nonce, RequestHash: hash[:], ActorID: actor, TaskID: &taskID})
		receipt = saved.ID
		return err
	})
	if err != nil {
		return formLookupError(err)
	}
	status := http.StatusCreated
	if repeated {
		status = http.StatusOK
	} else {
		s.publish(r.Context(), taskID, &c, true)
	}
	httpx.Write(w, status, &v1.FormSubmissionResponse{ReceiptId: receipt.String()})
	return nil
}

func formLookupError(err error) error {
	if db.IsNotFound(err) {
		return httpx.NotFound("form")
	}
	return err
}
