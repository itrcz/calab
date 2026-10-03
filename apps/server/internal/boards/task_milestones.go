package boards

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Milestones inside a task (ADR-0063): stages of one task with a target date. Rights are those
// of the task's fields (requireEdit); the board feature MILESTONES gates creating and editing
// (deleting stays allowed). Every write is a transaction under the task row lock, journals a
// "milestones" entry and sends TASK_UPDATE of the task (the milestones travel in the task).
// Subtasks link to one of their parent's milestones (Task.task_milestone_id, updateTask); while
// live non-cancelled subtasks are linked, syncMilestones keeps the completion.

// Limits and reasons of task milestones.
const (
	MaxTaskMilestones    = 20 // per task
	MaxTaskMilestoneName = 60

	ReasonTaskMilestoneLimit = "TASK_MILESTONE_LIMIT"
	// ReasonTaskMilestoneAuto: a person toggles a milestone the server completes by its subtasks.
	ReasonTaskMilestoneAuto = "TASK_MILESTONE_AUTO"

	kindMilestones = "milestones"
)

// MilestoneProgress counts the linked live subtasks by their status types (ADR-0063 §2): total
// leaves cancelled ones out, done counts completed ones.
func MilestoneProgress(types []string) (done, total int) {
	for _, t := range types {
		switch t {
		case "cancelled":
			continue
		case "completed":
			done++
		}
		total++
	}
	return done, total
}

// AutoCompleted answers whether the server keeps a milestone's completion (auto: subtasks are
// counted) and, if so, whether it is completed (all of them done).
func AutoCompleted(done, total int) (completed, auto bool) {
	if total == 0 {
		return false, false
	}
	return done == total, true
}

// ---- proto ----

func taskMilestoneProto(m sqlc.TaskMilestone, done, total int) *v1.TaskMilestone {
	return &v1.TaskMilestone{Id: m.ID.String(), TaskId: m.TaskID.String(), Name: m.Name, DueOn: DateString(m.DueOn),
		Position: m.Position, CompletedAt: tsp(m.CompletedAt), CompletedBy: idp(m.CompletedBy),
		Done: uint32(max(done, 0)), Total: uint32(max(total, 0)), //nolint:gosec // counts
		CreatedBy: idp(m.CreatedBy), CreatedAt: timestamppb.New(m.CreatedAt), UpdatedAt: timestamppb.New(m.UpdatedAt)}
}

// linkTypes groups the status types of the linked subtasks of these tasks by milestone.
func linkTypes(ctx context.Context, q *sqlc.Queries, taskIDs []uuid.UUID) (map[uuid.UUID][]string, error) {
	links, err := q.ListMilestoneLinks(ctx, taskIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID][]string, len(links))
	for _, l := range links {
		out[l.MilestoneID] = append(out[l.MilestoneID], l.StatusType)
	}
	return out, nil
}

// taskMilestones fills Task.milestones and Task.milestone_progress of out (tasksProto): two
// indexed queries per batch, the second only for tasks that have milestones.
func taskMilestones(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID, out []*v1.Task, idx map[uuid.UUID]int) error {
	ms, err := q.ListTaskMilestones(ctx, ids)
	if err != nil || len(ms) == 0 {
		return err
	}
	var owners []uuid.UUID
	for _, m := range ms {
		if !slices.Contains(owners, m.TaskID) {
			owners = append(owners, m.TaskID)
		}
	}
	types, err := linkTypes(ctx, q, owners)
	if err != nil {
		return err
	}
	for _, m := range ms {
		t := out[idx[m.TaskID]]
		done, total := MilestoneProgress(types[m.ID])
		t.Milestones = append(t.Milestones, taskMilestoneProto(m, done, total))
		if t.MilestoneProgress == nil {
			t.MilestoneProgress = &v1.TaskMilestoneProgress{}
		}
		t.MilestoneProgress.Total++
		if m.CompletedAt != nil {
			t.MilestoneProgress.Done++
		}
	}
	return nil
}

// ---- auto completion ----

// milestoneTriggers: journal kinds that may change a milestone's subtasks or their statuses.
var milestoneTriggers = []string{"status", "parent", kindMilestones, "archived", "restored", "moved_board"}

// syncMilestones runs at the end of every task transaction (taskTx, after the rules): the
// milestones of the parents the change touched get completed exactly when all their linked
// subtasks are (ADR-0063 §2). A milestone that flips journals "auto_completed" /
// "auto_reopened" on its task (actor: the author of the change) and the task gets TASK_UPDATE.
func (s *Service) syncMilestones(ctx context.Context, q *sqlc.Queries, tx pgx.Tx, c *change) error {
	acts := c.acts
	if c.auto != nil {
		acts = append(slices.Clip(acts), c.auto.acts...)
	}
	var subjects []uuid.UUID
	cands := slices.Clone(c.tasks)
	var actor *uuid.UUID
	for _, a := range acts {
		if !slices.Contains(milestoneTriggers, a.Kind) {
			continue
		}
		if actor == nil {
			actor = a.ActorID
		}
		subjects = append(subjects, a.TaskID)
		if a.Kind == "parent" {
			var before struct {
				ParentID string `json:"parent_id"`
			}
			if json.Unmarshal(a.Before, &before) == nil {
				if id, err := uuid.Parse(before.ParentID); err == nil {
					cands = append(cands, id)
				}
			}
		}
	}
	if len(subjects) == 0 {
		return nil
	}
	parents, err := q.ParentsOfTasks(ctx, subjects)
	if err != nil {
		return err
	}
	cands = append(cands, parents...)
	slices.SortFunc(cands, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })
	cands = slices.Compact(cands)
	ms, err := q.ListTaskMilestones(ctx, cands)
	if err != nil || len(ms) == 0 {
		return err
	}
	var owners []uuid.UUID
	for _, m := range ms {
		if !slices.Contains(owners, m.TaskID) {
			owners = append(owners, m.TaskID)
		}
	}
	types, err := linkTypes(ctx, q, owners)
	if err != nil {
		return err
	}
	rows := map[uuid.UUID]taskRow{}
	for _, m := range ms {
		done, total := MilestoneProgress(types[m.ID])
		completed, auto := AutoCompleted(done, total)
		if !auto || completed == (m.CompletedAt != nil) {
			continue
		}
		if err := q.SetTaskMilestoneAuto(ctx, sqlc.SetTaskMilestoneAutoParams{Completed: completed, ActorID: actor, ID: m.ID}); err != nil {
			return err
		}
		t, ok := rows[m.TaskID]
		if !ok {
			if t, ok, err = taskByID(ctx, tx, m.TaskID, false); err != nil {
				return err
			}
			if !ok {
				continue
			}
			rows[m.TaskID] = t
		}
		action := "auto_reopened"
		if completed {
			action = "auto_completed"
		}
		if err := c.recordAs(ctx, q, t, actor, kindMilestones, nil, map[string]any{"action": action, "milestone_id": m.ID.String(),
			"name": m.Name, "due_on": dateAny(m.DueOn), "done": done, "total": total}); err != nil {
			return err
		}
		if !slices.Contains(c.tasks, m.TaskID) {
			c.tasks = append(c.tasks, m.TaskID)
		}
	}
	for id := range rows {
		if err := q.TouchTask(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// ---- transaction frame ----

// msOut is what a milestone write produced.
type msOut struct {
	status int
	id     uuid.UUID // the response milestone (Nil after DELETE)
	t      taskRow
	c      change
}

// msWrite runs a milestone mutation: resolve finds the task of the path object, then the task
// row is locked, the caller must be able to edit it and the feature gate passes (deleting stays
// allowed). Publishes TASK_UPDATE of the task with the journal entries.
func (s *Service) msWrite(w http.ResponseWriter, r *http.Request, deleting bool,
	resolve func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error),
	fn func(q *sqlc.Queries, tx pgx.Tx, t taskRow, o *msOut) error) error {
	me := uid(r)
	var o msOut
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
		if err := requireFeature(acc.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_MILESTONES, kindMilestones, !deleting); err != nil {
			return err
		}
		o.t = t
		if err := fn(q, tx, t, &o); err != nil {
			return err
		}
		return q.TouchTask(r.Context(), t.ID)
	})
	if err != nil {
		return err
	}
	s.publish(r.Context(), o.t.ID, &o.c, false)
	tr, err := s.taskResponse(r, o.t.ID, false)
	if err != nil {
		return err
	}
	resp := &v1.TaskMilestoneResponse{Task: tr.GetTask()}
	if o.id != uuid.Nil {
		for _, m := range tr.GetTask().GetMilestones() {
			if m.GetId() == o.id.String() {
				resp.Milestone = m
			}
		}
	}
	httpx.Write(w, o.status, resp)
	return nil
}

func milestoneResolver(r *http.Request) (uuid.UUID, func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error), error) {
	id, err := httpx.PathUUID(r, "id", "milestone")
	if err != nil {
		return id, nil, err
	}
	return id, func(ctx context.Context, q *sqlc.Queries) (uuid.UUID, error) {
		m, err := q.GetTaskMilestone(ctx, id)
		return m.TaskID, notFoundOr(err, "milestone")
	}, nil
}

func validMilestoneName(s string) (string, error) {
	return validText("name", s, 1, MaxTaskMilestoneName)
}

func validMilestoneDue(s string) (pgtype.Date, error) {
	d, ok := ParseDate(s)
	if !ok {
		return d, httpx.Validation("dueOn", "date must be YYYY-MM-DD")
	}
	return d, nil
}

// milestoneEntry is the journal's "after" of a milestone change.
func milestoneEntry(m sqlc.TaskMilestone, action string) map[string]any {
	return map[string]any{"action": action, "milestone_id": m.ID.String(), "name": m.Name, "due_on": dateAny(m.DueOn)}
}

// ---- handlers ----

func (s *Service) createTaskMilestone(w http.ResponseWriter, r *http.Request) error {
	var req v1.CreateTaskMilestoneRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validMilestoneName(req.GetName())
	if err != nil {
		return err
	}
	due, err := validMilestoneDue(req.GetDueOn())
	if err != nil {
		return err
	}
	if req.Position != nil {
		if err := validItemPosition(req.GetPosition()); err != nil {
			return err
		}
	}
	taskID, err := httpx.PathUUID(r, "id", "task")
	if err != nil {
		return err
	}
	me := uid(r)
	return s.msWrite(w, r, false, func(context.Context, *sqlc.Queries) (uuid.UUID, error) { return taskID, nil },
		func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *msOut) error {
			ctx := r.Context()
			if t.ParentID != nil {
				return httpx.Validation("taskId", "a subtask has no milestones")
			}
			n, err := q.CountTaskMilestones(ctx, t.ID)
			if err != nil {
				return err
			}
			if n >= MaxTaskMilestones {
				return httpx.Conflict("at most 20 milestones per task").WithDetails(ReasonTaskMilestoneLimit, uint64(max(n, 0)), MaxTaskMilestones)
			}
			m, err := q.CreateTaskMilestone(ctx, sqlc.CreateTaskMilestoneParams{TaskID: t.ID, Name: name, DueOn: due,
				Position: req.Position, CreatedBy: &me})
			if err != nil {
				return err
			}
			o.status, o.id = http.StatusCreated, m.ID
			return o.c.record(ctx, q, t, me, kindMilestones, nil, milestoneEntry(m, "created"))
		})
}

func (s *Service) updateTaskMilestone(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := milestoneResolver(r)
	if err != nil {
		return err
	}
	var req v1.UpdateTaskMilestoneRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var name *string
	if req.Name != nil {
		v, err := validMilestoneName(req.GetName())
		if err != nil {
			return err
		}
		name = &v
	}
	due, err := validMilestoneDue(req.GetDueOn())
	if err != nil {
		return err
	}
	if req.Position != nil {
		if err := validItemPosition(req.GetPosition()); err != nil {
			return err
		}
	}
	me := uid(r)
	return s.msWrite(w, r, false, resolve, func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *msOut) error {
		ctx := r.Context()
		old, err := q.GetTaskMilestoneForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "milestone")
		}
		o.status, o.id = http.StatusOK, id
		setDue := req.DueOn != nil && dateAny(due) != dateAny(old.DueOn)
		renamed := name != nil && *name != old.Name
		moved := req.Position != nil && req.GetPosition() != old.Position
		m := old
		if renamed || setDue || moved {
			p := sqlc.UpdateTaskMilestoneParams{ID: id, SetDue: setDue, DueOn: due}
			if renamed {
				p.Name = name
			}
			if moved {
				p.Position = req.Position
			}
			if m, err = q.UpdateTaskMilestone(ctx, p); err != nil {
				return err
			}
		}
		if renamed {
			if err := o.c.record(ctx, q, t, me, kindMilestones, map[string]any{"name": old.Name}, milestoneEntry(m, "renamed")); err != nil {
				return err
			}
		}
		if setDue {
			if err := o.c.record(ctx, q, t, me, kindMilestones, map[string]any{"due_on": dateAny(old.DueOn)}, milestoneEntry(m, "dated")); err != nil {
				return err
			}
		}
		if moved {
			if err := o.c.record(ctx, q, t, me, kindMilestones, map[string]any{"position": old.Position}, milestoneEntry(m, "moved")); err != nil {
				return err
			}
		}
		if req.Completed != nil && req.GetCompleted() != (old.CompletedAt != nil) {
			types, err := linkTypes(ctx, q, []uuid.UUID{t.ID})
			if err != nil {
				return err
			}
			if _, auto := AutoCompleted(MilestoneProgress(types[id])); auto {
				return httpx.Conflict("the milestone follows its subtasks").WithDetails(ReasonTaskMilestoneAuto, 0, 0)
			}
			if m, err = q.SetTaskMilestoneCompleted(ctx, sqlc.SetTaskMilestoneCompletedParams{Completed: req.GetCompleted(), ActorID: &me, ID: id}); err != nil {
				return err
			}
			action := "reopened"
			if req.GetCompleted() {
				action = "completed"
			}
			if err := o.c.record(ctx, q, t, me, kindMilestones, nil, milestoneEntry(m, action)); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Service) deleteTaskMilestone(w http.ResponseWriter, r *http.Request) error {
	id, resolve, err := milestoneResolver(r)
	if err != nil {
		return err
	}
	me := uid(r)
	return s.msWrite(w, r, true, resolve, func(q *sqlc.Queries, _ pgx.Tx, t taskRow, o *msOut) error {
		ctx := r.Context()
		old, err := q.GetTaskMilestoneForUpdate(ctx, id)
		if err != nil {
			return notFoundOr(err, "milestone")
		}
		subs, err := q.UnlinkMilestoneSubtasks(ctx, &id)
		if err != nil {
			return err
		}
		o.c.tasks = append(o.c.tasks, subs...)
		if _, err := q.DeleteTaskMilestone(ctx, id); err != nil {
			return err
		}
		o.status = http.StatusOK
		return o.c.record(ctx, q, t, me, kindMilestones, map[string]any{"name": old.Name, "due_on": dateAny(old.DueOn)}, milestoneEntry(old, "deleted"))
	})
}

// subtaskMilestone validates a subtask's new milestone (updateTask): it must be one of the
// parent's (ADR-0063 §1).
func subtaskMilestone(ctx context.Context, q *sqlc.Queries, t taskRow) error {
	if t.TaskMilestoneID == nil {
		return nil
	}
	if t.ParentID == nil {
		return httpx.Validation("taskMilestoneId", "only a subtask links to a milestone of its parent")
	}
	m, err := q.GetTaskMilestone(ctx, *t.TaskMilestoneID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err != nil || m.TaskID != *t.ParentID {
		return httpx.Validation("taskMilestoneId", "a milestone of the parent task is required")
	}
	return nil
}
