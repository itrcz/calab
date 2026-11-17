// Package events publishes gateway events to Redis pub/sub. The gateway (next stage)
// subscribes to these channels and fans events out to sockets, filtering per recipient
// (e.g. VIEW_ROOM). Payload = 16-byte event id (uuid) + binary calaba.v1.DispatchEvent;
// the id lets the gateway deliver an event published to several channels only once.
//
// Channels (inside the key namespace, redisx.Channel):
//
//	ws:<workspace_id>            events for all members of a workspace
//	user:<user_id>               events for one user (all their sessions)
//	session:revoked:<session_id> payload-less: close that gateway session with 4010
package events

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Publisher sends events after the DB transaction that caused them has committed.
// Publishing is best-effort: failures are logged, never returned to the REST caller
// (Postgres is the source of truth; clients resync on IDENTIFY).
type Publisher interface {
	Workspace(ctx context.Context, workspaceID uuid.UUID, ev *v1.DispatchEvent)
	User(ctx context.Context, userID uuid.UUID, ev *v1.DispatchEvent)
	// Workspaces publishes one event (same id) to several workspaces, e.g. presence.
	Workspaces(ctx context.Context, workspaceIDs []uuid.UUID, ev *v1.DispatchEvent)
	// WorkspaceEvents publishes several events to one workspace in order, in one pipeline
	// (e.g. hundreds of ROOM_UPDATEs after a drag & drop reorder).
	WorkspaceEvents(ctx context.Context, workspaceID uuid.UUID, evs []*v1.DispatchEvent)
	SessionRevoked(ctx context.Context, sessionID uuid.UUID, reason string)
}

// Redis publishes to Redis pub/sub.
type Redis struct{ C rueidis.Client }

// publishTimeout bounds one PUBLISH made outside a request (background jobs, gateway).
// Events are published after the change is committed, so they must not depend on the
// request that made it: a client that goes away right after its POST (reload) must not make
// the other members miss the event.
const publishTimeout = 3 * time.Second

// RequestBudget is the total time one HTTP request may spend publishing events (and on
// other post-commit Redis work, see Detached). With a hung Redis every publish would
// otherwise wait its own timeout: a reorder of 500 rooms would hold the handler for 25 min.
const RequestBudget = 5 * time.Second

type budgetKey struct{}

// budget is the remaining post-commit time of one request. It is charged with the time
// actually spent waiting, so DB work between two publishes does not eat into it.
type budget struct {
	mu   sync.Mutex
	left time.Duration
}

// WithBudget attaches a post-commit budget of d to ctx.
func WithBudget(ctx context.Context, d time.Duration) context.Context {
	return context.WithValue(ctx, budgetKey{}, &budget{left: d})
}

// Middleware gives every request a RequestBudget for its post-commit work.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(WithBudget(r.Context(), RequestBudget)))
	})
}

// Detached returns a context for work after the commit (publishing events, reading data
// for them): not canceled with the request, and bounded by what is left of the request's
// budget — or by fallback outside a request. done charges the elapsed time to the budget.
// Once the budget is used up, the returned context is already expired: later publishes of
// the same request fail at once instead of waiting again.
func Detached(ctx context.Context, fallback time.Duration) (context.Context, func()) {
	b, _ := ctx.Value(budgetKey{}).(*budget)
	d := fallback
	if b != nil {
		b.mu.Lock()
		d = b.left
		b.mu.Unlock()
	}
	// The clock starts before the deadline is set: a context that expires on its deadline is
	// charged at least d, so the budget is used up for sure and later calls fail at once.
	start := time.Now()
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), max(d, 0))
	return dctx, func() {
		cancel()
		if b != nil {
			b.mu.Lock()
			b.left -= time.Since(start)
			b.mu.Unlock()
		}
	}
}

func (r Redis) publish(ctx context.Context, channel string, payload []byte) {
	ctx, done := Detached(ctx, publishTimeout)
	defer done()
	if err := r.C.Do(ctx, r.C.B().Publish().Channel(channel).Message(rueidis.BinaryString(payload)).Build()).Error(); err != nil {
		slog.WarnContext(ctx, "publish event failed", "channel", channel, "err", err)
	}
}

// Encode builds a pub/sub payload with a fresh event id.
func Encode(ev *v1.DispatchEvent) ([]byte, error) {
	b, err := proto.Marshal(ev)
	if err != nil {
		return nil, err
	}
	id := uuid.New()
	return append(id[:], b...), nil
}

// Decode splits a payload into event id and event.
func Decode(payload []byte) (uuid.UUID, *v1.DispatchEvent, error) {
	if len(payload) < 16 {
		return uuid.Nil, nil, errors.New("events: short payload")
	}
	id, _ := uuid.FromBytes(payload[:16])
	ev := &v1.DispatchEvent{}
	if err := proto.Unmarshal(payload[16:], ev); err != nil {
		return uuid.Nil, nil, err
	}
	return id, ev, nil
}

func (r Redis) event(ctx context.Context, channels []string, ev *v1.DispatchEvent) {
	b, err := Encode(ev)
	if err != nil {
		slog.ErrorContext(ctx, "marshal event", "err", err)
		return
	}
	for _, ch := range channels {
		r.publish(ctx, ch, b)
	}
}

// Workspace publishes ev to all members of a workspace.
func (r Redis) Workspace(ctx context.Context, id uuid.UUID, ev *v1.DispatchEvent) {
	r.event(context.WithoutCancel(ctx), []string{WorkspaceChannel(id)}, ev)
}

// Workspaces publishes ev (one event id) to several workspaces.
func (r Redis) Workspaces(ctx context.Context, ids []uuid.UUID, ev *v1.DispatchEvent) {
	chs := make([]string, len(ids))
	for i, id := range ids {
		chs[i] = WorkspaceChannel(id)
	}
	r.event(context.WithoutCancel(ctx), chs, ev)
}

// WorkspaceEvents publishes evs to all members of a workspace, in order, in one pipeline.
func (r Redis) WorkspaceEvents(ctx context.Context, id uuid.UUID, evs []*v1.DispatchEvent) {
	if len(evs) == 0 {
		return
	}
	ch := WorkspaceChannel(id)
	cmds := make(rueidis.Commands, 0, len(evs))
	for _, ev := range evs {
		b, err := Encode(ev)
		if err != nil {
			slog.ErrorContext(ctx, "marshal event", "err", err)
			continue
		}
		cmds = append(cmds, r.C.B().Publish().Channel(ch).Message(rueidis.BinaryString(b)).Build())
	}
	if len(cmds) == 0 {
		return
	}
	dctx, done := Detached(ctx, publishTimeout)
	defer done()
	// A pipeline can fail part-way (deadline mid-batch): the prefix is delivered, the rest is
	// lost. Report how many were lost, not the batch size.
	failed, first := 0, -1
	var firstErr error
	for i, res := range r.C.DoMulti(dctx, cmds...) {
		if err := res.Error(); err != nil {
			if failed == 0 {
				first, firstErr = i, err
			}
			failed++
		}
	}
	if failed > 0 {
		slog.WarnContext(ctx, "publish events failed", "channel", ch, "failed", failed, "total", len(cmds), "first_failed", first, "err", firstErr)
	}
}

// User publishes ev to all sessions of a user.
func (r Redis) User(ctx context.Context, id uuid.UUID, ev *v1.DispatchEvent) {
	r.event(context.WithoutCancel(ctx), []string{UserChannel(id)}, ev)
}

// SessionRevoked asks the gateway to close the session's socket with 4010; the payload is
// the reason (auth.Revoke*, "" = unknown), sent on in the close reason.
func (r Redis) SessionRevoked(ctx context.Context, id uuid.UUID, reason string) {
	r.publish(context.WithoutCancel(ctx), RevokedChannel(id), []byte(reason))
}

// Channel kinds: a channel name inside the namespace starts with one of them. The gateway
// subscribes to them all (kind + "*" each, or the whole namespace) and routes by kind.
const (
	WorkspacePrefix = "ws:"
	UserPrefix      = "user:"
	RevokedPrefix   = "session:revoked:"
)

// WorkspaceChannel is the channel of a workspace.
func WorkspaceChannel(id uuid.UUID) string { return redisx.Channel(WorkspacePrefix + id.String()) }

// UserChannel is the channel of a user.
func UserChannel(id uuid.UUID) string { return redisx.Channel(UserPrefix + id.String()) }

// RevokedChannel is the revocation channel of an auth session.
func RevokedChannel(id uuid.UUID) string { return redisx.Channel(RevokedPrefix + id.String()) }

// Nop discards events (tests, tools).
type Nop struct{}

// Workspace implements Publisher.
func (Nop) Workspace(context.Context, uuid.UUID, *v1.DispatchEvent) {}

// User implements Publisher.
func (Nop) User(context.Context, uuid.UUID, *v1.DispatchEvent) {}

// Workspaces implements Publisher.
func (Nop) Workspaces(context.Context, []uuid.UUID, *v1.DispatchEvent) {}

// WorkspaceEvents implements Publisher.
func (Nop) WorkspaceEvents(context.Context, uuid.UUID, []*v1.DispatchEvent) {}

// SessionRevoked implements Publisher.
func (Nop) SessionRevoked(context.Context, uuid.UUID, string) {}
