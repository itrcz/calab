package bots

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// Task notice relay (ADR-0090): a user's task notices go, as TASK_NOTICE, to the bots in their
// users.task_notify_bots that are members of the task's workspace — on the bot's user channel
// (gateway) and into its webhook queue. The boards service calls RelayTaskNotice where it sends
// the user a TASK_UPDATE with a notice, so every kind (sweeps and mandatory approvals included)
// is relayed exactly when the user is notified.
//
// Stale ids (a bot that left the workspace, was blocked or deleted) are skipped when sending:
// TaskNoticeRelayBots checks membership, token and blocks on every send. A deleted bot is also
// removed from the arrays (RemoveTaskNotifyBot); a bot leaving a workspace is not (it may still
// share another one with the user), the send-time check covers it.

const relaysTTL = 30 * time.Second

// relayCache: the users with a non-empty task_notify_bots (reloaded every relaysTTL and after
// a local PATCH /api/me). It only spares the lookup for the users without a relay: the bots
// themselves are read at send time, so turning a bot off is immediate on every instance and
// turning one on reaches other instances within relaysTTL.
type relayCache struct {
	mu    sync.Mutex
	at    time.Time
	users map[uuid.UUID]bool
}

// InvalidateTaskRelays drops the cached set of users with a relay (PATCH /api/me changed one).
func (s *Service) InvalidateTaskRelays() {
	s.relays.mu.Lock()
	s.relays.at = time.Time{}
	s.relays.mu.Unlock()
}

func (s *Service) relayUsers(ctx context.Context) map[uuid.UUID]bool {
	c := &s.relays
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) < relaysTTL {
		return c.users
	}
	ids, err := s.db.Q.ListTaskNoticeRelayUsers(ctx)
	if err != nil {
		slog.WarnContext(ctx, "bots: task relay users", "err", err)
		return c.users // keep the previous set
	}
	users := make(map[uuid.UUID]bool, len(ids))
	for _, id := range ids {
		users[id] = true
	}
	c.users, c.at = users, time.Now()
	return users
}

// HasTaskRelay reports whether user may relay task notices to a bot (cached): the boards service
// builds a TASK_NOTICE only then.
func (s *Service) HasTaskRelay(ctx context.Context, user uuid.UUID) bool {
	ctx, cancel := queueCtx(ctx)
	defer cancel()
	return s.relayUsers(ctx)[user]
}

// RelayTaskNotice sends a task notice of n.user_id to the bots they chose that are members of
// n.workspace_id: TASK_NOTICE on the bot's user channel and in its webhook queue. Nothing goes
// to the workspace channel or to other bots. n is not modified.
func (s *Service) RelayTaskNotice(ctx context.Context, n *v1.TaskNoticeRelay) {
	user, err := uuid.Parse(n.GetUserId())
	if err != nil {
		return
	}
	ws, err := uuid.Parse(n.GetWorkspaceId())
	if err != nil {
		return
	}
	ctx, cancel := queueCtx(ctx)
	defer cancel()
	if !s.relayUsers(ctx)[user] {
		return
	}
	bots, err := s.db.Q.TaskNoticeRelayBots(ctx, sqlc.TaskNoticeRelayBotsParams{UserID: user, WorkspaceID: ws})
	if err != nil {
		slog.WarnContext(ctx, "bots: task relay bots", "user", user, "err", err)
		return
	}
	if len(bots) == 0 {
		return
	}
	ev := pbconv.StripEvent(TaskNoticeEvent(n)) // bots never get people's email / phone (ADR-0077)
	_, hooked := s.webhookBots(ctx)
	var targets []botEvent
	for _, b := range bots {
		s.events.User(ctx, b, ev) // the gateway (Publisher.User ignores TASK_NOTICE for webhooks)
		if hooked[b] {
			targets = append(targets, botEvent{b, ev})
		}
	}
	s.enqueue(ctx, targets)
}

// TaskNoticeEvent wraps a relay as a DispatchEvent; the task loses the viewer's state
// (ADR-0090 §2): a copy when there is any.
func TaskNoticeEvent(n *v1.TaskNoticeRelay) *v1.DispatchEvent {
	if t := n.GetTask(); t.GetSubscribed() || t.GetMuted() || t.GetUnread() || t.GetViewerState() {
		c := proto.CloneOf(n)
		c.Task.Subscribed, c.Task.Muted, c.Task.Unread, c.Task.ViewerState = false, false, false, false
		n = c
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskNotice{TaskNotice: n}}
}
