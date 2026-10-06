// Package gateway is the realtime WebSocket gateway (docs/05, ADR-0007): HELLO / IDENTIFY /
// RESUME / HEARTBEAT, per-session seq with a Redis resume buffer, presence, typing and
// fan-out of REST events from Redis pub/sub with per-recipient VIEW_ROOM filtering.
package gateway

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/profile"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/voice"
)

// Config tunes the gateway.
type Config struct {
	HeartbeatInterval  time.Duration  // docs/05: ~41 s
	MaxSessionsPerUser int            // docs/05: 5
	MaxTabsPerSession  int            // browser tabs of one auth session (#40, tabs.go): 8
	ShutdownSpread     time.Duration  // RECONNECT spread on graceful shutdown
	AllowedOrigins     []string       // web client origins (PUBLIC_APP_URL[_ALT]), see OriginAllowed
	Plans              *plans.Service // Workspace.plan in snapshots (ADR-0024); nil = unset
	PlanContact        string         // Ready.plan_contact
}

// Hub owns this instance's gateway sessions.
type Hub struct {
	cfg      Config
	instance string
	db       *db.DB
	redis    rueidis.Client
	auth     *auth.Service
	pub      events.Publisher
	voice    voice.Store
	pres     presenceStore
	buf      bufferStore

	mu       sync.RWMutex
	sessions map[uuid.UUID]*Session
	byUser   map[uuid.UUID]map[*Session]bool
	byWS     map[uuid.UUID]map[*Session]bool
	states   map[uuid.UUID]*wsState
	releases map[uuid.UUID]chan struct{}

	IdentityInvalidated  func()
	identityWake         chan struct{}
	identityRun          sync.Mutex
	identityCursor       uuid.UUID
	preparations         chan func()
	checkWorkspace       func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error)
	identityWorkspaces   func(context.Context, uuid.UUID) ([]uuid.UUID, error)
	checkPrincipal       func(context.Context, auth.Identity) (identitypolicy.Principal, time.Time, error)
	checkAdmissionPolicy func(context.Context, uuid.UUID) (int64, error)
	closing              atomic.Bool
	nSockets             atomic.Int64
	// botSeen: when a bot's REST activity was last recorded here (TouchBot throttle).
	botSeen sync.Map
}

// New creates a hub. Run must be started for fan-out.
func New(cfg Config, d *db.DB, r rueidis.Client, a *auth.Service, pub events.Publisher) *Hub {
	if cfg.HeartbeatInterval == 0 {
		cfg.HeartbeatInterval = 41 * time.Second
	}
	if cfg.MaxSessionsPerUser == 0 {
		cfg.MaxSessionsPerUser = 5
	}
	if cfg.MaxTabsPerSession == 0 {
		cfg.MaxTabsPerSession = 8
	}
	return &Hub{
		cfg: cfg, instance: uuid.NewString(), db: d, redis: r, auth: a, pub: pub, identityWake: make(chan struct{}, 1), preparations: make(chan func(), bufferQueue),
		voice: voice.Store{C: r}, pres: presenceStore{c: r, ttl: 2 * cfg.HeartbeatInterval}, buf: bufferStore{c: r},
		sessions: map[uuid.UUID]*Session{}, byUser: map[uuid.UUID]map[*Session]bool{},
		byWS: map[uuid.UUID]map[*Session]bool{}, states: map[uuid.UUID]*wsState{}, releases: map[uuid.UUID]chan struct{}{},
	}
}

func (h *Hub) sockets(d int64) { socketsGauge.Set(float64(h.nSockets.Add(d))) }

// ctlPrefix starts the name of every instance's control channel (ctlChannel).
const ctlPrefix = "gw:ctl:"

func ctlChannel(instance string) string { return redisx.Channel(ctlPrefix + instance) }
func instKey(instance string) string    { return redisx.Key("gw:inst:" + instance) }

// subscription is what the hub PSUBSCRIBEs to: the event channels of all workspaces, users
// and auth sessions, and its own control channel. With a key namespace that is the single
// pattern "<namespace>*": Valkey checks a PSUBSCRIBE pattern against the ACL literally (not as
// a glob), so a user limited to &<namespace>* may subscribe to exactly that; onMessage drops
// the namespace's other channels. Without a namespace: the historical per-kind patterns.
func (h *Hub) subscription() rueidis.Completed {
	if redisx.KeyPrefix() != "" {
		return h.redis.B().Psubscribe().Pattern(redisx.Channel("*")).Build()
	}
	return h.redis.B().Psubscribe().Pattern(redisx.Channel(events.WorkspacePrefix+"*"),
		redisx.Channel(events.UserPrefix+"*"), redisx.Channel(events.RevokedPrefix+"*"), ctlChannel(h.instance), redisx.Channel("identity:invalidated")).Build()
}

// Run subscribes to events and runs background loops until ctx is done.
func (h *Hub) Run(ctx context.Context) {
	go h.lease(ctx) //nolint:gosec // G118: final DEL after ctx is done uses its own context on purpose
	go h.restoreManual(ctx)
	go h.sweepPresence(ctx)
	go h.runIdentityEnforcement(ctx)
	h.runPreparations(ctx)
	first := true
	for ctx.Err() == nil {
		cmd := h.subscription()
		if !first {
			// Events published while we were not subscribed are lost: make clients resync.
			h.invalidateAll()
		}
		first = false
		err := h.redis.Receive(ctx, cmd, h.onMessage)
		if ctx.Err() != nil {
			return
		}
		slog.Error("gateway pubsub disconnected", "err", err)
		time.Sleep(time.Second)
	}
}

func (h *Hub) lease(ctx context.Context) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		_ = h.redis.Do(ctx, h.redis.B().Set().Key(instKey(h.instance)).Value("1").Ex(30*time.Second).Build()).Error()
		select {
		case <-ctx.Done():
			_ = h.redis.Do(context.Background(), h.redis.B().Del().Key(instKey(h.instance)).Build()).Error()
			return
		case <-t.C:
		}
	}
}

func (h *Hub) onMessage(m rueidis.PubSubMessage) {
	start := time.Now()
	ch, ok := redisx.ChannelName(m.Channel)
	switch {
	case !ok:
		return
	case strings.HasPrefix(ch, ctlPrefix):
		// With a namespace every instance hears all control channels: only its own is for it.
		if ch == ctlPrefix+h.instance {
			h.onControl(m.Message)
		}
		return
	case ch == "identity:invalidated":
		h.identityNotification(m.Message)
		if h.IdentityInvalidated != nil {
			h.IdentityInvalidated()
		}
		return
	case strings.HasPrefix(ch, events.RevokedPrefix):
		if sid, err := uuid.Parse(strings.TrimPrefix(ch, events.RevokedPrefix)); err == nil {
			reason := revokedCloseReason(m.Message)
			for _, s := range h.sessionsWhere(func(s *Session) bool { return s.asess == sid }) {
				go h.destroy(s, 4010, reason) // Redis/DB work off the fan-out path
			}
		}
		return
	case !strings.HasPrefix(ch, events.WorkspacePrefix) && !strings.HasPrefix(ch, events.UserPrefix):
		return // another channel of the namespace (plans:changed, …)
	}
	id, ev, err := events.Decode([]byte(m.Message))
	if err != nil {
		slog.Warn("gateway: bad event payload", "channel", ch, "err", err)
		return
	}
	eventsReceived.Inc()
	switch {
	case strings.HasPrefix(ch, events.WorkspacePrefix):
		if wid, err := uuid.Parse(strings.TrimPrefix(ch, events.WorkspacePrefix)); err == nil {
			h.routeWorkspace(wid, id, ev)
		}
	case strings.HasPrefix(ch, events.UserPrefix):
		if uid, err := uuid.Parse(strings.TrimPrefix(ch, events.UserPrefix)); err == nil {
			h.routeUser(uid, id, ev)
		}
	}
	fanoutSeconds.Observe(time.Since(start).Seconds())
}

func (h *Hub) sessionsWhere(pred func(*Session) bool) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []*Session
	for _, s := range h.sessions {
		if pred(s) {
			out = append(out, s)
		}
	}
	return out
}

func (h *Hub) inWorkspace(wid uuid.UUID) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Session, 0, len(h.byWS[wid]))
	for s := range h.byWS[wid] {
		out = append(out, s)
	}
	return out
}

func (h *Hub) ofUser(uid uuid.UUID) []*Session {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make([]*Session, 0, len(h.byUser[uid]))
	for s := range h.byUser[uid] {
		out = append(out, s)
	}
	return out
}

// ---- workspace state ----

// ensureState loads the workspace state synchronously (IDENTIFY / RESUME paths). false: the
// load failed and the workspace's sessions here must resync (stateFailed).
func (h *Hub) ensureState(ctx context.Context, wid uuid.UUID) bool {
	if st, created := h.placeholder(wid); created {
		return h.loadInto(ctx, st, wid)
	}
	return true
}

func (h *Hub) placeholder(wid uuid.UUID) (*wsState, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if st := h.states[wid]; st != nil {
		return st, false
	}
	st := &wsState{loading: true}
	h.states[wid] = st
	return st, true
}

func (h *Hub) loadInto(ctx context.Context, st *wsState, wid uuid.UUID) bool {
	// Who is in which call, before Postgres: VOICE_STATE_UPDATEs from now on are in the backlog.
	var inVoice map[uuid.UUID]uuid.UUID
	if h.voice.C != nil {
		var err error
		if inVoice, err = h.voice.Rooms(ctx, wid); err != nil {
			// Guests then miss the people of calls going on now (fail-closed) until they move.
			slog.Warn("gateway: voice rooms for guest visibility", "workspace", wid, "err", err)
		}
	}
	loaded, err := loadState(ctx, h.db.Q, wid)
	if err != nil {
		slog.Error("gateway: load workspace state", "workspace", wid, "err", err)
		h.stateFailed(st, wid)
		return false
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	st.ws, st.rooms, st.targets = loaded.ws, loaded.rooms, loaded.targets
	st.roleDefs, st.roleIDs, st.members = loaded.roleDefs, loaded.roleIDs, loaded.members
	st.boardState = loaded.boardState
	st.authors, st.authorsLoaded, st.voiceRoom, st.guestVis = loaded.authors, loaded.authorsLoaded, inVoice, nil
	for len(st.backlog) > 0 {
		p := st.backlog[0]
		st.backlog = st.backlog[1:]
		h.routeLocked(st, wid, p.id, p.enc.ev)
	}
	st.loading = false
	return true
}

// stateFailed handles a workspace state that could not be loaded (Postgres stall). It used
// to be kept EMPTY — no rooms, no members — so every VOICE_STATE_UPDATE of the workspace was
// filtered to "not in voice" and messages went nowhere for the sessions on this instance,
// for as long as any of them stayed connected: their room lists lost people who were in the
// call. Now the state is dropped (the next IDENTIFY loads it again) and the workspace's
// sessions here resync.
func (h *Hub) stateFailed(st *wsState, wid uuid.UUID) {
	h.mu.Lock()
	if h.states[wid] == st {
		delete(h.states, wid)
	}
	h.mu.Unlock()
	st.mu.Lock()
	st.backlog, st.loading = nil, false
	st.mu.Unlock()
	for _, s := range h.inWorkspace(wid) {
		s.requireResync("resync required")
	}
}

func (h *Hub) state(wid uuid.UUID) *wsState {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.states[wid]
}

// ---- routing ----

func (h *Hub) routeWorkspace(wid, id uuid.UUID, ev *v1.DispatchEvent) {
	st := h.state(wid)
	if st == nil {
		return // no local session in this workspace
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.loading {
		if len(st.backlog) >= bufferQueue {
			// The event is lost for the workspace's sessions here: they must resync, not
			// carry on live without it (a missed VOICE_STATE_UPDATE stays wrong until the
			// user's next change).
			for _, s := range h.inWorkspace(wid) {
				s.requireResync("resync required")
			}
			return
		}
		st.backlog = append(st.backlog, pendingEvent{id: id, enc: newEnc(ev)})
		return
	}
	h.routeLocked(st, wid, id, ev)
}

func parseID(s string) uuid.UUID {
	id, _ := uuid.Parse(s)
	return id
}

// routeLocked applies ev to the workspace state and delivers it to each local session as
// that recipient should see it. st.mu is held (write). The event is encoded once and shared
// by all recipients that get it unchanged.
func (h *Hub) routeLocked(st *wsState, wid, id uuid.UUID, ev *v1.DispatchEvent) {
	sessions := h.inWorkspace(wid)
	shared := newScopedEnc(wid, ev)
	view := func(rid, uid uuid.UUID) bool { return st.bits(rid, uid).Has(perm.ViewRoom) }
	// about(subject): deliver to everyone except guests who share no room with subject.
	about := func(subject uuid.UUID) {
		for _, s := range sessions {
			if !st.hiddenFrom(s.user, subject) {
				s.dispatchEnc(id, shared)
			}
		}
	}
	roomChange := func(rid uuid.UUID, apply func(), changed func() *v1.DispatchEvent) {
		existed := st.rooms[rid] != nil
		before := make(map[*Session]bool, len(sessions))
		for _, s := range sessions {
			before[s] = view(rid, s.user)
		}
		apply()
		room := st.rooms[rid]
		for _, s := range sessions {
			after := room != nil && view(rid, s.user)
			switch out := transition(before[s], after, changed(), room, wid, rid); {
			case out == nil:
			case out == ev:
				s.dispatchEnc(id, shared)
			case existed && out.GetRoomCreate() != nil:
				// An existing room became visible (its overrides changed): it may have a call.
				h.dispatchGained(s, wid, id, out)
			default:
				s.dispatchScoped(wid, id, out)
			}
		}
	}
	// Guests see only the people of their rooms (perm.GuestVisible); events that change rooms,
	// overrides, roles, calls or a room's authors can grow or shrink that set (review R8).
	var guestBefore map[*Session]map[uuid.UUID]bool
	subject := uuid.Nil
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		subject = parseID(e.WorkspaceMemberAdd.GetMember().GetUser().GetId())
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		subject = parseID(e.WorkspaceMemberUpdate.GetMember().GetUser().GetId())
	case *v1.DispatchEvent_WorkspaceMemberRemove:
		subject = parseID(e.WorkspaceMemberRemove.GetUserId())
	}
	if changesVisibility(st, ev) {
		for _, s := range sessions {
			if st.role(s.user) == perm.RoleGuest {
				if guestBefore == nil {
					guestBefore = map[*Session]map[uuid.UUID]bool{}
				}
				guestBefore[s] = st.guestVisible(s.user)
			}
		}
		switch ev.GetEvent().(type) {
		case *v1.DispatchEvent_VoiceStateUpdate, *v1.DispatchEvent_MessageCreate:
			// Synced around the delivery below: the person first, then the event about them.
		default:
			defer h.syncGuestMembers(st, wid, guestBefore, subject)
		}
	}
	if h.routeBoards(st, wid, id, sessions, ev) {
		return
	}
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_RoomCreate, *v1.DispatchEvent_RoomUpdate:
		_ = e
		var r *v1.Room
		if rc := ev.GetRoomCreate(); rc != nil {
			r = rc.GetRoom()
		} else {
			r = ev.GetRoomUpdate().GetRoom()
		}
		rid := parseID(r.GetId())
		roomChange(rid, func() { st.setRoom(rid, r) }, func() *v1.DispatchEvent { return ev })
	case *v1.DispatchEvent_RoomPermissionsUpdate:
		rid := parseID(e.RoomPermissionsUpdate.GetRoomId())
		if st.rooms[rid] == nil {
			return
		}
		roomChange(rid, func() { st.setRoom(rid, withPermissions(st.rooms[rid], e.RoomPermissionsUpdate.GetPermissions())) },
			func() *v1.DispatchEvent { return ev })
	case *v1.DispatchEvent_RoomDelete:
		rid := parseID(e.RoomDelete.GetRoomId())
		h.toViewers(sessions, view, rid, id, shared)
		st.delRoom(rid)
	case *v1.DispatchEvent_MessageCreate, *v1.DispatchEvent_MessageUpdate:
		var m *v1.Message
		if mc := ev.GetMessageCreate(); mc != nil {
			m = mc.GetMessage()
		} else {
			m = ev.GetMessageUpdate().GetMessage()
		}
		rid := parseID(m.GetRoomId())
		if ev.GetMessageCreate() != nil && st.rooms[rid] != nil {
			// A new author of a room becomes visible to its guests before their message.
			st.addAuthor(rid, parseID(m.GetAuthorId()))
			h.guestAdds(st, wid, guestBefore, uuid.Nil)
		}
		if cmd := m.GetCommand(); cmd != nil {
			// A bot command (ADR-0031): only the addressed bot sees Message.command.
			bot, plain := parseID(cmd.GetBotUserId()), newScopedEnc(wid, withoutCommand(ev))
			for _, s := range sessions {
				switch {
				case !view(rid, s.user):
				case s.user == bot:
					s.dispatchEnc(id, shared)
				default:
					s.dispatchEnc(id, plain)
				}
			}
			return
		}
		h.toViewers(sessions, view, rid, id, shared)
	case *v1.DispatchEvent_MessageDelete:
		h.toViewers(sessions, view, parseID(e.MessageDelete.GetRoomId()), id, shared)
	case *v1.DispatchEvent_MessageReactionAdd:
		h.toViewers(sessions, view, parseID(e.MessageReactionAdd.GetRoomId()), id, shared)
	case *v1.DispatchEvent_MessageReactionRemove:
		h.toViewers(sessions, view, parseID(e.MessageReactionRemove.GetRoomId()), id, shared)
	case *v1.DispatchEvent_VoiceStreamStart:
		h.toViewers(sessions, view, parseID(e.VoiceStreamStart.GetRoomId()), id, shared)
	case *v1.DispatchEvent_VoiceStreamStop:
		h.toViewers(sessions, view, parseID(e.VoiceStreamStop.GetRoomId()), id, shared)
	case *v1.DispatchEvent_VoiceCameraStop:
		h.toViewers(sessions, view, parseID(e.VoiceCameraStop.GetRoomId()), id, shared)
	case *v1.DispatchEvent_RoomRecording:
		h.toViewers(sessions, view, parseID(e.RoomRecording.GetRoomId()), id, shared)
	case *v1.DispatchEvent_SipCallUpdate:
		// Telephony (ADR-0046): to the room's viewers; a call without a room (a connection
		// test) is never published.
		h.toViewers(sessions, view, parseID(e.SipCallUpdate.GetCall().GetRoomId()), id, shared)
	case *v1.DispatchEvent_ReadReceipt:
		// Read receipts (docs/09 #92): to the room's viewers except the member whose own marker
		// it is (except_user_id, stripped before delivery) and bots.
		rid, except := parseID(e.ReadReceipt.GetRoomId()), parseID(e.ReadReceipt.GetExceptUserId())
		enc := newScopedEnc(wid, withoutExcept(e.ReadReceipt))
		for _, s := range sessions {
			if !s.bot && s.user != except && view(rid, s.user) {
				s.dispatchEnc(id, enc)
			}
		}
	case *v1.DispatchEvent_TypingStart:
		rid, typer := parseID(e.TypingStart.GetRoomId()), parseID(e.TypingStart.GetUserId())
		for _, s := range sessions {
			if s.user != typer && view(rid, s.user) && s.isSubscribed(rid) && !st.hiddenFrom(s.user, typer) {
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_VoiceStateUpdate:
		subject := parseID(e.VoiceStateUpdate.GetState().GetUserId())
		// Joining a guest's call makes the person visible to the guest (MEMBER_ADD first);
		// leaving may hide them again (MEMBER_REMOVE after the state that says they left).
		st.setVoice(subject, parseID(e.VoiceStateUpdate.GetState().GetRoomId()))
		h.guestAdds(st, wid, guestBefore, uuid.Nil)
		defer h.guestRemoves(st, wid, guestBefore, uuid.Nil)
		for _, s := range sessions {
			if st.hiddenFrom(s.user, subject) && !guestBefore[s][subject] {
				continue
			}
			uid := s.user
			vs := sanitizeVoice(e.VoiceStateUpdate.GetState(), func(rid uuid.UUID) bool { return view(rid, uid) })
			if vs == e.VoiceStateUpdate.GetState() {
				s.dispatchEnc(id, shared)
			} else {
				s.dispatchScoped(wid, id, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{VoiceStateUpdate: &v1.VoiceStateUpdate{State: vs}}})
			}
		}
	case *v1.DispatchEvent_PresenceUpdate:
		about(parseID(e.PresenceUpdate.GetPresence().GetUserId()))
	case *v1.DispatchEvent_UserUpdate:
		about(parseID(e.UserUpdate.GetUser().GetId()))
	case *v1.DispatchEvent_WorkspaceMemberAdd:
		m := e.WorkspaceMemberAdd.GetMember()
		uid := parseID(m.GetUser().GetId())
		if r, ok := perm.RoleFromProto(m.GetRole()); ok {
			st.setMember(uid, r, m.GetRoleIds())
		}
		st.setBot(uid, m.GetUser().GetIsBot())
		about(uid)
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		m := e.WorkspaceMemberUpdate.GetMember()
		uid := parseID(m.GetUser().GetId())
		// The member's own sessions see rooms appear / disappear with the role change.
		who := func(u uuid.UUID) bool { return u == uid }
		h.reviewRooms(st, wid, sessions, who, func() {
			h.reviewBoards(st, wid, sessions, who, func() {
				if r, ok := perm.RoleFromProto(m.GetRole()); ok {
					st.setMember(uid, r, m.GetRoleIds())
				}
				about(uid)
			})
		})
	case *v1.DispatchEvent_RoleCreate, *v1.DispatchEvent_RoleUpdate:
		r := ev.GetRoleCreate().GetRole()
		if r == nil {
			r = ev.GetRoleUpdate().GetRole()
		}
		// A role's permissions / position change what its holders see.
		all := func(uuid.UUID) bool { return true }
		h.reviewRooms(st, wid, sessions, all, func() {
			h.reviewBoards(st, wid, sessions, all, func() {
				st.setRoleDef(r)
				h.toAll(sessions, id, shared)
			})
		})
	case *v1.DispatchEvent_RoleDelete:
		all := func(uuid.UUID) bool { return true }
		h.reviewRooms(st, wid, sessions, all, func() {
			h.reviewBoards(st, wid, sessions, all, func() {
				st.delRoleDef(e.RoleDelete.GetRoleId())
				h.toAll(sessions, id, shared)
			})
		})
	case *v1.DispatchEvent_WorkspaceMemberRemove:
		uid := parseID(e.WorkspaceMemberRemove.GetUserId())
		for _, s := range sessions {
			if s.user != uid && !st.hiddenFrom(s.user, uid) {
				s.dispatchEnc(id, shared)
			}
		}
		st.delMember(uid)
	case *v1.DispatchEvent_WorkspaceUpdate:
		st.ws = e.WorkspaceUpdate.GetWorkspace()
		// The suspension reason is for the owner / admins only (item 32).
		var hidden *encEvent
		for _, s := range sessions {
			if pbconv.SeesSuspensionReason(st.role(s.user)) || st.ws.GetSuspension().GetReason() == "" {
				s.dispatchEnc(id, shared)
				continue
			}
			if hidden == nil {
				hidden = newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{
					WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: pbconv.ForViewer(st.ws, "")}}})
			}
			s.dispatchEnc(id, hidden)
		}
	case *v1.DispatchEvent_BotCreate, *v1.DispatchEvent_BotUpdate, *v1.DispatchEvent_BotDelete:
		// Bots (ADR-0031) are managed by MANAGE_BOTS members (ADR-0048); the owner of a bot sees its
		// events too (the owner's own devices also get BOT_UPDATE on the user channel).
		owner := parseID(ev.GetBotCreate().GetBot().GetOwnerUserId())
		if b := ev.GetBotUpdate().GetBot(); b != nil {
			owner = parseID(b.GetOwnerUserId())
		}
		for _, s := range sessions {
			if (st.members[s.user].Workspace().Has(perm.ManageBots) && st.role(s.user) != perm.RoleGuest) || (owner != uuid.Nil && s.user == owner) {
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_WorkspaceAppUpsert, *v1.DispatchEvent_WorkspaceAppDelete:
		// Web apps (ADR-0050): every member except guests and bots.
		for _, s := range sessions {
			if !s.bot && st.role(s.user) != perm.RoleGuest {
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_WorkspaceBanAdd, *v1.DispatchEvent_WorkspaceBanRemove:
		// Bans are shown to those who manage members (item 32; MANAGE_MEMBERS, ADR-0048).
		for _, s := range sessions {
			if st.members[s.user].Workspace().Has(perm.ManageMembers) && st.role(s.user) != perm.RoleGuest { // as REST (requireBit)
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_WorkspaceDelete:
		h.toAll(sessions, id, shared)
		for _, s := range sessions {
			h.leaveWorkspace(s, wid)
		}
	case *v1.DispatchEvent_EventCreate, *v1.DispatchEvent_EventUpdate, *v1.DispatchEvent_EventDelete,
		*v1.DispatchEvent_EventRsvp, *v1.DispatchEvent_RoomEventActive, *v1.DispatchEvent_RoomEventEnded:
		h.routeCalendar(st, sessions, view, id, ev)
	case *v1.DispatchEvent_RoomAdmissionRequest:
		// A knock (ADR-0040 §3, amendment 2026-10-06): only to the author of the link the guest
		// came by and to deciders (INVITE_GUESTS there, not guests) who are in the room's voice
		// right now — never to every INVITE_GUESTS member of the workspace (a temporary meeting
		// room's knock used to wake every administrator). knockAudience is the one rule; READY
		// (loadInto) narrows the snapshot's admissions by it too.
		a := ev.GetRoomAdmissionRequest().GetAdmission()
		rid, author := parseID(a.GetRoomId()), parseID(a.GetInviteCreatedBy())
		for _, s := range sessions {
			if knockAudience(st, rid, author, s.user) {
				s.dispatchEnc(id, shared)
			}
		}
	case *v1.DispatchEvent_RoomAdmissionDecided:
		// The outcome goes to every decider — INVITE_GUESTS in the room (not guests) or the link's
		// author — so a row they hold (READY, an earlier knock) clears; it carries no call to
		// act. The guest gets DECIDED on their user channel.
		a := ev.GetRoomAdmissionDecided().GetAdmission()
		rid, author := parseID(a.GetRoomId()), parseID(a.GetInviteCreatedBy())
		for _, s := range sessions {
			if st.role(s.user) != perm.RoleGuest && (st.bits(rid, s.user).Has(perm.InviteGuests) || (author != uuid.Nil && s.user == author)) {
				s.dispatchEnc(id, shared)
			}
		}
	default: // categories and other workspace-wide events
		h.toAll(sessions, id, shared)
	}
}

// changesVisibility reports events that may change which members a guest sees (st.mu held).
// A ROOM_UPDATE that keeps overrides and category (rename, topic, media settings) does not,
// so the common case skips the recomputation (review B2).
func changesVisibility(st *wsState, ev *v1.DispatchEvent) bool {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_VoiceStateUpdate: // a call joined, left or switched
		vs := e.VoiceStateUpdate.GetState()
		return st.voiceRoom[parseID(vs.GetUserId())] != parseID(vs.GetRoomId())
	case *v1.DispatchEvent_MessageCreate: // the first message of an author in a room
		m := e.MessageCreate.GetMessage()
		rid := parseID(m.GetRoomId())
		return st.rooms[rid] != nil && !st.isAuthor(rid, parseID(m.GetAuthorId()))
	case *v1.DispatchEvent_RoomUpdate:
		r := e.RoomUpdate.GetRoom()
		return !st.sameVisibility(parseID(r.GetId()), r)
	case *v1.DispatchEvent_RoomCreate, *v1.DispatchEvent_RoomPermissionsUpdate,
		*v1.DispatchEvent_RoomDelete, *v1.DispatchEvent_WorkspaceMemberAdd, *v1.DispatchEvent_WorkspaceMemberUpdate,
		*v1.DispatchEvent_WorkspaceMemberRemove, *v1.DispatchEvent_RoleUpdate, *v1.DispatchEvent_RoleDelete:
		return true
	}
	return false
}

// syncGuestMembers sends guests synthetic MEMBER_ADD (+ presence) for members that became
// visible and MEMBER_REMOVE for those that became hidden (st.mu held). The event's own
// subject is covered by the event itself.
func (h *Hub) syncGuestMembers(st *wsState, wid uuid.UUID, before map[*Session]map[uuid.UUID]bool, subject uuid.UUID) {
	h.guestRemoves(st, wid, before, subject)
	h.guestAdds(st, wid, before, subject)
}

// guestRemoves sends MEMBER_REMOVE for the members hidden since before (st.mu held).
func (h *Hub) guestRemoves(st *wsState, wid uuid.UUID, before map[*Session]map[uuid.UUID]bool, subject uuid.UUID) {
	for s, was := range before {
		now := st.guestVisible(s.user)
		for u := range was {
			if !now[u] && u != subject && u != s.user {
				s.dispatchScoped(wid, uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
					WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: wid.String(), UserId: u.String()}}})
			}
		}
	}
}

// guestAdds sends synthetic MEMBER_ADD (+ presence) for the members visible since before
// (st.mu held). Member profiles — and the message authors of a room the guest just gained
// (admission, a new link) — are loaded off the fan-out path; the guest's session is paused
// meanwhile to keep order.
func (h *Hub) guestAdds(st *wsState, wid uuid.UUID, before map[*Session]map[uuid.UUID]bool, subject uuid.UUID) {
	for s, was := range before {
		now := st.guestVisible(s.user)
		var added []uuid.UUID
		for u := range now {
			if !was[u] && u != subject {
				added = append(added, u)
			}
		}
		unloaded := st.unloadedGuestRooms(s.user)
		if len(added) == 0 && len(unloaded) == 0 {
			continue
		}
		marker := s.pause()
		if !h.prepareAsync(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if len(unloaded) > 0 {
				rows, err := h.db.Q.ListRoomAuthors(ctx, unloaded)
				if err != nil { // fail closed: the authors stay hidden
					slog.WarnContext(ctx, "gateway: authors of a guest's room", "workspace", wid, "err", err)
				} else {
					st.mu.Lock()
					st.loadedAuthors(unloaded, rows)
					for u := range st.guestVisible(s.user) {
						if !was[u] && u != subject && !now[u] {
							added = append(added, u)
						}
					}
					st.mu.Unlock()
				}
			}
			var evs []pendingEvent
			pres, _ := h.pres.get(ctx, added)
			for _, u := range added {
				row, err := h.db.Q.GetMemberWithUser(ctx, sqlc.GetMemberWithUserParams{WorkspaceID: wid, UserID: u})
				if err != nil {
					continue
				}
				evs = append(evs, pendingEvent{id: uuid.New(), enc: newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{
					WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: pbconv.Member(row.WorkspaceMember, row.User, row.RoleIds)}}})})
				if p := pres[u]; p != nil {
					evs = append(evs, pendingEvent{id: uuid.New(), enc: newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{
						PresenceUpdate: &v1.PresenceUpdate{Presence: p}}})})
				}
			}
			s.resumeMany(marker, evs)
		}) {
			s.preparationFailed(marker)
		}
	}
}

// reviewRooms runs apply (which delivers the event) and then sends the sessions of users
// matching who ROOM_CREATE / ROOM_DELETE for rooms they gained / lost with it (st.mu held):
// member role changes and role permission / order / deletion (ADR-0026).
func (h *Hub) reviewRooms(st *wsState, wid uuid.UUID, sessions []*Session, who func(uuid.UUID) bool, apply func()) {
	before := map[uuid.UUID]map[uuid.UUID]bool{}
	for _, s := range sessions {
		if !who(s.user) || before[s.user] != nil {
			continue
		}
		v := make(map[uuid.UUID]bool, len(st.rooms))
		for rid := range st.rooms {
			v[rid] = st.bits(rid, s.user).Has(perm.ViewRoom)
		}
		before[s.user] = v
	}
	apply()
	after := map[uuid.UUID]map[uuid.UUID]bool{}
	for _, s := range sessions {
		was := before[s.user]
		if was == nil {
			continue
		}
		now := after[s.user]
		if now == nil {
			now = make(map[uuid.UUID]bool, len(st.rooms))
			for rid := range st.rooms {
				now[rid] = st.bits(rid, s.user).Has(perm.ViewRoom)
			}
			after[s.user] = now
		}
		for rid, room := range st.rooms {
			switch out := transition(was[rid], now[rid], nil, room, wid, rid); {
			case out == nil:
			case out.GetRoomCreate() != nil:
				h.dispatchGained(s, wid, uuid.New(), out)
			default:
				s.dispatchScoped(wid, uuid.New(), out)
			}
		}
	}
}

// dispatchGained delivers the ROOM_CREATE of an existing room that became visible to s with a
// role or override change (st.mu held). A voice room may have a call going that s knew nothing
// about (its voice states were sanitized away): the call start and the participants' voice
// states are read from Redis off the fan-out path while s is paused (order kept, like
// syncGuestMembers) and follow the ROOM_CREATE. On a Redis error the room still arrives.
func (h *Hub) dispatchGained(s *Session, wid, id uuid.UUID, out *v1.DispatchEvent) {
	room := out.GetRoomCreate().GetRoom()
	if room.GetType() != v1.RoomType_ROOM_TYPE_VOICE {
		s.dispatchScoped(wid, id, out)
		return
	}
	marker := s.pauseEvent(id)
	if marker == nil {
		return
	}
	if !h.prepareAsync(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		rid := parseID(room.GetId())
		r := proto.Clone(room).(*v1.Room)
		if started, err := h.voice.StartedAt(ctx, []uuid.UUID{rid}); err == nil {
			r.VoiceStartedAt = nil
			if t, ok := started[rid]; ok {
				r.VoiceStartedAt = timestamppb.New(t)
			}
		}
		evs := []pendingEvent{{id: id, enc: newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomCreate{RoomCreate: &v1.RoomCreate{Room: r}}})}}
		states, err := h.voice.States(ctx, wid)
		if err != nil {
			// The room would arrive without the people in its call: resync instead.
			slog.WarnContext(ctx, "gateway: voice states of a gained room", "room", rid, "err", err)
			s.preparationFailed(marker)
			return
		}
		for _, vs := range states {
			if vs.GetRoomId() == room.GetId() {
				evs = append(evs, pendingEvent{id: uuid.New(), enc: newScopedEnc(wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{
					VoiceStateUpdate: &v1.VoiceStateUpdate{State: vs}}})})
			}
		}
		s.resumeMany(marker, evs)
	}) {
		s.preparationFailed(marker)
	}
}

func (h *Hub) toAll(sessions []*Session, id uuid.UUID, enc *encEvent) {
	for _, s := range sessions {
		s.dispatchEnc(id, enc)
	}
}

func (h *Hub) toViewers(sessions []*Session, view func(rid, uid uuid.UUID) bool, rid, id uuid.UUID, enc *encEvent) {
	for _, s := range sessions {
		if view(rid, s.user) {
			s.dispatchEnc(id, enc)
		}
	}
}

func (h *Hub) routeUser(uid, id uuid.UUID, ev *v1.DispatchEvent) {
	sessions := h.ofUser(uid)
	if len(sessions) == 0 {
		return
	}
	if gone := ev.GetWorkspaceDelete(); gone != nil {
		enc := newEnc(ev)
		for _, s := range sessions {
			s.dispatchEnc(id, enc)
			h.leaveWorkspace(s, parseID(gone.GetWorkspaceId()))
		}
		return
	}
	if status := ev.GetWorkspaceIdentityAccessUpdate(); status != nil {
		enc := newEnc(ev)
		for _, s := range sessions {
			s.dispatchEnc(id, enc)
		}
		return
	}
	if dm := ev.GetDmCreate(); dm != nil {
		for _, s := range sessions {
			s.rememberDM(parseID(dm.GetDm().GetRoom().GetId()), parseID(dm.GetDm().GetPeer().GetId()))
		}
	}
	if message := ev.GetMessageCreate(); message != nil {
		if cmd := message.GetMessage().GetCommand(); cmd != nil && parseID(cmd.GetBotUserId()) != uid {
			ev = withoutCommand(ev)
		}
	}
	if read := ev.GetReadReceipt(); read != nil {
		ev = withoutExcept(read)
		filtered := make([]*Session, 0, len(sessions))
		for _, s := range sessions {
			if !s.bot {
				filtered = append(filtered, s)
			}
		}
		sessions = filtered
	}
	if typing := ev.GetTypingStart(); typing != nil {
		filtered := make([]*Session, 0, len(sessions))
		for _, s := range sessions {
			if s.user != parseID(typing.GetUserId()) && s.isSubscribed(parseID(typing.GetRoomId())) {
				filtered = append(filtered, s)
			}
		}
		sessions = filtered
	}
	markers := make([]*pauseMark, 0, len(sessions))
	recipients := make([]*Session, 0, len(sessions))
	for _, s := range sessions {
		if created := ev.GetWorkspaceCreate(); created != nil && !s.bot && s.principal.Authority != identitypolicy.LocalAccount && s.principal.WorkspaceID != parseID(created.GetSnapshot().GetWorkspace().GetId()) {
			continue
		}
		if mark := s.pauseEvent(id); mark != nil {
			markers = append(markers, mark)
			recipients = append(recipients, s)
		}
	}
	sessions = recipients
	if len(sessions) == 0 {
		return
	}
	var preparingState *wsState
	loadPreparingState := false
	if created := ev.GetWorkspaceCreate(); created != nil {
		wid := parseID(created.GetSnapshot().GetWorkspace().GetId())
		// Subscribe provisionally while paused so post-snapshot workspace events enter
		// the bounded backlog. No content is emitted until the exact device lease warms.
		for _, s := range sessions {
			h.joinWorkspace(s, wid)
		}
		preparingState, loadPreparingState = h.placeholder(wid)
	}
	// The sentinel is installed at arrival, before async attribution: concurrent
	// workspace events remain behind it, regardless of preparation completion order.
	if !h.prepareAsync(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		enc := newEnc(ev)
		if created := ev.GetWorkspaceCreate(); created != nil {
			snap := created.GetSnapshot()
			wid := parseID(snap.GetWorkspace().GetId())
			if err := h.fillLive(ctx, wid, uid, snap); err != nil {
				slog.Warn("gateway: workspace snapshot", "workspace", wid, "err", err)
				if loadPreparingState {
					h.stateFailed(preparingState, wid)
				}
				for i, s := range sessions {
					s.preparationFailed(markers[i])
				}
				return
			}
			enc = newScopedEnc(wid, ev)
			for _, s := range sessions {
				if !s.bot {
					_, _ = s.refreshWorkspaceLease(ctx, wid)
				}
				if s.bot || s.allowsWorkspace(ctx, wid) {
					h.joinWorkspace(s, wid)
				} else {
					h.leaveWorkspace(s, wid)
				}
			}
			if loadPreparingState {
				h.loadInto(ctx, preparingState, wid)
			}
		} else {
			h.prepareEvent(ctx, enc)
		}
		for i, s := range sessions {
			recipient := enc
			if ev.GetRoomAdmissionDecided() != nil {
				recipient = newEnc(ev)
				h.prepareEvent(ctx, recipient)
				s.prepareAdmissionReceipts(ctx, recipient)
			}
			if s.identityEnabled() {
				if err := s.prepareEventLeases(ctx, recipient); err != nil {
					if errors.Is(err, identitypolicy.ErrDenied) {
						s.resumeMany(markers[i], nil)
					} else {
						s.preparationFailed(markers[i])
					}
					continue
				}
			}
			s.resume(markers[i], id, recipient)
		}
	}) {
		for i, s := range sessions {
			s.preparationFailed(markers[i])
		}
	}
}

// fillLive adds Redis-backed parts (voice states, presences, call start times) to user's
// snapshot. Only members listed in the snapshot are included (guests see a filtered list),
// plus, for a guest, the people in the calls of its rooms (perm.GuestVisible).
//
// The voice states are required: a snapshot without them shows every call empty until each
// person in it changes something, so a Redis error fails the snapshot (the caller retries or
// makes the client resync). Presences and call start times stay best-effort.
func (h *Hub) fillLive(ctx context.Context, wid, user uuid.UUID, snap *v1.WorkspaceSnapshot) error {
	visible := map[uuid.UUID]bool{}
	var voiceRooms []uuid.UUID
	for _, r := range snap.GetRooms() {
		id := parseID(r.GetId())
		visible[id] = true
		if r.GetType() == v1.RoomType_ROOM_TYPE_VOICE {
			voiceRooms = append(voiceRooms, id)
		}
	}
	if started, err := h.voice.StartedAt(ctx, voiceRooms); err == nil {
		for _, r := range snap.GetRooms() {
			if t, ok := started[parseID(r.GetId())]; ok {
				r.VoiceStartedAt = timestamppb.New(t)
			}
		}
	}
	members := map[string]bool{}
	users := make([]uuid.UUID, 0, len(snap.GetMembers()))
	for _, m := range snap.GetMembers() {
		members[m.GetUser().GetId()] = true
		users = append(users, parseID(m.GetUser().GetId()))
	}
	guest := snap.GetRole() == v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	if guest {
		h.ensureGuestAuthors(ctx, wid, user)
	}
	states, err := h.voice.States(ctx, wid)
	if err != nil {
		return fmt.Errorf("voice states of workspace %s: %w", wid, err)
	}
	snap.VoiceStates = nil
	for _, vs := range states {
		if !guest || members[vs.GetUserId()] || !visible[parseID(vs.GetRoomId())] {
			continue // only a guest's snapshot lacks people (those in its calls)
		}
		row, err := h.db.Q.GetMemberWithUser(ctx, sqlc.GetMemberWithUserParams{WorkspaceID: wid, UserID: parseID(vs.GetUserId())})
		if err != nil {
			continue // not a member (any more): stays hidden
		}
		snap.Members = append(snap.Members, pbconv.Member(row.WorkspaceMember, row.User, row.RoleIds))
		members[vs.GetUserId()] = true
		users = append(users, row.User.ID)
	}
	for _, vs := range states {
		if members[vs.GetUserId()] {
			snap.VoiceStates = append(snap.VoiceStates, sanitizeVoice(vs, func(rid uuid.UUID) bool { return visible[rid] }))
		}
	}
	if pres, err := h.pres.get(ctx, users); err == nil {
		snap.Presences = nil
		for _, u := range users {
			snap.Presences = append(snap.Presences, pres[u])
		}
	}
	return nil
}

// ensureGuestAuthors loads the message authors of the guest's rooms into the workspace state
// when they are not there yet (a guest's room gained while no guest of it was connected), so
// that events about them reach the guest as its snapshot promised.
func (h *Hub) ensureGuestAuthors(ctx context.Context, wid, guest uuid.UUID) {
	st := h.state(wid)
	if st == nil {
		return // loaded later with the guest's rooms (loadState)
	}
	st.mu.Lock()
	var missing []uuid.UUID
	if !st.loading {
		missing = st.unloadedGuestRooms(guest)
	}
	st.mu.Unlock()
	if len(missing) == 0 {
		return
	}
	rows, err := h.db.Q.ListRoomAuthors(ctx, missing)
	if err != nil {
		slog.WarnContext(ctx, "gateway: authors of a guest's rooms", "workspace", wid, "err", err)
		return
	}
	st.mu.Lock()
	st.loadedAuthors(missing, rows)
	st.mu.Unlock()
}

// ---- session registry ----

func (h *Hub) register(s *Session, workspaces []uuid.UUID) {
	if h.auth != nil && !s.bot {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		s.refreshSessionLease(ctx)
		for _, ws := range workspaces {
			_, _ = s.refreshWorkspaceLease(ctx, ws)
		}
		cancel()
	}
	h.mu.Lock()
	h.sessions[s.id] = s
	if h.byUser[s.user] == nil {
		h.byUser[s.user] = map[*Session]bool{}
	}
	h.byUser[s.user][s] = true
	h.mu.Unlock()
	for _, wid := range workspaces {
		if h.auth != nil && !s.bot && !s.allowsWorkspace(context.Background(), wid) {
			continue
		}
		h.joinWorkspace(s, wid)
	}
	sessionsGauge.Set(float64(h.count()))
}

func (h *Hub) count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.sessions)
}

func (h *Hub) joinWorkspace(s *Session, wid uuid.UUID) {
	h.mu.Lock()
	if h.byWS[wid] == nil {
		h.byWS[wid] = map[*Session]bool{}
	}
	h.byWS[wid][s] = true
	h.mu.Unlock()
	s.mu.Lock()
	s.workspaces[wid] = true
	s.mu.Unlock()
}

func (h *Hub) leaveWorkspace(s *Session, wid uuid.UUID) {
	s.leases.mu.Lock()
	delete(s.leases.workspaces, wid)
	s.leases.revision++
	s.leases.mu.Unlock()
	h.mu.Lock()
	delete(h.byWS[wid], s)
	if len(h.byWS[wid]) == 0 {
		delete(h.byWS, wid)
		delete(h.states, wid)
	}
	h.mu.Unlock()
	s.mu.Lock()
	delete(s.workspaces, wid)
	s.mu.Unlock()
}

// unregister removes the session from this instance (Redis state is left to the caller).
func (h *Hub) unregister(s *Session) {
	s.mu.Lock()
	wss := make([]uuid.UUID, 0, len(s.workspaces))
	for w := range s.workspaces {
		wss = append(wss, w)
	}
	s.mu.Unlock()
	for _, w := range wss {
		h.leaveWorkspace(s, w)
	}
	h.mu.Lock()
	if h.sessions[s.id] == s {
		delete(h.sessions, s.id)
	}
	delete(h.byUser[s.user], s)
	if len(h.byUser[s.user]) == 0 {
		delete(h.byUser, s.user)
	}
	h.mu.Unlock()
	sessionsGauge.Set(float64(h.count()))
}

// destroy ends a session for good (not resumable). code 0 = no socket close frame.
func (h *Hub) destroy(s *Session, code int, why string) {
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return
	}
	s.dead = true
	c := s.conn
	s.conn = nil
	if s.detachT != nil {
		s.detachT.Stop()
	}
	s.mu.Unlock()
	if c != nil {
		h.sockets(-1)
		if code != 0 {
			c.closeGraceful(statusCode(code), why)
		} else {
			c.closeNow(4000, why)
		}
	}
	h.unregister(s)
	s.closeQueue()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	h.buf.drop(ctx, s.id)
	h.forgetDevice(ctx, s)
	_ = h.pres.remove(ctx, s.user, s.id)
	h.publishPresence(ctx, s.user)
}

// invalidateAll forces every client to IDENTIFY again (used after a pub/sub gap).
func (h *Hub) invalidateAll() {
	for _, s := range h.sessionsWhere(func(*Session) bool { return true }) {
		s.mu.Lock()
		c := s.conn
		s.mu.Unlock()
		if c != nil {
			c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_InvalidSession{InvalidSession: &v1.InvalidSession{Resumable: false}}})
		}
		h.destroy(s, 4000, "resync required")
	}
}

// ---- presence ----

// TouchBot keeps a bot that works over REST only (webhook bots) online (ADR-0031): its
// token id acts as one presence session, expiring like a silent gateway session (2 ×
// heartbeat), so the sweeper announces OFFLINE after the bot goes quiet. Throttled to one
// write per half heartbeat per bot and instance; runs in the background.
func (h *Hub) TouchBot(_ context.Context, id auth.Identity) {
	now := time.Now()
	if v, ok := h.botSeen.Load(id.UserID); ok && now.Sub(v.(time.Time)) < h.cfg.HeartbeatInterval/2 { //nolint:forcetypeassert // only times are stored
		return
	}
	h.botSeen.Store(id.UserID, now)
	go func() { //nolint:gosec // G118: presence outlives the request that reported it
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := h.pres.set(ctx, id.UserID, id.SessionID, v1.PresenceStatus_PRESENCE_STATUS_ONLINE, clientInfo{}); err != nil {
			return
		}
		h.publishPresence(ctx, id.UserID)
	}()
}

func (h *Hub) publishPresence(ctx context.Context, user uuid.UUID) {
	h.announcePresence(ctx, user, false)
}

// PresenceChanged announces the user's presence if it changed, e.g. Presence.on_call when a
// one-to-one call is answered or ends (internal/calls).
func (h *Hub) PresenceChanged(ctx context.Context, user uuid.UUID) {
	h.announcePresence(context.WithoutCancel(ctx), user, false)
}

// Statuses returns users' aggregated presence status (as others see it; a manual DND
// included), e.g. meeting reminders that respect DND (ADR-0038 §5).
func (h *Hub) Statuses(ctx context.Context, users []uuid.UUID) (map[uuid.UUID]v1.PresenceStatus, error) {
	ps, err := h.pres.get(ctx, users)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]v1.PresenceStatus, len(ps))
	for u, p := range ps {
		out[u] = p.GetStatus()
	}
	return out, nil
}

// StatusChanged announces a custom status change (PATCH /api/me/status) even if the
// online status did not change.
func (h *Hub) StatusChanged(ctx context.Context, user uuid.UUID) {
	h.announcePresence(context.WithoutCancel(ctx), user, true)
}

func (h *Hub) announcePresence(ctx context.Context, user uuid.UUID, force bool) {
	ps, err := h.pres.get(ctx, []uuid.UUID{user})
	if err != nil {
		return
	}
	p := ps[user]
	changed, err := h.pres.changed(ctx, p)
	if err != nil || (!changed && !force) {
		return
	}
	if u, err := h.db.Q.GetUser(ctx, user); err == nil {
		p.StatusText, p.StatusEmoji, p.StatusExpiresAt = pbconv.Status(u)
	}
	wids, err := h.db.Q.ListUserWorkspaceIDs(ctx, user)
	if err != nil || len(wids) == 0 {
		return
	}
	h.pub.Workspaces(ctx, wids, &v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{PresenceUpdate: &v1.PresenceUpdate{Presence: p}}})
}

// sweepPresence publishes OFFLINE for users whose sessions expired without a clean close
// (crash, network loss). One instance per period does it.
func (h *Hub) sweepPresence(ctx context.Context) {
	t := time.NewTicker(15 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		lock := h.redis.B().Set().Key(redisx.Key("gw:presence:sweep")).Value(h.instance).Nx().Ex(14 * time.Second).Build()
		if h.redis.Do(ctx, lock).Error() != nil {
			continue
		}
		h.expireManual(ctx)
		h.expireCustomStatuses(ctx)
		users, err := h.pres.stale(ctx)
		if err != nil {
			continue
		}
		for _, u := range users {
			h.publishPresence(ctx, u)
		}
	}
}

// expireManual ends manual statuses whose time is up: back to ONLINE on all devices, and a
// PRESENCE_UPDATE to the user's workspaces (docs/05 «Presence»).
func (h *Hub) expireManual(ctx context.Context) {
	rows, err := h.db.Q.ExpireManualPresence(ctx)
	if err != nil {
		slog.Warn("gateway: expire manual presence", "err", err)
		return
	}
	for _, r := range rows {
		ended := manualStatus{status: v1.PresenceStatus(*r.PresenceStatus)} //nolint:gosec // small enum
		if r.PresenceUntil != nil {
			ended.until = *r.PresenceUntil
		}
		_ = h.pres.dropManual(ctx, r.ID, ended)
		h.manualChanged(ctx, r.ID, manualStatus{})
	}
}

// expireCustomStatuses clears temporary custom statuses whose time is up (docs/05
// «Presence», issue #17): USER_UPDATE {me} to the owner's devices and {user} to the
// workspaces (as PATCH /api/me/status does), and a PRESENCE_UPDATE with the empty status.
func (h *Hub) expireCustomStatuses(ctx context.Context) {
	users, err := h.db.Q.ExpireCustomStatuses(ctx)
	if err != nil {
		slog.Warn("gateway: expire custom statuses", "err", err)
		return
	}
	for _, u := range users {
		profile.Publish(ctx, h.db.Q, h.pub, u, true)
		h.announcePresence(ctx, u.ID, true)
	}
}

// restoreManual copies live manual statuses from Postgres into Valkey (after a Valkey
// restart or flush); keys already there are kept.
func (h *Hub) restoreManual(ctx context.Context) {
	rows, err := h.db.Q.ListManualPresence(ctx)
	if err != nil {
		slog.Warn("gateway: restore manual presence", "err", err)
		return
	}
	now := time.Now()
	for _, r := range rows {
		if m := manualFromDB(r.PresenceStatus, r.PresenceUntil, now); m.status != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
			_ = h.pres.restoreManual(ctx, r.ID, m)
		}
	}
}

// ---- control messages between instances ----

func (h *Hub) sendControl(ctx context.Context, instance, msg string) {
	_ = h.redis.Do(ctx, h.redis.B().Publish().Channel(ctlChannel(instance)).Message(msg).Build()).Error()
}

func (h *Hub) onControl(msg string) {
	f := strings.Fields(msg)
	if len(f) < 2 {
		return
	}
	gsid := parseID(f[1])
	switch f[0] {
	case "release": // another instance resumes this session: stop owning it
		h.mu.RLock()
		s := h.sessions[gsid]
		h.mu.RUnlock()
		go func() {
			// Confirm only a session that was live here and is now flushed: a session that
			// was already released (shutdown) or destroyed has an unbuffered gap (review R2).
			if s != nil && h.release(s, "resumed elsewhere", false) && len(f) > 2 {
				h.sendControl(context.Background(), f[2], "released "+gsid.String())
			}
		}()
	case "released":
		h.mu.Lock()
		ch := h.releases[gsid]
		delete(h.releases, gsid)
		h.mu.Unlock()
		if ch != nil {
			close(ch)
		}
	case "kill", "evict":
		h.mu.RLock()
		s := h.sessions[gsid]
		h.mu.RUnlock()
		if s != nil {
			code, why := killClose(f[0] == "evict")
			go h.destroy(s, code, why)
		}
	}
}

// release hands a session over to another instance: stop dispatching, flush the buffer,
// forget it locally without touching Redis state. graceful lets already queued frames
// (e.g. RECONNECT) reach the client before the close.
func (h *Hub) release(s *Session, why string, graceful bool) bool {
	s.mu.Lock()
	if s.dead {
		s.mu.Unlock()
		return false
	}
	s.dead = true
	c := s.conn
	s.conn = nil
	if s.detachT != nil {
		s.detachT.Stop()
	}
	s.mu.Unlock()
	if c != nil {
		h.sockets(-1)
		if graceful {
			c.closeGraceful(4000, why)
		} else {
			c.closeNow(4000, why)
		}
	}
	h.unregister(s)
	s.flush()
	s.closeQueue()
	return !s.broken.Load()
}

// Shutdown asks every client to reconnect (spread over cfg.ShutdownSpread to avoid a
// thundering herd). Events published after a session is released are not buffered by
// anyone, so its RESUME gets INVALID_SESSION and the client re-IDENTIFYs (no silent loss).
func (h *Hub) Shutdown(ctx context.Context) {
	h.closing.Store(true)
	all := h.sessionsWhere(func(*Session) bool { return true })
	var wg sync.WaitGroup
	for _, s := range all {
		wg.Add(1)
		delay := time.Duration(0)
		if h.cfg.ShutdownSpread > 0 {
			delay = time.Duration(rand.Int64N(int64(h.cfg.ShutdownSpread))) //nolint:gosec // jitter
		}
		go func() {
			defer wg.Done()
			select {
			case <-time.After(delay):
			case <-ctx.Done():
			}
			s.mu.Lock()
			c := s.conn
			s.mu.Unlock()
			if c != nil {
				c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_Reconnect{Reconnect: &v1.Reconnect{}}})
			}
			// Owner "" first = released without a successor: a RESUME elsewhere, even one
			// racing this shutdown, is answered with INVALID_SESSION (H1, review R2).
			_ = h.buf.setOwner(context.WithoutCancel(ctx), s.id, "")
			h.release(s, "server restart", true)
		}()
	}
	wg.Wait()
}

// withoutCommand returns a MESSAGE_CREATE without Message.command (ADR-0031): what everyone
// but the addressed bot gets.
// withoutExcept is a READ_RECEIPT as clients get it: without the internal except_user_id.
func withoutExcept(pr *v1.PeerRead) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadReceipt{ReadReceipt: &v1.PeerRead{RoomId: pr.GetRoomId(), LastReadMessageId: pr.GetLastReadMessageId()}}}
}

func withoutCommand(ev *v1.DispatchEvent) *v1.DispatchEvent {
	mc := ev.GetMessageCreate()
	m := proto.CloneOf(mc.GetMessage())
	m.Command = nil
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{WorkspaceId: mc.GetWorkspaceId(), Message: m}}}
}
