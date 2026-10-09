package bots

import (
	"cmp"
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/webhook"
)

// Webhooks (ADR-0031 §4). Events a bot would get from the gateway — messages and reactions
// of rooms it can view and of its DMs, task events of boards it views, meetings, member
// updates (ADR-0051, workspaceView) — are also queued for bots with a webhook, as rows
// of bot_webhook_deliveries, after the change committed (Publisher). One worker in the
// cluster (Valkey lock) POSTs them with an HMAC signature; failures are retried with
// backoff 1 min → 1 h for up to a day; a webhook failing for a day is disabled and the bot's
// owner and managers get BOT_UPDATE with its state.

// WebhookOptions tune delivery; zero values are the production defaults (webhook.Options).
type WebhookOptions = webhook.Options

// Backoff is the default retry schedule: 1 min doubling, capped at 1 h.
func Backoff(attempt int32) time.Duration { return webhook.Backoff(attempt) }

const (
	hooksTTL  = 30 * time.Second
	minSecret = 16
	maxSecret = 256
	lockKey   = "bots:webhook:worker"
)

// webhookWorker: the shared engine (internal/webhook) bound to the bots' outbox.
type webhookWorker struct {
	tr     *webhook.Transport
	opts   webhook.Options
	worker *webhook.Worker // set by New
}

func newWebhookWorker(o WebhookOptions) webhookWorker {
	o = o.WithDefaults()
	return webhookWorker{opts: o, tr: webhook.NewTransport(o)}
}

// ---- which bots have webhooks ----

// hookCache: bots with a working webhook, by workspace (reloaded every hooksTTL, and after
// local changes; other instances catch up within hooksTTL).
type hookCache struct {
	mu   sync.Mutex
	at   time.Time
	byWS map[uuid.UUID][]uuid.UUID
	bots map[uuid.UUID]bool
}

func (c *hookCache) invalidate() {
	c.mu.Lock()
	c.at = time.Time{}
	c.mu.Unlock()
}

func (s *Service) webhookBots(ctx context.Context) (map[uuid.UUID][]uuid.UUID, map[uuid.UUID]bool) {
	c := &s.hooks
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) < hooksTTL {
		return c.byWS, c.bots
	}
	rows, err := s.db.Q.ListWebhookBots(ctx)
	if err != nil {
		slog.WarnContext(ctx, "bot webhooks: list", "err", err)
		return c.byWS, c.bots // keep the previous set
	}
	byWS, bots := map[uuid.UUID][]uuid.UUID{}, map[uuid.UUID]bool{}
	for _, r := range rows {
		bots[r.UserID] = true
		if r.WorkspaceID != nil {
			byWS[*r.WorkspaceID] = append(byWS[*r.WorkspaceID], r.UserID)
		}
	}
	c.byWS, c.bots, c.at = byWS, bots, time.Now()
	return byWS, bots
}

// ---- queueing ----

// Publisher decorates the event publisher: workspace and user events that bots with a
// webhook would receive are queued for them after being published.
type Publisher struct {
	events.Publisher
	S *Service
}

// Workspace implements events.Publisher.
func (p Publisher) Workspace(ctx context.Context, workspaceID uuid.UUID, ev *v1.DispatchEvent) {
	p.Publisher.Workspace(ctx, workspaceID, ev)
	p.S.onWorkspaceEvent(ctx, workspaceID, ev)
}

// User implements events.Publisher.
func (p Publisher) User(ctx context.Context, userID uuid.UUID, ev *v1.DispatchEvent) {
	p.Publisher.User(ctx, userID, ev)
	p.S.onUserEvent(ctx, userID, ev)
}

// BotCallback is intentionally excluded: its private outbox entry is committed atomically
// with the interaction receipt by messages.interact, never fanned out to room bots.
// deliverable: the room and actor (author / reacting user; Nil = unknown) of an event bots
// get by webhook.
func deliverable(ev *v1.DispatchEvent) (room, actor uuid.UUID, ok bool) {
	parse := func(s string) uuid.UUID { id, _ := uuid.Parse(s); return id }
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_MessageCreate:
		m := e.MessageCreate.GetMessage()
		return parse(m.GetRoomId()), parse(m.GetAuthorId()), true
	case *v1.DispatchEvent_MessageUpdate:
		m := e.MessageUpdate.GetMessage()
		return parse(m.GetRoomId()), parse(m.GetAuthorId()), true
	case *v1.DispatchEvent_MessageDelete:
		return parse(e.MessageDelete.GetRoomId()), uuid.Nil, true
	case *v1.DispatchEvent_MessageReactionAdd:
		return parse(e.MessageReactionAdd.GetRoomId()), parse(e.MessageReactionAdd.GetUserId()), true
	case *v1.DispatchEvent_MessageReactionRemove:
		return parse(e.MessageReactionRemove.GetRoomId()), parse(e.MessageReactionRemove.GetUserId()), true
	}
	return uuid.Nil, uuid.Nil, false
}

// queueCtx bounds the post-commit queueing work of one event.
func queueCtx(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
}

// botView decides what one bot gets of a workspace event: the event (maybe reduced), or nil.
type botView func(ctx context.Context, res *perm.Resolver, bot uuid.UUID) *v1.DispatchEvent

// workspaceView: the workspace events bots get by webhook, with the gateway's visibility
// (ADR-0031 §4, ADR-0051): messages and reactions by VIEW_ROOM (not their own), task events by
// VIEW_BOARD, meetings as calendar.viewer / gateway.routeCalendar see them, member updates for
// all. nil = not delivered by webhook.
func workspaceView(wsID uuid.UUID, ev *v1.DispatchEvent) botView {
	if room, actor, ok := deliverable(ev); ok {
		return func(ctx context.Context, res *perm.Resolver, bot uuid.UUID) *v1.DispatchEvent {
			if bot == actor {
				return nil // its own messages and reactions
			}
			if acc, err := res.Room(ctx, room, bot); err == nil && acc.Bits.Has(perm.ViewRoom) {
				return ev
			}
			return nil
		}
	}
	parse := func(s string) uuid.UUID { id, _ := uuid.Parse(s); return id }
	var board uuid.UUID
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		return func(context.Context, *perm.Resolver, uuid.UUID) *v1.DispatchEvent { return ev }
	case *v1.DispatchEvent_TaskCreate:
		board = parse(e.TaskCreate.GetTask().GetBoardId())
	case *v1.DispatchEvent_TaskUpdate:
		board = parse(e.TaskUpdate.GetTask().GetBoardId())
	case *v1.DispatchEvent_TaskDelete:
		board = parse(e.TaskDelete.GetBoardId())
	case *v1.DispatchEvent_TaskActivity:
		board = parse(cmp.Or(e.TaskActivity.GetBoardId(), e.TaskActivity.GetActivity().GetBoardId())) // a removed entry has no activity (ADR-0081)
	case *v1.DispatchEvent_EventCreate, *v1.DispatchEvent_EventUpdate, *v1.DispatchEvent_EventDelete, *v1.DispatchEvent_EventRsvp:
		return calendarView(wsID, ev)
	default:
		return nil
	}
	return func(ctx context.Context, res *perm.Resolver, bot uuid.UUID) *v1.DispatchEvent {
		if acc, err := res.Board(ctx, board, bot); err == nil && acc.Bits.Has(perm.ViewBoard) {
			return ev
		}
		return nil
	}
}

// calendarView: a meeting goes to the bot that organizes it and to the viewers of its room;
// external addresses only to those who may change it (calendar.viewer.canEdit), removed for the
// others (ADR-0051, as gateway.routeCalendar).
func calendarView(wsID uuid.UUID, ev *v1.DispatchEvent) botView {
	e := ev.GetEventCreate().GetEvent()
	switch {
	case ev.GetEventUpdate() != nil:
		e = ev.GetEventUpdate().GetEvent()
	case ev.GetEventDelete() != nil:
		e = ev.GetEventDelete().GetEvent()
	case ev.GetEventRsvp() != nil:
		e = ev.GetEventRsvp().GetEvent()
	}
	organizer, _ := uuid.Parse(e.GetOrganizerId())
	room, roomErr := uuid.Parse(e.GetRoomId())
	return func(ctx context.Context, res *perm.Resolver, bot uuid.UUID) *v1.DispatchEvent {
		if bot == organizer {
			return ev
		}
		if roomErr != nil {
			return nil // a meeting without a room: its organizer and attendees only
		}
		acc, err := res.Room(ctx, room, bot)
		if err != nil || !acc.Bits.Has(perm.ViewRoom) {
			return nil
		}
		if acc.Bits.Has(perm.ManageRoom) {
			return ev
		}
		if ws, _, err := res.Workspace(ctx, wsID, bot); err == nil && ws.Has(perm.ManageEvents) {
			return ev
		}
		return eventWithoutEmails(ev)
	}
}

// eventWithoutEmails returns a calendar event without external attendees' addresses (a copy
// when there are any).
func eventWithoutEmails(ev *v1.DispatchEvent) *v1.DispatchEvent {
	strip := func(c *v1.CalendarEvent) *v1.CalendarEvent { return pbconv.EventForViewer(c, pbconv.EmailsNone) }
	switch x := ev.GetEvent().(type) {
	case *v1.DispatchEvent_EventCreate:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventCreate{EventCreate: &v1.CalendarEventCreate{Event: strip(x.EventCreate.GetEvent())}}}
	case *v1.DispatchEvent_EventUpdate:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventUpdate{EventUpdate: &v1.CalendarEventUpdate{Event: strip(x.EventUpdate.GetEvent())}}}
	case *v1.DispatchEvent_EventDelete:
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventDelete{EventDelete: &v1.CalendarEventDelete{Event: strip(x.EventDelete.GetEvent())}}}
	case *v1.DispatchEvent_EventRsvp:
		r := x.EventRsvp
		a := strip(&v1.CalendarEvent{Attendees: []*v1.CalendarEventAttendee{r.GetAttendee()}}).GetAttendees()[0]
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_EventRsvp{EventRsvp: &v1.CalendarEventRsvp{
			WorkspaceId: r.GetWorkspaceId(), EventId: r.GetEventId(), Attendee: a, Counts: r.GetCounts(), Event: strip(r.GetEvent())}}}
	}
	return ev
}

func (s *Service) onWorkspaceEvent(ctx context.Context, wsID uuid.UUID, ev *v1.DispatchEvent) {
	ev = pbconv.StripEvent(ev) // bots never get people's email / phone (ADR-0077)
	view := workspaceView(wsID, ev)
	if view == nil {
		return
	}
	ctx, cancel := queueCtx(ctx)
	defer cancel()
	byWS, _ := s.webhookBots(ctx)
	cands := byWS[wsID]
	if len(cands) == 0 {
		return
	}
	res := perm.NewResolver(s.db.Q)
	var targets []botEvent
	for _, b := range cands {
		if out := view(ctx, res, b); out != nil {
			targets = append(targets, botEvent{b, out})
		}
	}
	s.enqueue(ctx, targets)
}

// onUserEvent: events of a DM come on the participants' user channels.
func (s *Service) onUserEvent(ctx context.Context, userID uuid.UUID, ev *v1.DispatchEvent) {
	_, actor, ok := deliverable(ev)
	if !ok || actor == userID {
		return
	}
	ctx, cancel := queueCtx(ctx)
	defer cancel()
	if _, bots := s.webhookBots(ctx); !bots[userID] {
		return
	}
	s.enqueue(ctx, []botEvent{{userID, ev}})
}

// botEvent is an event as one bot gets it.
type botEvent struct {
	bot uuid.UUID
	ev  *v1.DispatchEvent
}

// ForBot returns ev as bot should get it: a MESSAGE_CREATE command addressed to another bot
// is removed (ADR-0031 §6). ev itself is not modified.
func ForBot(ev *v1.DispatchEvent, bot string) *v1.DispatchEvent {
	mc := ev.GetMessageCreate()
	if cmd := mc.GetMessage().GetCommand(); cmd == nil || cmd.GetBotUserId() == bot {
		return ev
	}
	return WithoutCommand(ev)
}

// WithoutCommand returns a MESSAGE_CREATE without Message.command (a copy).
func WithoutCommand(ev *v1.DispatchEvent) *v1.DispatchEvent {
	mc := ev.GetMessageCreate()
	m := proto.CloneOf(mc.GetMessage())
	m.Command = nil
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{WorkspaceId: mc.GetWorkspaceId(), Message: m}}}
}

var payloadJSON = protojson.MarshalOptions{EmitDefaultValues: true}

func (s *Service) enqueue(ctx context.Context, targets []botEvent) {
	if len(targets) == 0 {
		return
	}
	p := sqlc.EnqueueWebhookDeliveriesParams{}
	for _, t := range targets {
		b := t.bot
		id, err := uuid.NewV7()
		if err != nil {
			continue
		}
		body, err := payloadJSON.Marshal(&v1.BotWebhookUpdate{
			Id: id.String(), BotUserId: b.String(), CreatedAt: timestamppb.New(now()), Event: ForBot(t.ev, b.String()),
		})
		if err != nil {
			slog.ErrorContext(ctx, "bot webhook: encode", "err", err)
			continue
		}
		p.Ids, p.BotIds, p.Payloads = append(p.Ids, id), append(p.BotIds, b), append(p.Payloads, body)
	}
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error { return guarded.EnqueueWebhookDeliveries(ctx, p) }); err != nil {
		// A bot that was just deleted (FK) or a Postgres hiccup: the event is lost for the
		// webhook, like a missed event for a socket; the bot resyncs over REST.
		slog.WarnContext(ctx, "bot webhook: enqueue", "bots", len(p.BotIds), "err", err)
		return
	}
	s.wh.worker.Wake()
}

// ---- the bot's webhook endpoints ----

// checkWebhookURL: absolute https URL without credentials; a literal IP address must be
// allowed by the SSRF policy (host names are checked when dialing).
func (s *Service) checkWebhookURL(raw string) (string, error) { return s.wh.tr.CheckURL(raw) }

func (s *Service) webhookResponse(ctx context.Context, id uuid.UUID) (*v1.BotWebhookResponse, error) {
	b, err := s.db.Q.GetBot(ctx, id)
	if err != nil {
		return nil, err
	}
	wh := webhookPB(b)
	n, err := s.db.Q.CountPendingWebhookDeliveries(ctx, id)
	if err != nil {
		return nil, err
	}
	wh.Pending = uint32(min(n, 1<<31)) //nolint:gosec // bounded
	return &v1.BotWebhookResponse{Webhook: wh}, nil
}

func (s *Service) getWebhook(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	resp, err := s.webhookResponse(r.Context(), identity(r).UserID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (s *Service) setWebhook(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	id := identity(r).UserID
	var req v1.SetBotWebhookRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	u, err := s.checkWebhookURL(req.GetUrl())
	if err != nil {
		return err
	}
	if n := utf8.RuneCountInString(req.GetSecret()); n < minSecret || n > maxSecret {
		return httpx.Validation("secret", "secret must be 16..256 characters")
	}
	sealed, err := s.box.Seal([]byte(req.GetSecret()))
	if err != nil {
		return err
	}
	if _, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.Bot, error) {
		return guarded.SetBotWebhook(r.Context(), sqlc.SetBotWebhookParams{UserID: id, WebhookUrl: &u, WebhookSecretEnc: sealed})
	}); err != nil {
		return err
	}
	s.hooks.invalidate()
	s.announce(r.Context(), id)
	resp, err := s.webhookResponse(r.Context(), id)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (s *Service) deleteWebhook(w http.ResponseWriter, r *http.Request) error {
	if err := auth.BotsOnly(r.Context()); err != nil {
		return err
	}
	id := identity(r).UserID
	err := s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.ClearBotWebhook(r.Context(), id); err != nil {
			return err
		}
		return q.FailPendingWebhookDeliveries(r.Context(), sqlc.FailPendingWebhookDeliveriesParams{BotUserID: id, Error: "webhook removed"})
	})
	if err != nil {
		return err
	}
	s.hooks.invalidate()
	s.announce(r.Context(), id)
	httpx.NoContent(w)
	return nil
}
