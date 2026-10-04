package boards

import (
	"context"
	"errors"
	"math"
	"net/http"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// Task checklists (ADR-0058 §2): named checklists of a task with items. Rights are those of the
// task's fields (requireEdit); the board feature CHECKLISTS and the plan (Team and above) gate
// writes; every write is a transaction under the task row lock, journals a "checklist" entry and
// sends TASK_CHECKLIST_UPDATE / _DELETE (never TASK_UPDATE: the counters travel in the event).

// Limits and reasons of task checklists.
const (
	MaxChecklists     = 10  // per task
	MaxChecklistItems = 100 // per checklist
	MaxChecklistTitle = 100
	MaxChecklistText  = 500

	ReasonChecklistLimit     = "CHECKLIST_LIMIT"
	ReasonChecklistItemLimit = "CHECKLIST_ITEM_LIMIT"
)

// checklistGate refuses a write: the plan has no checklists (every write incl. delete: read-only),
// or the board feature CHECKLISTS is off (requireFeature; deleting stays allowed).
func (s *Service) checklistGate(ctx context.Context, t taskRow, disabled int64, deleting bool) error {
	if s.plans != nil {
		lim, err := s.plans.Effective(ctx, t.WorkspaceID)
		if err != nil {
			return err
		}
		if lim.ChecklistsDisabled {
			return plans.FeatureError("checklists")
		}
	}
	return requireFeature(disabled, v1.BoardFeature_BOARD_FEATURE_CHECKLISTS, "checklists", !deleting)
}

// ---- proto ----

func checklistItemProto(i sqlc.TaskChecklistItem) *v1.TaskChecklistItem {
	return &v1.TaskChecklistItem{Id: i.ID.String(), ChecklistId: i.ChecklistID.String(), TaskId: i.TaskID.String(),
		Text: i.Text, Done: i.Done, DoneBy: idp(i.DoneBy), DoneAt: tsp(i.DoneAt), Position: i.Position,
		CreatedBy: idp(i.CreatedBy), CreatedAt: timestamppb.New(i.CreatedAt)}
}

func checklistProto(c sqlc.TaskChecklist, items []sqlc.TaskChecklistItem) *v1.TaskChecklist {
	out := &v1.TaskChecklist{Id: c.ID.String(), TaskId: c.TaskID.String(), Title: c.Title, Position: c.Position,
		Items: make([]*v1.TaskChecklistItem, len(items)), CreatedBy: idp(c.CreatedBy), CreatedAt: timestamppb.New(c.CreatedAt)}
	for i, it := range items {
		out.Items[i] = checklistItemProto(it)
	}
	return out
}

// loadChecklist reads a checklist with its items.
func loadChecklist(ctx context.Context, q *sqlc.Queries, id uuid.UUID) (*v1.TaskChecklist, error) {
	c, err := q.GetTaskChecklist(ctx, id)
	if err != nil {
		return nil, err
	}
	items, err := q.ListChecklistItems(ctx, id)
	if err != nil {
		return nil, err
	}
	return checklistProto(c, items), nil
}

// taskChecklists is GET /tasks/{id}'s Task.checklists: every checklist with its items.
func taskChecklists(ctx context.Context, q *sqlc.Queries, taskID uuid.UUID) ([]*v1.TaskChecklist, error) {
	cs, err := q.ListTaskChecklists(ctx, taskID)
	if err != nil || len(cs) == 0 {
		return nil, err
	}
	items, err := q.ListTaskChecklistItems(ctx, taskID)
	if err != nil {
		return nil, err
	}
	by := map[uuid.UUID][]sqlc.TaskChecklistItem{}
	for _, it := range items {
		by[it.ChecklistID] = append(by[it.ChecklistID], it)
	}
	out := make([]*v1.TaskChecklist, len(cs))
	for i, c := range cs {
		out[i] = checklistProto(c, by[c.ID])
	}
	return out, nil
}

// ---- transaction frame ----

// clOut is what a checklist write produced: the changed checklists (events + response), the
// deleted one, the counters, and (convert) the new subtask.
type clOut struct {
	status  int
	main    *v1.TaskChecklist   // the response checklist (nil after DELETE of a checklist)
	updated []*v1.TaskChecklist // TASK_CHECKLIST_UPDATE for each
	deleted string              // TASK_CHECKLIST_DELETE
	total   uint32
	done    uint32
	subtask uuid.UUID // convert: the new task
	t       taskRow
	c       change
	// disabled: the board's switched-off features (BoardAccess.DisabledFeatures); bits: the
	// caller's rights on the board.
	disabled int64
	bits     perm.Bits
	scoped   bool // the bits come from the task (ADR-0059), not from the board
}

// write runs a checklist mutation: resolve finds the task of the path object, then the task row
// is locked, the caller must be able to edit it and the plan / feature gates pass. The journal
// entries go to the board webhook outbox in the same transaction (taskTx).
func (s *Service) write(w http.ResponseWriter, r *http.Request, deleting bool,
	resolve func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error),
	fn func(q *sqlc.Queries, tx pgx.Tx, t taskRow, o *clOut) error) error {
	me := uid(r)
	var o clOut
	err := s.taskTx(r.Context(), &o.c, func(q *sqlc.Queries, tx pgx.Tx) error {
		taskID, err := resolve(r.Context(), q)
		if err != nil {
			return err
		}
		t, acc, err := s.taskAccess(r, tx, taskID, true)
		if err != nil {
			return err
		}
		if err := requireEdit(r.Context(), q, acc, t, me); err != nil {
			return err
		}
		if t.ArchivedAt != nil {
			return httpx.Conflict("the task is archived; restore it first")
		}
		if err := s.checklistGate(r.Context(), t, acc.DisabledFeatures, deleting); err != nil {
			return err
		}
		o.t, o.disabled, o.bits, o.scoped = t, acc.DisabledFeatures, acc.Bits, acc.TaskScoped
		if err := fn(q, tx, t, &o); err != nil {
			return err
		}
		if err := q.TouchTask(r.Context(), t.ID); err != nil {
			return err
		}
		cnt, err := q.TaskChecklistCounts(r.Context(), t.ID)
		if err != nil {
			return err
		}
		o.total, o.done = uint32(max(cnt.Total, 0)), uint32(max(cnt.Done, 0)) //nolint:gosec // counts
		return nil
	})
	if err != nil {
		return err
	}
	s.publishChecklist(r.Context(), &o)
	if o.subtask != uuid.Nil {
		s.publish(r.Context(), o.subtask, &o.c, true)
	}
	resp := &v1.TaskChecklistResponse{Checklist: o.main, ChecklistTotal: o.total, ChecklistDone: o.done}
	if o.subtask != uuid.Nil {
		sub, err := s.taskResponse(r, o.subtask, false)
		if err != nil {
			return err
		}
		httpx.Write(w, http.StatusCreated, &v1.ConvertChecklistItemResponse{Task: sub.GetTask(), Checklist: o.main,
			ChecklistTotal: o.total, ChecklistDone: o.done})
		return nil
	}
	httpx.Write(w, o.status, resp)
	return nil
}

// publishChecklist sends the checklist events to the board's viewers (gateway routing) and the
// journal entries (TASK_ACTIVITY); a subtask conversion publishes its entries with the task.
func (s *Service) publishChecklist(ctx context.Context, o *clOut) {
	t := o.t
	for _, c := range o.updated {
		s.ev.Workspace(ctx, t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskChecklistUpdate{TaskChecklistUpdate: &v1.TaskChecklistUpdate{
			WorkspaceId: t.WorkspaceID.String(), BoardId: t.BoardID.String(), TaskId: t.ID.String(), Checklist: c,
			ChecklistTotal: o.total, ChecklistDone: o.done}}})
	}
	if o.deleted != "" {
		s.ev.Workspace(ctx, t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskChecklistDelete{TaskChecklistDelete: &v1.TaskChecklistDelete{
			WorkspaceId: t.WorkspaceID.String(), BoardId: t.BoardID.String(), TaskId: t.ID.String(), ChecklistId: o.deleted,
			ChecklistTotal: o.total, ChecklistDone: o.done}}})
	}
	if o.subtask != uuid.Nil {
		return
	}
	for _, a := range o.c.acts {
		s.ev.Workspace(ctx, t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskActivity{TaskActivity: &v1.TaskActivityAppend{
			WorkspaceId: t.WorkspaceID.String(), Activity: activity(a)}}})
	}
}

func notFoundOr(err error, what string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound(what)
	}
	return err
}

func checklistResolver(r *http.Request) (uuid.UUID, func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error), error) {
	id, err := httpx.PathUUID(r, "id", "checklist")
	if err != nil {
		return id, nil, err
	}
	return id, func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error) {
		c, err := q.GetTaskChecklist(ctx, id)
		return c.TaskID, notFoundOr(err, "checklist")
	}, nil
}

func itemResolver(r *http.Request) (uuid.UUID, func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error), error) {
	id, err := httpx.PathUUID(r, "id", "checklist item")
	if err != nil {
		return id, nil, err
	}
	return id, func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error) {
		i, err := q.GetChecklistItem(ctx, id)
		return i.TaskID, notFoundOr(err, "checklist item")
	}, nil
}

func validChecklistTitle(s string) (string, error) {
	return validText("title", s, 1, MaxChecklistTitle)
}

func validChecklistText(s string) (string, error) { return validText("text", s, 1, MaxChecklistText) }

func validItemPosition(p float64) error {
	if math.IsNaN(p) || math.IsInf(p, 0) || math.Abs(p) > 1e15 {
		return httpx.Validation("position", "invalid position")
	}
	return nil
}

// ---- checklists ----

func (s *Service) createChecklist(w http.ResponseWriter, r *http.Request) error {
	var req v1.CreateTaskChecklistRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	title, err := validChecklistTitle(req.GetTitle())
	if err != nil {
		return err
	}
	taskID, err := httpx.PathUUID(r, "id", "task")
	if err != nil {
		return err
	}
	me := uid(r)
	return s.write(w, r, false, func(context.Context, *sqlc.Queries) (uuid.UUID, error) { return taskID, nil },
		func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *clOut) error {
			ctx := r.Context()
			n, err := q.CountTaskChecklists(ctx, t.ID)
			if err != nil {
				return err
			}
			if n >= MaxChecklists {
				return httpx.Conflict("at most 10 checklists per task").WithDetails(ReasonChecklistLimit, uint64(max(n, 0)), MaxChecklists)
			}
			c, err := q.CreateTaskChecklist(ctx, sqlc.CreateTaskChecklistParams{TaskID: t.ID, Title: title, CreatedBy: &me})
			if err != nil {
				return err
			}
			if req.Position != nil {
				if err := reorderChecklists(ctx, q, t.ID, c.ID, int(req.GetPosition())); err != nil {
					return err
				}
			}
			if err := o.c.record(ctx, q, t, me, "checklist", nil, map[string]any{"checklist_id": c.ID.String(), "title": title, "action": "created"}); err != nil {
				return err
			}
			o.status = http.StatusCreated
			return o.fill(ctx, q, c.ID)
		})
}

// fill loads the checklist into the response / events.
func (o *clOut) fill(ctx context.Context, q *sqlc.Queries, id uuid.UUID) error {
	c, err := loadChecklist(ctx, q, id)
	if err != nil {
		return err
	}
	o.main = c
	o.updated = append(o.updated, c)
	return nil
}

// reorderChecklists puts the checklist at index idx among the task's (clamped), the others keep
// their order and shift; positions are renumbered 0..n-1.
func reorderChecklists(ctx context.Context, q *sqlc.Queries, taskID, id uuid.UUID, idx int) error {
	cs, err := q.ListTaskChecklists(ctx, taskID)
	if err != nil {
		return err
	}
	var self sqlc.TaskChecklist
	rest := make([]sqlc.TaskChecklist, 0, len(cs))
	for _, c := range cs {
		if c.ID == id {
			self = c
		} else {
			rest = append(rest, c)
		}
	}
	idx = min(max(idx, 0), len(rest))
	rest = slices.Insert(rest, idx, self)
	for i, c := range rest {
		if c.Position != int32(i) { //nolint:gosec // ≤ 10
			if err := q.SetTaskChecklistPosition(ctx, sqlc.SetTaskChecklistPositionParams{ID: c.ID, Position: int32(i)}); err != nil { //nolint:gosec // ≤ 10
				return err
			}
		}
	}
	return nil
}

func (s *Service) updateChecklist(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := checklistResolver(r)
	if err != nil {
		return err
	}
	var req v1.UpdateTaskChecklistRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var title *string
	if req.Title != nil {
		v, err := validChecklistTitle(req.GetTitle())
		if err != nil {
			return err
		}
		title = &v
	}
	me := uid(r)
	return s.write(w, r, false, resolve, func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *clOut) error {
		ctx := r.Context()
		old, err := q.GetTaskChecklistForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "checklist")
		}
		if title != nil && *title != old.Title {
			if _, err := q.UpdateTaskChecklist(ctx, sqlc.UpdateTaskChecklistParams{ID: id, Title: title}); err != nil {
				return err
			}
			if err := o.c.record(ctx, q, t, me, "checklist", map[string]any{"checklist_id": id.String(), "title": old.Title},
				map[string]any{"checklist_id": id.String(), "title": *title, "action": "renamed"}); err != nil {
				return err
			}
		}
		if req.Position != nil && req.GetPosition() != old.Position {
			if err := reorderChecklists(ctx, q, t.ID, id, int(req.GetPosition())); err != nil {
				return err
			}
		}
		o.status = http.StatusOK
		return o.fill(ctx, q, id)
	})
}

func (s *Service) deleteChecklist(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := checklistResolver(r)
	if err != nil {
		return err
	}
	me := uid(r)
	return s.write(w, r, true, resolve, func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *clOut) error {
		ctx := r.Context()
		old, err := q.GetTaskChecklistForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "checklist")
		}
		if _, err := q.DeleteTaskChecklist(ctx, id); err != nil {
			return err
		}
		o.status, o.deleted = http.StatusOK, id.String()
		return o.c.record(ctx, q, t, me, "checklist", map[string]any{"checklist_id": id.String(), "title": old.Title},
			map[string]any{"checklist_id": id.String(), "title": old.Title, "action": "deleted"})
	})
}

// ---- items ----

func (s *Service) createChecklistItem(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := checklistResolver(r)
	if err != nil {
		return err
	}
	var req v1.CreateTaskChecklistItemRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	text, err := validChecklistText(req.GetText())
	if err != nil {
		return err
	}
	var pos *float64
	if req.Position != nil {
		if err := validItemPosition(req.GetPosition()); err != nil {
			return err
		}
		pos = req.Position
	}
	me := uid(r)
	return s.write(w, r, false, resolve, func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *clOut) error {
		ctx := r.Context()
		cl, err := q.GetTaskChecklistForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "checklist")
		}
		n, err := q.CountChecklistItems(ctx, id)
		if err != nil {
			return err
		}
		if n >= MaxChecklistItems {
			return httpx.Conflict("at most 100 items per checklist").WithDetails(ReasonChecklistItemLimit, uint64(max(n, 0)), MaxChecklistItems)
		}
		it, err := q.CreateChecklistItem(ctx, sqlc.CreateChecklistItemParams{ChecklistID: id, TaskID: t.ID, Text: text, Position: pos, CreatedBy: &me})
		if err != nil {
			return err
		}
		o.status = http.StatusCreated
		if err := o.c.record(ctx, q, t, me, "checklist", nil, map[string]any{"checklist_id": id.String(), "title": cl.Title,
			"item_id": it.ID.String(), "text": text, "action": "item_added"}); err != nil {
			return err
		}
		return o.fill(ctx, q, id)
	})
}

func (s *Service) updateChecklistItem(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := itemResolver(r)
	if err != nil {
		return err
	}
	var req v1.UpdateTaskChecklistItemRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var text *string
	if req.Text != nil {
		v, err := validChecklistText(req.GetText())
		if err != nil {
			return err
		}
		text = &v
	}
	if req.Position != nil {
		if err := validItemPosition(req.GetPosition()); err != nil {
			return err
		}
	}
	var to *uuid.UUID
	if req.ChecklistId != nil {
		v, err := uuid.Parse(req.GetChecklistId())
		if err != nil {
			return httpx.Validation("checklistId", "invalid checklist id")
		}
		to = &v
	}
	me := uid(r)
	return s.write(w, r, false, resolve, func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *clOut) error {
		ctx := r.Context()
		old, err := q.GetChecklistItemForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "checklist item")
		}
		pos := req.Position
		moved := to != nil && *to != old.ChecklistID
		if moved {
			dst, err := q.GetTaskChecklistForUpdate(ctx, *to)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && dst.TaskID != t.ID) {
				return httpx.Validation("checklistId", "a checklist of the same task is required")
			}
			if err != nil {
				return err
			}
			n, err := q.CountChecklistItems(ctx, *to)
			if err != nil {
				return err
			}
			if n >= MaxChecklistItems {
				return httpx.Conflict("at most 100 items per checklist").WithDetails(ReasonChecklistItemLimit, uint64(max(n, 0)), MaxChecklistItems)
			}
			if pos == nil { // to the end of the target
				its, err := q.ListChecklistItems(ctx, *to)
				if err != nil {
					return err
				}
				end := 0.0
				if len(its) > 0 {
					end = its[len(its)-1].Position + 1
				}
				pos = &end
			}
		}
		it, err := q.UpdateChecklistItem(ctx, sqlc.UpdateChecklistItemParams{ID: id, Text: text, Position: pos,
			ChecklistID: to, Done: req.Done, ActorID: &me})
		if err != nil {
			return err
		}
		cl, err := q.GetTaskChecklist(ctx, it.ChecklistID)
		if err != nil {
			return err
		}
		act := func(action string, before map[string]any) error {
			after := map[string]any{"checklist_id": it.ChecklistID.String(), "title": cl.Title, "item_id": id.String(), "text": it.Text, "action": action}
			return o.c.record(ctx, q, t, me, "checklist", before, after)
		}
		if text != nil && *text != old.Text {
			if err := act("item_edited", map[string]any{"text": old.Text}); err != nil {
				return err
			}
		}
		if req.Done != nil && req.GetDone() != old.Done {
			a := "item_undone"
			if req.GetDone() {
				a = "item_done"
			}
			if err := act(a, nil); err != nil {
				return err
			}
		}
		o.status = http.StatusOK
		if moved {
			if err := act("item_moved", map[string]any{"checklist_id": old.ChecklistID.String()}); err != nil {
				return err
			}
			if err := o.fill(ctx, q, old.ChecklistID); err != nil { // the source
				return err
			}
		}
		return o.fill(ctx, q, it.ChecklistID) // main = the item's checklist now
	})
}

func (s *Service) deleteChecklistItem(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := itemResolver(r)
	if err != nil {
		return err
	}
	me := uid(r)
	return s.write(w, r, true, resolve, func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *clOut) error {
		ctx := r.Context()
		old, err := q.GetChecklistItemForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "checklist item")
		}
		cl, err := q.GetTaskChecklist(ctx, old.ChecklistID)
		if err != nil {
			return err
		}
		if _, err := q.DeleteChecklistItem(ctx, id); err != nil {
			return err
		}
		o.status = http.StatusOK
		if err := o.c.record(ctx, q, t, me, "checklist", nil, map[string]any{"checklist_id": cl.ID.String(), "title": cl.Title,
			"item_id": id.String(), "text": old.Text, "action": "item_removed"}); err != nil {
			return err
		}
		return o.fill(ctx, q, cl.ID)
	})
}

// convertChecklistItem turns an item into a subtask of the task (title = the item's text, default
// status, no other fields) and removes the item. Needs the board feature SUBTASKS and a task that
// is not a subtask itself. It creates a task: CREATE_TASKS and the task-creation budget, as
// createTask.
func (s *Service) convertChecklistItem(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := itemResolver(r)
	if err != nil {
		return err
	}
	if err := take(r, s.CreateLimit); err != nil {
		return err
	}
	me, now := uid(r), s.Now()
	return s.write(w, r, false, resolve, func(q *sqlc.Queries, tx pgx.Tx, t taskRow, o *clOut) error {
		ctx := r.Context()
		if !o.bits.Has(perm.CreateTasks) || o.scoped { // a subtask is a new task of the board
			return httpx.Forbidden("CREATE_TASKS required")
		}
		old, err := q.GetChecklistItemForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "checklist item")
		}
		if err := requireFeature(o.disabled, v1.BoardFeature_BOARD_FEATURE_SUBTASKS, "parentId", true); err != nil {
			return err
		}
		cl, err := q.GetTaskChecklist(ctx, old.ChecklistID)
		if err != nil {
			return err
		}
		b, err := q.GetBoardForUpdate(ctx, t.BoardID)
		if err != nil {
			return err
		}
		n, err := q.CountLiveTasks(ctx, t.BoardID)
		if err != nil {
			return err
		}
		if n >= MaxTasks {
			return httpx.Conflict("at most 5000 live tasks per board; archive finished ones").WithDetails(ReasonBoardTaskLimit, uint64(max(n, 0)), MaxTasks)
		}
		if err := checkParent(ctx, q, tx, t.BoardID, t.ID, uuid.Nil); err != nil {
			return err
		}
		var kids int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE parent_id = $1 AND archived_at IS NULL`, t.ID).Scan(&kids); err != nil {
			return err
		}
		if kids >= MaxSubtasks {
			return httpx.Validation("parentId", "at most 200 subtasks")
		}
		it, err := items(ctx, q, t.BoardID)
		if err != nil {
			return err
		}
		st := it.def
		if st == nil {
			return httpx.Conflict("the board has no status")
		}
		title := old.Text
		number, err := q.NextTaskNumber(ctx, t.BoardID)
		if err != nil {
			return err
		}
		roomID, err := q.CreateTaskRoom(ctx, sqlc.CreateTaskRoomParams{WorkspaceID: &b.WorkspaceID, Name: TaskKey(b.Key, number)})
		if err != nil {
			return err
		}
		pos, err := place(ctx, q, st.ID, uuid.Nil, nil, nil)
		if err != nil {
			return err
		}
		sub := taskRow{BoardID: t.BoardID, Number: number, Title: title, StatusID: st.ID, CreatedBy: &me, ParentID: &t.ID,
			Position: pos, RoomID: roomID, BoardKey: b.Key, WorkspaceID: b.WorkspaceID}
		finishFields(&sub, st.Type, me, now)
		subID, err := q.InsertTask(ctx, sqlc.InsertTaskParams{BoardID: sub.BoardID, Number: sub.Number, Title: sub.Title,
			StatusID: sub.StatusID, CreatedBy: sub.CreatedBy, ParentID: sub.ParentID, Position: sub.Position, RoomID: sub.RoomID,
			StartedAt: sub.StartedAt, CompletedAt: sub.CompletedAt, CompletedBy: sub.CompletedBy})
		if err != nil {
			return err
		}
		sub.ID = subID
		if err := q.Subscribe(ctx, sqlc.SubscribeParams{TaskID: subID, UserIds: []uuid.UUID{me}}); err != nil {
			return err
		}
		if _, err := q.DeleteChecklistItem(ctx, id); err != nil {
			return err
		}
		if err := o.c.record(ctx, q, sub, me, "created", nil, map[string]any{"title": title, "status_id": st.ID.String(),
			"status_type": st.Type, "priority": 0, "parent_id": t.ID.String(), "from_checklist_item": id.String()}); err != nil {
			return err
		}
		if err := o.c.record(ctx, q, t, me, "checklist", nil, map[string]any{"checklist_id": cl.ID.String(), "title": cl.Title,
			"item_id": id.String(), "text": old.Text, "action": "converted", "subtask_id": subID.String()}); err != nil {
			return err
		}
		o.c.tasks = append(o.c.tasks, t.ID) // the parent's subtask counters
		o.subtask = subID
		return o.fill(ctx, q, cl.ID)
	})
}
