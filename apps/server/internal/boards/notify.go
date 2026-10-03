package boards

import (
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/notifications"
	"github.com/calaba/calaba/server/internal/perm"
)

// notice is one notification of a user about a task (ADR-0042 §4).
type notice struct {
	user    uuid.UUID
	kind    notifications.TaskKind
	actor   uuid.UUID
	message uuid.UUID
}

var noticeKinds = map[notifications.TaskKind]v1.TaskNoticeKind{
	notifications.TaskAssigned:  v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED,
	notifications.TaskMentioned: v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED,
	notifications.TaskComment:   v1.TaskNoticeKind_TASK_NOTICE_KIND_COMMENT,
	notifications.TaskStatus:    v1.TaskNoticeKind_TASK_NOTICE_KIND_STATUS,

	notifications.TaskApprovalRequested: v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED,
	notifications.TaskApproved:          v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVED,
	notifications.TaskRejected:          v1.TaskNoticeKind_TASK_NOTICE_KIND_REJECTED,
}

func actsOf(acts []sqlc.TaskActivity, taskID uuid.UUID) []sqlc.TaskActivity {
	var out []sqlc.TaskActivity
	for _, a := range acts {
		if a.TaskID == taskID {
			out = append(out, a)
		}
	}
	return out
}

// sees keeps the users who see the task (ADR-0059: perm.TaskBits ≠ 0 — the board's viewers and,
// on a task-scoped board, the task's own assignees and approvers while it is live).
func sees(ctx context.Context, q *sqlc.Queries, t taskRow, users []uuid.UUID) ([]uuid.UUID, error) {
	res := perm.NewResolver(q)
	out := make([]uuid.UUID, 0, len(users))
	for _, u := range users {
		acc, err := res.Board(ctx, t.BoardID, u)
		if err != nil && err != perm.ErrNoBoard { //nolint:errorlint // sentinel from the resolver
			return nil, err
		}
		if err != nil || acc.Archived {
			continue
		}
		if acc.Bits.Has(perm.ViewBoard) {
			out = append(out, u)
			continue
		}
		if !acc.TaskScoped || t.ArchivedAt != nil {
			continue
		}
		inv, err := q.GetTaskInvite(ctx, sqlc.GetTaskInviteParams{TaskID: t.ID, UserID: u})
		if err != nil {
			return nil, err
		}
		if perm.TaskBits(acc, inv.Assignee, inv.Approver) != 0 {
			out = append(out, u)
		}
	}
	return out, nil
}

// decide applies the users' task levels to candidates of one kind and marks the notified ones.
func decide(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, kind notifications.TaskKind, users []uuid.UUID, msg uuid.UUID, mandatory map[uuid.UUID]bool, c *change) error {
	users = slices.DeleteFunc(slices.Clone(users), func(u uuid.UUID) bool { return u == actor })
	if len(users) == 0 {
		return nil
	}
	subs, err := q.ListTaskSubscribers(ctx, t.ID)
	if err != nil {
		return err
	}
	sub := map[uuid.UUID]sqlc.TaskSubscriber{}
	for _, s := range subs {
		sub[s.UserID] = s
	}
	levels, err := q.GetTaskLevel(ctx, sqlc.GetTaskLevelParams{UserIds: users, WorkspaceID: t.WorkspaceID})
	if err != nil {
		return err
	}
	var hit []uuid.UUID
	for _, l := range levels {
		s, subscribed := sub[l.UserID]
		f := notifications.TaskFacts{Kind: kind, Level: notifications.LevelFromDB(l.TaskLevel, v1.NotificationLevel_NOTIFICATION_LEVEL_ALL),
			Subscribed: subscribed, Muted: s.Muted, Workspace: l.Muted, Mandatory: mandatory[l.UserID]}
		if !notifications.TaskNotifies(f) {
			continue
		}
		if slices.ContainsFunc(c.notices, func(n notice) bool { return n.user == l.UserID }) {
			continue // one notice per user and change (the first reason wins)
		}
		hit = append(hit, l.UserID)
		c.notices = append(c.notices, notice{user: l.UserID, kind: kind, actor: actor, message: msg})
	}
	if len(hit) == 0 {
		return nil
	}
	return q.MarkNotified(ctx, sqlc.MarkNotifiedParams{TaskID: t.ID, UserIds: hit})
}

// notifyDirect subscribes and notifies assigned and mentioned users who see the board.
func (s *Service) notifyDirect(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, assigned, mentioned []uuid.UUID, msg uuid.UUID, c *change) error {
	for _, g := range []struct {
		users []uuid.UUID
		kind  notifications.TaskKind
	}{{assigned, notifications.TaskAssigned}, {mentioned, notifications.TaskMentioned}} {
		if len(g.users) == 0 {
			continue
		}
		users, err := sees(ctx, q, t, g.users)
		if err != nil {
			return err
		}
		if len(users) == 0 {
			continue
		}
		if err := q.Subscribe(ctx, sqlc.SubscribeParams{TaskID: t.ID, UserIds: users}); err != nil {
			return err
		}
		if err := decide(ctx, q, t, actor, g.kind, users, msg, nil, c); err != nil {
			return err
		}
	}
	return nil
}

// notifySubscribers notifies the subscribers of a task (comment / status) by their levels.
func (s *Service) notifySubscribers(ctx context.Context, q *sqlc.Queries, t taskRow, actor uuid.UUID, kind notifications.TaskKind, msg uuid.UUID, c *change) error {
	subs, err := q.ListTaskSubscribers(ctx, t.ID)
	if err != nil {
		return err
	}
	users := make([]uuid.UUID, 0, len(subs))
	for _, sb := range subs {
		users = append(users, sb.UserID)
	}
	if users, err = sees(ctx, q, t, users); err != nil {
		return err
	}
	return decide(ctx, q, t, actor, kind, users, msg, nil, c)
}

// sendNotices sends every notified user the task as they see it, with the notice.
func (s *Service) sendNotices(ctx context.Context, taskID uuid.UUID, ns []notice) {
	if len(ns) == 0 {
		return
	}
	t, ok, err := taskByID(ctx, s.db.Pool, taskID, false)
	if err != nil || !ok {
		return
	}
	for _, n := range ns {
		pbs, err := tasksProto(ctx, s.db.Q, []taskRow{t}, n.user)
		if err != nil {
			return
		}
		tn := &v1.TaskNotice{Kind: noticeKinds[n.kind]}
		if n.actor != uuid.Nil { // the approval reminder has no actor
			tn.ActorId = n.actor.String()
		}
		if n.message != uuid.Nil {
			tn.MessageId = n.message.String()
		}
		s.ev.User(ctx, n.user, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskUpdate{TaskUpdate: &v1.TaskUpdate{Task: pbs[0], Notice: tn}}})
	}
}

// TaskHook runs after a comment is posted (or forwarded) into a task room (messages.Handlers
// .TaskHook): the author subscribes, @mentioned users who see the board are subscribed and
// notified, the other subscribers get a COMMENT notice by their levels, and the board gets
// TASK_UPDATE (comment_count).
func (s *Service) TaskHook(ctx context.Context, acc perm.RoomAccess, msg sqlc.Message) {
	// The comment is committed: finish even if the client goes away.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	var c change
	err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
		t, ok, err := taskByID(ctx, tx, acc.TaskID, false)
		if err != nil || !ok {
			return err
		}
		if err := q.Subscribe(ctx, sqlc.SubscribeParams{TaskID: t.ID, UserIds: []uuid.UUID{msg.AuthorID}}); err != nil {
			return err
		}
		mentioned, _ := messages.ParseMentions(msg.Content)
		if err := s.notifyDirect(ctx, q, t, msg.AuthorID, nil, mentioned, msg.ID, &c); err != nil {
			return err
		}
		return s.notifySubscribers(ctx, q, t, msg.AuthorID, notifications.TaskComment, msg.ID, &c)
	})
	if err != nil {
		slog.WarnContext(ctx, "boards: task comment hook", "task", acc.TaskID, "err", err)
		return
	}
	s.publishTask(ctx, acc.TaskID, c.notices)
	s.TaskCommentHook(ctx, acc, "created", msg, msg.AuthorID)
}
