package boards

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
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
	// Management settings (targets, maps, roles, routes) never leave; PEOPLE fields and the
	// names of members only when the filler may see them (ADR-0064 v2 §3).
	fields := publicFields(d, hiddenPeople(d, anonymousForm(r)))
	people, err := peopleOptions(r.Context(), s.db.Q, b.WorkspaceID, fields, d)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.PublicBoardFormResponse{Title: d.Title, Description: d.Description, Fields: fields, Revision: uint32(row.Revision), People: people}) //nolint:gosec // positive revision
	return nil
}

// uploadToken is the capability of a staged upload and the hash stored for it.
func uploadToken() (string, []byte, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	h := sha256.Sum256([]byte(token))
	return token, h[:], nil
}

// uploadFormFile: POST /api/(public/)forms/{code}/files?field= — a staged upload of a FILE field
// (ADR-0064 v2 §2): the same access as the form, the workspace quota, no uploader; the
// returned upload id is the answer value and the only way to the file until it is submitted.
func (s *Service) uploadFormFile(w http.ResponseWriter, r *http.Request) error {
	w.Header().Set("Cache-Control", "no-store")
	if s.files == nil {
		return httpx.NotFound("route")
	}
	if s.FormUploadLimit != nil {
		key := "ip:" + httpx.ClientIP(r.Context())
		if !anonymousForm(r) {
			key = "user:" + uid(r).String()
		}
		if err := s.FormUploadLimit.Take(r.Context(), key); err != nil {
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
	if s.FormUploadFormLimit != nil {
		if err := s.FormUploadFormLimit.Take(r.Context(), row.ID.String()); err != nil {
			return err
		}
	}
	b, err := s.db.Q.GetBoard(r.Context(), row.BoardID)
	if err != nil {
		return formLookupError(err)
	}
	d, err := s.formAccess(r, s.db.Q, row, b)
	if err != nil {
		return err
	}
	var field *v1.BoardFormField
	for _, f := range d.Fields {
		if f.Id == r.URL.Query().Get("field") && f.Type == ftFile {
			field = f
		}
	}
	if field == nil {
		return httpx.Validation("field", "a file field of the form is required")
	}
	if err := s.plans.CheckActive(r.Context(), b.WorkspaceID, plans.RestrictedCreate); err != nil {
		return err
	}
	pending, err := s.db.Q.BoardFormPendingBytes(r.Context(), row.ID)
	if err != nil {
		return err
	}
	if pending+max(r.ContentLength, 0) > maxFormPendingFile {
		return httpx.Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_FILE_QUOTA_EXCEEDED, "too many files of this form wait for their submission")
	}
	token, hash, err := uploadToken()
	if err != nil {
		return err
	}
	var actor *uuid.UUID
	if !anonymousForm(r) {
		me := uid(r)
		actor = &me
	}
	fieldID := uuid.MustParse(field.Id)
	f, err := s.files.UploadStaged(w, r, b.WorkspaceID, formFileBytes(field), func(mime, name string) error {
		if !formFileAllowed(mime, name, field.Accept) {
			return httpx.Validation(field.Id, "this file type is not accepted")
		}
		return nil
	}, func(q *sqlc.Queries, f sqlc.File) error {
		return q.InsertBoardFormUpload(r.Context(), sqlc.InsertBoardFormUploadParams{FileID: f.ID, FormID: row.ID, FieldID: fieldID, TokenHash: hash, ActorID: actor, Size: f.Size})
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.BoardFormUploadResponse{UploadId: token, Name: f.Name, Size: uint64(max(f.Size, 0)), Mime: f.Mime})
	return nil
}

// stagedResolver resolves the upload ids of FILE answers to staged uploads of this form, field
// and actor (an anonymous upload only for an anonymous submission), locking them; the file ids
// go to out in answer order.
func stagedResolver(ctx context.Context, q *sqlc.Queries, formID uuid.UUID, actor *uuid.UUID, out *[]uuid.UUID) func(f *v1.BoardFormField, values []string) ([]string, error) {
	return func(f *v1.BoardFormField, values []string) ([]string, error) {
		hashes := make([][]byte, len(values))
		for i, v := range values {
			h := sha256.Sum256([]byte(v))
			hashes[i] = h[:]
		}
		rows, err := q.GetBoardFormUploads(ctx, hashes)
		if err != nil {
			return nil, err
		}
		names := make([]string, len(values))
		for i, h := range hashes {
			j := slices.IndexFunc(rows, func(u sqlc.GetBoardFormUploadsRow) bool { return bytes.Equal(u.TokenHash, h) })
			if j < 0 {
				return nil, httpx.Validation(f.Id, "the upload expired or is unknown; attach the file again")
			}
			u := rows[j]
			sameActor := (u.ActorID == nil && actor == nil) || (u.ActorID != nil && actor != nil && *u.ActorID == *actor)
			if u.FormID != formID || u.FieldID.String() != f.Id || !sameActor {
				return nil, httpx.Validation(f.Id, "the upload expired or is unknown; attach the file again")
			}
			*out = append(*out, u.FileID)
			names[i] = u.FileName
		}
		return names, nil
	}
}

// fieldOf is the field mapped onto target (for errors on it).
func fieldOf(d *v1.BoardFormDefinition, target fieldTarget) string {
	for _, f := range d.Fields {
		if f.Target == target {
			return f.Id
		}
	}
	return "answers"
}

// onField moves a 422 of a task helper onto the form field it came from.
func onField(err error, field string) error {
	var e *httpx.Error
	if errors.As(err, &e) && e.Status == http.StatusUnprocessableEntity {
		return httpx.Validation(field, e.Message)
	}
	return err
}

// labelsOn maps labels of the form's board onto board tb: the same ids on the form's board
// (deleted ones skipped), labels of the same name elsewhere (missing ones skipped).
func labelsOn(ctx context.Context, q *sqlc.Queries, formBoard, tb uuid.UUID, ids []uuid.UUID) ([]uuid.UUID, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	ls, err := q.ListBoardLabels(ctx, []uuid.UUID{formBoard, tb})
	if err != nil {
		return nil, err
	}
	var out []uuid.UUID
	for _, id := range ids {
		i := slices.IndexFunc(ls, func(l sqlc.BoardLabel) bool { return l.ID == id && l.BoardID == formBoard })
		if i < 0 {
			continue
		}
		j := slices.IndexFunc(ls, func(l sqlc.BoardLabel) bool { return l.BoardID == tb && (l.ID == id || l.Name == ls[i].Name) })
		if j >= 0 && !slices.Contains(out, ls[j].ID) {
			out = append(out, ls[j].ID)
		}
	}
	return out, nil
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
	actorID := uuid.Nil // notices: no actor for an anonymous submission
	if !anonymousForm(r) {
		me := uid(r)
		actor, actorID = &me, me
	}
	// Canonical answer order makes harmless JSON ordering changes idempotent. The answers
	// themselves keep their order: the first person is the lead, files keep their positions.
	answers := req.Answers
	canonical := make([]*v1.BoardFormAnswer, len(answers))
	for i, a := range answers {
		if a == nil {
			return httpx.Validation("answers", "answer required")
		}
		canonical[i] = &v1.BoardFormAnswer{FieldId: a.FieldId, Value: a.Value, Values: slices.Sorted(slices.Values(a.Values))}
	}
	slices.SortFunc(canonical, func(a, b *v1.BoardFormAnswer) int { return strings.Compare(a.FieldId, b.FieldId) })
	payload, err := json.Marshal(struct {
		Revision uint32
		Actor    *uuid.UUID
		Answers  []*v1.BoardFormAnswer
	}{req.Revision, actor, canonical})
	if err != nil {
		return err
	}
	hash := sha256.Sum256(payload)
	// The route of the request picks a second board: lock both in id order so that forms
	// routing to each other's boards cannot deadlock (ADR-0064 v2 §1).
	lockIDs := []uuid.UUID{initial.BoardID}
	if pre, err := formDefinition(initial); err == nil {
		if rt := routeOf(pre, answers); rt != nil {
			if id, err := uuid.Parse(rt.BoardId); err == nil && id != initial.BoardID {
				lockIDs = append(lockIDs, id)
			}
		}
	}
	slices.SortFunc(lockIDs, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
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
		locked := map[uuid.UUID]sqlc.Board{}
		for _, id := range lockIDs {
			lb, err := q.GetBoardForUpdate(r.Context(), id)
			if db.IsNotFound(err) && id != initial.BoardID {
				continue // a deleted target: unavailable below
			}
			if err != nil {
				return err
			}
			locked[id] = lb
		}
		b := locked[initial.BoardID]
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
		var fileIDs []uuid.UUID
		res, err := parseAnswers(d, answers, answerOpts{
			hidden: hiddenPeople(d, anonymousForm(r)),
			people: peopleResolver(r.Context(), q, b.WorkspaceID),
			files:  stagedResolver(r.Context(), q, row.ID, actor, &fileIDs),
		})
		if err != nil {
			return err
		}
		// A submission is a new task: refused in the restricted mode (ADR-0086 amendment),
		// public forms included.
		if err := s.plans.CheckActive(r.Context(), b.WorkspaceID, plans.RestrictedCreate); err != nil {
			return err
		}
		priority := d.Priority
		if res.priority != nil {
			priority = *res.priority
		}
		uses := formUses{priority: priority != v1.TaskPriority_TASK_PRIORITY_NONE, due: res.due != "", labels: len(res.labels) > 0,
			files: len(fileIDs) > 0, approvers: len(res.approvers) > 0}
		// Where the task goes: the first matching route, else the form's board and status.
		// ACL members may have left since the definition was saved: only the caller is
		// checked by formAccess. Other departed recipients do not block this submission.
		tb := b
		var st sqlc.BoardStatus
		if rt := routeOf(d, answers); rt != nil {
			id, _ := uuid.Parse(rt.BoardId)
			if id != b.ID {
				lb, ok := locked[id]
				if !ok {
					if !slices.Contains(lockIDs, id) {
						return httpx.Conflict("form changed").WithDetails("FORM_CHANGED", 0, 0)
					}
					return targetUnavailable()
				}
				tb = lb
			}
			if st, err = routeTarget(r.Context(), q, b, tb, rt, row.UpdatedBy, uses); err != nil {
				return err
			}
		} else {
			if err := validateFormTarget(r.Context(), q, b, &v1.BoardFormDefinition{StatusId: d.StatusId, Priority: priority}); err != nil {
				return err
			}
			if err := requireUses(b, uses); err != nil {
				return err
			}
			statuses, err := q.ListBoardStatuses(r.Context(), []uuid.UUID{b.ID})
			if err != nil {
				return err
			}
			for _, x := range statuses {
				if x.ID.String() == d.StatusId {
					st = x
				}
			}
		}
		n, err := q.CountLiveTasks(r.Context(), tb.ID)
		if err != nil {
			return err
		}
		if n >= MaxTasks {
			return httpx.Conflict("board task limit reached").WithDetails(ReasonBoardTaskLimit, uint64(n), MaxTasks)
		} //nolint:gosec // count nonnegative
		labels, err := labelsOn(r.Context(), q, b.ID, tb.ID, res.labels)
		if err != nil {
			return err
		}
		inputs := make([]*v1.TaskAssigneeInput, len(res.assignees))
		for i, u := range res.assignees {
			inputs[i] = &v1.TaskAssigneeInput{UserId: u.String()}
		}
		if inputs, err = assigneesIn(r.Context(), q, tb.ID, inputs); err != nil {
			return onField(err, fieldOf(d, toAssignees))
		}
		approverIDs := make([]string, len(res.approvers))
		for i, u := range res.approvers {
			approverIDs[i] = u.String()
		}
		approvers, _, err := approversIn(r.Context(), q, tb.ID, approverIDs, 0, "approverIds", "approvalRequired")
		if err != nil {
			return onField(err, fieldOf(d, toApprovers))
		}
		if err := checkCreateGate(len(approvers), 0, st, tb.ApprovalGateOff); err != nil {
			return err
		}
		resolver := perm.NewResolver(q)
		for _, u := range res.watchers {
			ok, err := mayMention(r.Context(), q, resolver, tb.ID, u)
			if err != nil {
				return err
			}
			if !ok {
				return httpx.Validation(fieldOf(d, toWatchers), "the user cannot watch tasks of this board")
			}
		}
		due, _ := ParseDate(res.due)
		prio, err := validPriority(priority)
		if err != nil {
			return err
		}
		number, err := q.NextTaskNumber(r.Context(), tb.ID)
		if err != nil {
			return err
		}
		room, err := q.CreateTaskRoom(r.Context(), sqlc.CreateTaskRoomParams{WorkspaceID: &tb.WorkspaceID, Name: TaskKey(tb.Key, number)})
		if err != nil {
			return err
		}
		pos, err := place(r.Context(), q, st.ID, uuid.Nil, nil, nil)
		if err != nil {
			return err
		}
		t := taskRow{BoardID: tb.ID, WorkspaceID: tb.WorkspaceID, BoardKey: tb.Key, Number: number, Title: res.title, Description: res.description,
			StatusID: st.ID, Priority: prio, CreatedBy: actor, RoomID: room, Position: pos, DueOn: due}
		now := s.Now()
		if st.Type == "started" {
			t.StartedAt = &now
		}
		if st.Type == "completed" || st.Type == "cancelled" {
			t.CompletedAt, t.CompletedBy = &now, actor
		}
		taskID, err = q.InsertTask(r.Context(), sqlc.InsertTaskParams{BoardID: tb.ID, Number: number, Title: t.Title, Description: t.Description, StatusID: st.ID,
			Priority: t.Priority, CreatedBy: actor, RoomID: room, Position: pos, DueOn: due, StartedAt: t.StartedAt, CompletedAt: t.CompletedAt, CompletedBy: t.CompletedBy})
		if err != nil {
			return err
		}
		t.ID = taskID
		for _, u := range approvers {
			if err := q.InsertTaskApprover(r.Context(), sqlc.InsertTaskApproverParams{TaskID: taskID, UserID: u, AddedBy: actor}); err != nil {
				return err
			}
		}
		if len(labels) > 0 {
			if err := q.InsertTaskLabels(r.Context(), sqlc.InsertTaskLabelsParams{TaskID: taskID, LabelIds: labels}); err != nil {
				return err
			}
		}
		if len(fileIDs) > 0 {
			if err := q.DeleteBoardFormUploads(r.Context(), fileIDs); err != nil {
				return err
			}
			for i, id := range fileIDs {
				if err := q.InsertTaskAttachment(r.Context(), sqlc.InsertTaskAttachmentParams{TaskID: taskID, FileID: id, Position: int16(i)}); err != nil { //nolint:gosec // ≤ 20
					return err
				}
			}
		}
		fresh, _, err := writeAssignees(r.Context(), q, taskID, inputs, actor, now)
		if err != nil {
			return err
		}
		if len(res.watchers) > 0 {
			if err := q.AddTaskWatchers(r.Context(), sqlc.AddTaskWatchersParams{TaskID: taskID, UserIds: res.watchers}); err != nil {
				return err
			}
		}
		created := map[string]any{"title": t.Title, "status_id": st.ID.String(), "priority": int(prio), "form_id": row.ID.String(), "form_title": d.Title}
		if len(inputs) > 0 {
			created["assignees"] = inputsJSON(inputs)
		}
		if len(labels) > 0 {
			created["label_ids"] = idsJSON(labels)
		}
		if len(approvers) > 0 {
			created["approvers"], created["approval_required"] = idsJSON(approvers), 0
		}
		if len(res.watchers) > 0 {
			created["watchers"] = idsJSON(res.watchers)
		}
		if res.due != "" {
			created["due_on"] = res.due
		}
		after, err := json.Marshal(created)
		if err != nil {
			return err
		}
		act, err := q.InsertTaskActivity(r.Context(), sqlc.InsertTaskActivityParams{TaskID: taskID, BoardID: tb.ID, ActorID: actor, Kind: "created", After: after})
		if err != nil {
			return err
		}
		c.acts = append(c.acts, act)
		c.journal = append(c.journal, journalEntry{task: taskID, board: tb.ID, row: &act})
		// The people the answers named hear of it like from a created task; the filler is
		// neither subscribed nor given access (ADR-0064).
		if err := s.notifyApprovers(r.Context(), q, t, actorID, approvers, &c); err != nil {
			return err
		}
		if err := s.notifyDirect(r.Context(), q, t, actorID, fresh, nil, uuid.Nil, &c); err != nil {
			return err
		}
		if err := s.notifyAddressed(r.Context(), q, t, actorID, notifications.TaskWatcherAdded, res.watchers, nil, &c); err != nil {
			return err
		}
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
