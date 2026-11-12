package boards

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
)

// NoticeLogRetention is how long the inbox keeps a task notice (ADR-0141).
const NoticeLogRetention = 90 * 24 * time.Hour

// logNotices writes the notices of one task change the users are about to get into their
// notice history (ADR-0141), one statement and one transaction for all recipients, and sets
// each TaskNotice.Id. A failure leaves the ids empty: the live notices still go out.
func (s *Service) logNotices(ctx context.Context, taskID uuid.UUID, ns []notice, tns []*v1.TaskNotice) {
	p := sqlc.InsertTaskNoticesParams{TaskID: taskID}
	ids := make([]uuid.UUID, len(ns))
	for i, n := range ns {
		id, err := uuid.NewV7()
		if err != nil {
			return
		}
		ids[i] = id
		tn := tns[i]
		p.Ids = append(p.Ids, id)
		p.UserIds = append(p.UserIds, n.user)
		p.Kinds = append(p.Kinds, int16(tn.GetKind())) //nolint:gosec // enum, < 100
		p.ActorIds = append(p.ActorIds, n.actor)
		p.MessageIds = append(p.MessageIds, n.message)
		p.Texts = append(p.Texts, tn.GetText())
		p.RuleIds = append(p.RuleIds, n.rule)
		p.ReRequested = append(p.ReRequested, n.reRequested)
		p.DueOns = append(p.DueOns, n.dueOn)
		p.DaysLeft = append(p.DaysLeft, n.daysLeft)
	}
	// The same commit admission as the task write that produced the notices: request-born
	// notices are admitted for their actor; background notices (reminders) carry none.
	err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.InsertTaskNotices(ctx, p)
	})
	if err != nil {
		slog.WarnContext(ctx, "boards: notice log", "task", taskID, "err", err)
		return
	}
	for i, tn := range tns {
		tn.Id = ids[i].String()
	}
}

// listNotices: GET /api/me/task-notices?before=&limit= — the caller's task notices (ADR-0141),
// newest first, of tasks the caller still sees, with the task's current key and title.
func (s *Service) listNotices(w http.ResponseWriter, r *http.Request) error {
	p, err := messages.ParsePage(r)
	if err != nil {
		return err
	}
	if p.After != nil {
		return httpx.BadRequest("only before is supported")
	}
	ctx := r.Context()
	me := uid(r)
	rows, err := s.db.Q.ListTaskNoticeLog(ctx, sqlc.ListTaskNoticeLogParams{UserID: me, Before: p.Before, Lim: p.Limit + 1})
	if err != nil {
		return err
	}
	out := &v1.ListTaskNoticesResponse{Entries: []*v1.TaskNoticeEntry{}, HasMore: len(rows) > int(p.Limit)}
	if out.HasMore {
		rows = rows[:p.Limit]
		// The cursor is the last scanned row, not the last listed one: a page whose rows are
		// all of tasks the caller no longer sees must still move the client past them.
		out.NextBefore = rows[len(rows)-1].ID.String()
	}
	if len(rows) == 0 {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	ids := make([]uuid.UUID, 0, len(rows))
	seen := map[uuid.UUID]bool{}
	for _, l := range rows {
		if !seen[l.TaskID] {
			seen[l.TaskID] = true
			ids = append(ids, l.TaskID)
		}
	}
	visible, err := s.visibleTasks(ctx, me, ids)
	if err != nil {
		return err
	}
	for _, l := range rows {
		t, ok := visible[l.TaskID]
		if !ok {
			continue
		}
		out.Entries = append(out.Entries, entryOf(l, t))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// RecentTasksLimit is how many tasks «Недавние» lists (CBF-179).
const RecentTasksLimit = 50

// listRecentTasks: GET /api/workspaces/{id}/recent-tasks — «Недавние» in «Мои задачи» (CBF-179): the
// latest notice of each task of the workspace the caller got one about, newest first, up to 50
// tasks the caller sees now (the same visibility as GET /api/me/task-notices).
func (s *Service) listRecentTasks(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	if _, err := member(r, wsID); err != nil {
		return err
	}
	ctx := r.Context()
	me := uid(r)
	// Twice the limit: room for tasks the caller no longer sees without a second round trip.
	rows, err := s.db.Q.ListRecentTaskNoticeLog(ctx, sqlc.ListRecentTaskNoticeLogParams{UserID: me, WorkspaceID: wsID, Lim: 2 * RecentTasksLimit})
	if err != nil {
		return err
	}
	out := &v1.ListTaskNoticesResponse{Entries: []*v1.TaskNoticeEntry{}}
	ids := make([]uuid.UUID, len(rows))
	for i, l := range rows {
		ids[i] = l.TaskID
	}
	visible := map[uuid.UUID]taskRow{}
	if len(ids) > 0 {
		visible, err = s.visibleTasks(ctx, me, ids)
		if err != nil {
			return err
		}
	}
	for _, l := range rows {
		t, ok := visible[l.TaskID]
		if !ok || t.WorkspaceID != wsID {
			continue
		}
		out.Entries = append(out.Entries, entryOf(l, t))
		if len(out.Entries) == RecentTasksLimit {
			break
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// visibleTasks: of the tasks ids, those the caller may see now, by id — the workspace is open to
// them (suspension, identity policy) and the task is visible (sees: board access, task scope,
// live).
func (s *Service) visibleTasks(ctx context.Context, me uuid.UUID, ids []uuid.UUID) (map[uuid.UUID]taskRow, error) {
	ts, err := queryTasks(ctx, s.db.Pool, "WHERE t.id = ANY($1)", ids)
	if err != nil {
		return nil, err
	}
	visible := map[uuid.UUID]taskRow{}
	wsOK := map[uuid.UUID]bool{}
	for _, t := range ts {
		ok, known := wsOK[t.WorkspaceID]
		if !known {
			err := perm.CheckAccess(ctx, t.WorkspaceID, me)
			if err != nil && httpx.AsError(err).Status >= 500 {
				return nil, err
			}
			ok = err == nil
			wsOK[t.WorkspaceID] = ok
		}
		if !ok {
			continue
		}
		users, err := sees(ctx, s.db.Q, t, []uuid.UUID{me})
		if err != nil {
			return nil, err
		}
		if len(users) == 1 {
			visible[t.ID] = t
		}
	}
	return visible, nil
}

// entryOf is the wire entry of a history row of the task t as it is now.
func entryOf(l sqlc.TaskNoticeLog, t taskRow) *v1.TaskNoticeEntry {
	return &v1.TaskNoticeEntry{
		Id: l.ID.String(), WorkspaceId: t.WorkspaceID.String(), BoardId: t.BoardID.String(), TaskId: t.ID.String(),
		TaskKey: TaskKey(t.BoardKey, t.Number), TaskTitle: t.Title, CreatedAt: timestamppb.New(l.CreatedAt),
		Notice: noticeOf(l),
	}
}

// noticeOf is the wire notice of a history row.
func noticeOf(l sqlc.TaskNoticeLog) *v1.TaskNotice {
	return &v1.TaskNotice{
		Id: l.ID.String(), Kind: v1.TaskNoticeKind(l.Kind), ActorId: idp(l.ActorID), MessageId: idp(l.MessageID),
		Text: l.Text, RuleId: idp(l.RuleID), ReRequested: l.ReRequested, DueOn: l.DueOn, DaysLeft: l.DaysLeft,
	}
}
