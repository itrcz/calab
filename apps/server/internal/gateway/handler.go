package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/guests"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/notes"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/workspaces"
)

const (
	identifyTimeout = 30 * time.Second
	maxSubscribed   = 100
	typingInterval  = 3 * time.Second
)

func statusCode(c int) websocket.StatusCode { return websocket.StatusCode(c) } //nolint:gosec // close codes

// ServeHTTP upgrades GET /gateway to a WebSocket and runs the connection.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.closing.Load() {
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	if !OriginAllowed(r.Header.Get("Origin"), r.Header.Get("Cookie") != "", h.cfg.AllowedOrigins) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is checked above (OriginAllowed); coder/websocket's OriginPatterns cannot
		// express Electron's file:// / "null" origins.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	c := newConn(ws, codec{json: r.URL.Query().Get("encoding") == "json"})
	go c.writeLoop()
	c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_Hello{Hello: &v1.Hello{
		HeartbeatIntervalMs: uint32(h.cfg.HeartbeatInterval.Milliseconds()), //nolint:gosec // seconds-scale
	}}})
	h.serve(c)
}

// OriginAllowed decides whether a WebSocket upgrade may proceed. Authentication is the
// IDENTIFY token (never a cookie), so this is defence in depth against foreign web pages:
//   - no Origin: native clients (tests, tools) — allowed;
//   - "null" / file://: the packaged Electron renderer — allowed only without cookies (the
//     desktop never sends any; a cookie-carrying "null" origin is a sandboxed foreign page);
//   - http://localhost / 127.0.0.1 (any port): local development (Vite dev server) — allowed;
//   - otherwise the origin must be one of the web client's origins.
func OriginAllowed(origin string, hasCookie bool, allowed []string) bool {
	if origin == "" {
		return true
	}
	if origin == "null" || strings.HasPrefix(origin, "file://") {
		return !hasCookie
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1") {
		return true
	}
	return slices.Contains(allowed, strings.ToLower(origin))
}

type readResult int

const (
	readOK readResult = iota
	readTimeout
	readClosed
	readBadFrame
)

func (h *Hub) read(c *conn, timeout time.Duration) (*v1.GatewayFrame, readResult, error) {
	ctx, cancel := context.WithTimeout(c.ctx, timeout)
	defer cancel()
	typ, b, err := c.ws.Read(ctx)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && c.ctx.Err() == nil {
			return nil, readTimeout, err
		}
		return nil, readClosed, err
	}
	f, err := c.codec.decode(typ, b)
	if err != nil || f.GetOp() != opOf(f) || f.GetPayload() == nil {
		return nil, readBadFrame, err
	}
	return f, readOK, nil
}

func (h *Hub) serve(c *conn) {
	defer c.finish()
	var s *Session
	// Until IDENTIFY / RESUME succeeds only HEARTBEAT is allowed.
	for s == nil {
		f, res, _ := h.read(c, identifyTimeout)
		switch res {
		case readTimeout:
			c.closeGraceful(4003, "identify timeout")
			return
		case readClosed:
			return
		case readBadFrame:
			c.closeGraceful(4002, "decode error")
			return
		}
		switch p := f.GetPayload().(type) {
		case *v1.GatewayFrame_Heartbeat:
			c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_HeartbeatAck{HeartbeatAck: &v1.HeartbeatAck{}}})
		case *v1.GatewayFrame_Identify:
			s = h.identify(c, p.Identify)
			if s == nil {
				return
			}
		case *v1.GatewayFrame_Resume:
			var retry bool
			s, retry = h.resume(c, p.Resume)
			if s == nil && !retry {
				return
			}
		default:
			c.closeGraceful(4003, "not authenticated")
			return
		}
	}
	h.loop(c, s)
}

func (h *Hub) loop(c *conn, s *Session) {
	timeout := 2*h.cfg.HeartbeatInterval + 10*time.Second
	for {
		f, res, err := h.read(c, timeout)
		switch res {
		case readTimeout:
			h.destroy(s, 4009, "heartbeat timeout")
			return
		case readBadFrame:
			c.closeGraceful(4002, "decode error")
			s.detach(c)
			return
		case readClosed:
			if c.isServerClosed() {
				s.detach(c)
				return
			}
			switch websocket.CloseStatus(err) {
			case websocket.StatusNormalClosure, websocket.StatusGoingAway:
				h.destroy(s, 0, "client closed") // app quit / logout: not resumable, offline now
			default:
				s.detach(c) // network loss: resumable
			}
			return
		}
		ok, flood := c.inbound()
		if flood {
			c.closeGraceful(4008, "rate limited")
			s.detach(c)
			return
		}
		if !ok && !softExempt(s, f) {
			continue // over the soft budget: drop SUBSCRIBE / TYPING / repeated PRESENCE, keep the socket
		}
		switch p := f.GetPayload().(type) {
		case *v1.GatewayFrame_Heartbeat:
			c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_HeartbeatAck{HeartbeatAck: &v1.HeartbeatAck{}}})
			h.touch(s)
			if h.sessionRevoked(s) {
				return
			}
		case *v1.GatewayFrame_SetPresence:
			if !s.bot && h.auth.CheckGlobal(c.ctx, s.identity(), identitypolicy.GlobalWrite) != nil {
				continue
			}
			if p.SetPresence.GetUntil() != nil {
				h.sessionActive(s)
				h.setManualPresence(s.user, p.SetPresence.GetStatus(), p.SetPresence.GetUntil())
			} else {
				h.setPresence(s, p.SetPresence.GetStatus())
			}
		case *v1.GatewayFrame_Typing:
			h.typing(s, p.Typing.GetRoomId())
		case *v1.GatewayFrame_Subscribe:
			s.setSubscribed(p.Subscribe.GetRoomIds())
		default:
			c.closeGraceful(4001, "unexpected opcode")
			s.detach(c)
			return
		}
	}
}

// authenticate validates the access token or bot token (ADR-0031); it closes the socket on
// failure.
func (h *Hub) authenticate(c *conn, token string) (auth.Identity, bool) {
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	id, err := h.auth.AuthenticateToken(ctx, token)
	switch {
	case err == nil:
		return id, true
	case errors.Is(err, auth.ErrInvalidToken):
		c.closeGraceful(4004, "authentication failed")
	case errors.Is(err, auth.ErrSessionRevoked):
		c.closeGraceful(4010, revokedCloseReason(auth.RevokedReason(err)))
	default:
		c.closeGraceful(4000, "try again")
	}
	return id, false
}

// sessionRevoked rechecks the auth session of a live socket (on its heartbeat) and closes it
// with 4010 when the session was revoked. The socket event of a revocation closes it at
// once; this catches a revocation whose marker and event were both lost (Valkey refused
// them), within sessionRecheck + a heartbeat (docs/04 «Auth»). The check is the REST one:
// a cached marker read plus at most one DB read per minute per session and instance. A
// dependency error keeps the socket (already authenticated; a Postgres blip must not drop
// every socket at once). Bot tokens have no session row: their revocation is the marker +
// event (BotTokenChanged).
func (h *Hub) sessionRevoked(s *Session) bool {
	if s.bot {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := h.auth.CheckSession(ctx, s.asess)
	switch {
	case err == nil:
		return false
	case errors.Is(err, auth.ErrSessionRevoked):
		h.destroy(s, 4010, revokedCloseReason(auth.RevokedReason(err)))
		return true
	default:
		slog.Warn("gateway: session recheck failed", "session_id", s.asess, "err", err)
		h.destroy(s, 4000, "identity dependency unavailable")
		return true
	}
}

// revokedCloseReason is the 4010 close reason: "session revoked", with ": <REASON>" when the
// reason is known (clients tell a reuse revocation from an explicit one, gateway.proto).
func revokedCloseReason(reason string) string {
	const base = "session revoked"
	if reason == "" || len(reason) > 32 || strings.ContainsFunc(reason, func(r rune) bool { return (r < 'A' || r > 'Z') && r != '_' }) {
		return base
	}
	return base + ": " + reason
}

func typingKey(r, u uuid.UUID) string {
	return redisx.Key("gw:typing:" + r.String() + ":" + u.String())
}
func expiryScore(d time.Duration) float64 { return float64(time.Now().Add(d).UnixMilli()) }

func (h *Hub) touch(s *Session) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	s.mu.Lock()
	st := s.status
	s.mu.Unlock()
	ttl := 2*h.cfg.HeartbeatInterval + resumeWindow
	_ = h.pres.set(ctx, s.user, s.id, st, s.client)
	h.buf.touch(ctx, s.id)
	h.redis.DoMulti(ctx,
		h.redis.B().Zadd().Key(deviceKey(s.user)).ScoreMember().ScoreMember(expiryScore(ttl), s.asess.String()).Build(),
		h.redis.B().Expire().Key(tabsKey(s.asess)).Seconds(int64(ttl.Seconds())).Build())
}

func (h *Hub) identify(c *conn, req *v1.Identify) *Session {
	id, ok := h.authenticate(c, req.GetToken())
	if !ok {
		return nil
	}
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	gsid := uuid.New()
	tab := validTabID(req.GetTabId())
	allowed, err := h.claimDevice(ctx, id.UserID, id.SessionID, gsid, tab)
	if err != nil {
		c.closeGraceful(4000, "try again")
		return nil
	}
	if !allowed {
		c.closeGraceful(4008, "too many active devices")
		return nil
	}
	wids, err := h.db.Q.ListUserWorkspaceIDs(ctx, id.UserID)
	if err != nil {
		c.closeGraceful(4000, "try again")
		return nil
	}
	if err := h.buf.create(ctx, gsid, id.UserID, id.SessionID, h.instance, id.IsBot, tab); err != nil {
		c.closeGraceful(4000, "try again")
		return nil
	}
	s := newSession(h, gsid, id.UserID, id.SessionID, id.IsBot)
	s.tab = tab
	s.principal = id.Principal
	s.client = newClientInfo(req.GetDevice(), time.Now())
	// Register first so that events published while READY is being built are queued.
	h.register(s, wids)
	for _, w := range wids {
		if !h.ensureState(ctx, w) {
			// No workspace state to filter its events with: try again later rather than
			// run without them (stateFailed).
			c.closeGraceful(4000, "try again")
			h.destroy(s, 4000, "try again")
			return nil
		}
	}
	_ = h.pres.set(ctx, s.user, s.id, s.status, s.client)
	ready, err := h.buildReady(ctx, s, id.UserID)
	if err != nil {
		slog.Error("gateway: build READY", "err", err)
		h.destroy(s, 4000, "try again")
		return nil
	}
	enc := newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Ready{Ready: ready}})
	s.prepareAdmissionReceipts(ctx, enc)
	filtered := ready.PendingAdmissions[:0]
	for _, receipt := range ready.PendingAdmissions {
		if s.allowsAdmissionReceipt(enc, receipt) {
			filtered = append(filtered, receipt)
		}
	}
	ready.PendingAdmissions = filtered
	s.mu.Lock()
	s.attachLocked(c)
	if s.broken.Load() {
		// Events were lost for it before its socket was attached (requireResync found no
		// socket to close): e.g. another IDENTIFY's workspace load failed and stateFailed
		// dropped the state this READY relies on. Try again rather than go live without them.
		// A requireResync after this point sees the socket and closes it.
		s.mu.Unlock()
		h.destroy(s, 4000, "try again")
		return nil
	}
	s.ready = true
	s.emit(uuid.New(), enc)
	s.flushPending(nil)
	s.mu.Unlock()
	h.publishPresence(ctx, s.user)
	return s
}

func (h *Hub) buildReady(ctx context.Context, s *Session, uid uuid.UUID) (*v1.Ready, error) {
	u, err := h.db.Q.GetUser(ctx, uid)
	if err != nil {
		return nil, err
	}
	ctx = h.auth.WithPolicy(ctx, s.identity(), identitypolicy.WorkspaceRead)
	res := perm.NewResolver(h.db.Q)
	wss, err := h.db.Q.ListUserWorkspaces(ctx, uid)
	if err != nil {
		return nil, err
	}
	me, err := pbconv.LocalMe(ctx, h.db.Q, u)
	if err != nil {
		return nil, err
	}
	ready := &v1.Ready{SessionId: s.id.String(), Me: me, PlanContact: h.cfg.PlanContact, BillingSelfServe: h.cfg.BillingSelfServe}
	if s.principal.Authority == identitypolicy.WorkspaceSSO {
		ready.Me = pbconv.ScopedMe(u)
	}
	if h.auth != nil { // nil (tests): false, the client asks as ADR-0023 says
		vs := h.auth.Verification(ctx, u)
		ready.EmailVerificationOptional, ready.EmailInvitePending = vs.Optional, vs.InvitePending
	}
	if m := manualFromDB(u.PresenceStatus, u.PresenceUntil, time.Now()); s.principal.Authority == identitypolicy.LocalAccount && m.status != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
		ready.Presence = m.self(uid)
	}
	// The user's ringing / active call (ADR-0034), so a reconnected client restores its UI.
	if s.bot || s.principal.Authority == identitypolicy.LocalAccount {
		if c, ok, err := (calls.Store{C: h.redis}).Current(ctx, uid); err != nil {
			return nil, err
		} else if ok {
			ready.Call = c.Proto()
		}
	}
	var stubs []*v1.WorkspaceSnapshot // closed for unpaid billing: appended after every fill below
	for _, w := range wss {
		var access *v1.WorkspaceIdentityAccess
		if !s.bot {
			if s.principal.Authority == identitypolicy.WorkspaceSSO && w.ID != s.principal.WorkspaceID {
				continue
			}
			decision, err := s.refreshWorkspaceLease(ctx, w.ID)
			if err == nil && decision.Allowed && !s.workspaceLeaseAllows(w.ID) {
				// Allowed but not leased (invalidations kept racing the evaluation): READY
				// filtering would close the fresh connection. Leave the workspace out and
				// unsubscribe; the identity sweep re-adds it with an access update and
				// WORKSPACE_CREATE once leased. It is pending, not denied: no access entry,
				// so the client does not lock it as "unavailable" meanwhile, and its events
				// queued while READY was built are dropped (omitWorkspace).
				h.leaveWorkspace(s, w.ID)
				s.omitWorkspace(w.ID)
				continue
			}
			access = identityAccessStatus(w.ID, decision, err, s.principal)
			if policy, e := h.db.Q.GetIdentityPolicy(ctx, w.ID); e == nil {
				access.Mode = identityMode(policy.Mode)
			} else if db.IsNotFound(e) {
				access.Mode = v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF
			}
			ready.IdentityAccess = append(ready.IdentityAccess, access)
			if billingDenied(decision, err) && s.billingStubAllows(w.ID) {
				stub, err := h.billingStub(ctx, w, uid)
				if err != nil {
					return nil, err
				}
				stubs = append(stubs, stub)
				continue
			}
			if !decision.Allowed || err != nil {
				continue
			}
		}
		me, err := res.Member(ctx, w.ID, uid)
		if err != nil {
			continue
		}
		snap, err := workspaces.Snapshot(ctx, h.db.Q, h.cfg.Plans, w, uid, me)
		if err != nil {
			return nil, err
		}
		if access != nil {
			snap.Workspace.IdentityAccess = access
		}
		if err := h.fillLive(ctx, w.ID, uid, snap); err != nil {
			return nil, err // "try again": not a READY with every call shown empty
		}
		if u.IsBot {
			snap.Apps = nil // web apps are for people (ADR-0050)
		}
		ready.Workspaces = append(ready.Workspaces, snap)
	}
	// Guest admission (ADR-0040): the recipient's own knocks, and the knocks they decide.
	if !s.bot && s.principal.Authority == identitypolicy.LocalAccount {
		if ready.PendingAdmissions, err = guests.OwnAdmissions(ctx, h.db.Q, uid); err != nil {
			return nil, err
		}
	}

	if err := guests.FillAdmissions(ctx, h.db.Q, uid, ready.Workspaces); err != nil {
		return nil, err
	}
	narrowKnocks(uid, ready.Workspaces) // the knocks they are asked to decide (knockAudience)
	// Meetings around now in the visible rooms (ADR-0038 §6): one query for all workspaces.
	if err := calendar.FillActive(ctx, h.db.Q, uid, u.IsBot, ready.Workspaces, time.Now()); err != nil {
		return nil, err
	}
	// Read state with unread / mention counts for every room the user can see now (also
	// rooms never opened: review 4 M1).
	var visible []uuid.UUID
	for _, snap := range ready.Workspaces {
		for _, r := range snap.GetRooms() {
			visible = append(visible, parseID(r.GetId()))
		}
	}
	// Direct messages (ADR-0020): their read states come with the DM list.
	if s.bot || s.principal.Authority == identitypolicy.LocalAccount {
		if ready.Dms, err = dms.List(ctx, h.db.Q, uid); err != nil {
			return nil, err
		}
	}
	dmRooms := make([]uuid.UUID, 0, len(ready.Dms))
	for _, d := range ready.Dms {
		rid := parseID(d.GetRoom().GetId())
		dmRooms = append(dmRooms, rid)
		s.rememberDM(rid, parseID(d.GetPeer().GetId()))
		ready.ReadStates = append(ready.ReadStates, d.GetReadState())
	}
	// Notes shelves (ADR-0039): people only; nothing in them is ever unread (own messages).
	if !u.IsBot && !u.IsGuest && s.principal.Authority == identitypolicy.LocalAccount {
		if ready.Notes, err = notes.List(ctx, h.db.Q, uid); err != nil {
			return nil, err
		}
	}
	rs, err := h.db.Q.ListReadStates(ctx, sqlc.ListReadStatesParams{UserID: uid, RoomIds: visible})
	if err != nil {
		return nil, err
	}
	for _, r := range rs {
		marker := "" // never read: counts start at the user's joining of the workspace
		if r.LastReadMessageID != nil {
			marker = r.LastReadMessageID.String()
		}
		ready.ReadStates = append(ready.ReadStates, &v1.ReadState{
			RoomId: r.RoomID.String(), LastReadMessageId: marker,
			UnreadCount: uint32(max(r.UnreadCount, 0)), MentionCount: uint32(max(r.MentionCount, 0)), //nolint:gosec // 0..999
		})
	}
	// Read receipts of workspace rooms (docs/09 #92); DMs have theirs in dms[].
	prs, err := h.db.Q.ListPeerReads(ctx, sqlc.ListPeerReadsParams{UserID: uid, RoomIds: visible})
	if err != nil {
		return nil, err
	}
	for _, p := range prs {
		ready.PeerReads = append(ready.PeerReads, &v1.PeerRead{RoomId: p.RoomID.String(), LastReadMessageId: p.LastReadMessageID.String()})
	}
	ns, err := h.db.Q.ListRoomNotificationSettings(ctx, sqlc.ListRoomNotificationSettingsParams{UserID: uid, RoomIds: append(visible, dmRooms...)})
	if err != nil {
		return nil, err
	}
	for _, n := range ns {
		ready.NotificationSettings = append(ready.NotificationSettings, pbconv.RoomNotificationSettings(n))
	}
	wns, err := h.db.Q.ListWorkspaceNotificationSettings(ctx, uid)
	if err != nil {
		return nil, err
	}
	for _, n := range wns {
		if !s.bot && !s.allowsWorkspace(ctx, n.WorkspaceID) {
			continue
		}
		ready.WorkspaceNotificationSettings = append(ready.WorkspaceNotificationSettings, pbconv.WorkspaceNotificationSettings(n))
	}
	// Billing stubs last, so none of the fills above (admissions, meetings, read states) adds
	// anything to them: only the workspace and the recipient's role (isBillingStub).
	ready.Workspaces = append(ready.Workspaces, stubs...)
	return ready, nil
}

// billingStub is the READY snapshot of a workspace closed for unpaid billing (ADR-0080 §8):
// workspaces.BillingStub and the recipient's role, nothing else. The caller's decision was a
// billing suspension, which comes after the membership check.
func (h *Hub) billingStub(ctx context.Context, w sqlc.Workspace, uid uuid.UUID) (*v1.WorkspaceSnapshot, error) {
	ws, err := workspaces.BillingStub(ctx, h.cfg.Plans, w)
	if err != nil {
		return nil, err
	}
	snap := &v1.WorkspaceSnapshot{Workspace: ws}
	if m, err := h.db.Q.GetMemberAccess(ctx, sqlc.GetMemberAccessParams{WorkspaceID: w.ID, UserID: uid}); err == nil {
		snap.Role = perm.Role(m.Role).Proto()
	} else if !db.IsNotFound(err) {
		return nil, err
	}
	return snap, nil
}

func (h *Hub) invalid(c *conn) {
	c.sendFrame(&v1.GatewayFrame{Payload: &v1.GatewayFrame_InvalidSession{InvalidSession: &v1.InvalidSession{Resumable: false}}})
}

// resume re-attaches a socket to an existing session and replays missed events. When
// continuity cannot be guaranteed — unknown / expired session, owner released it on
// shutdown, owner dead, or the handover was not confirmed — it answers
// INVALID_SESSION{resumable:false} and returns retry=true so the client can IDENTIFY on the
// same socket. A RESUME therefore never silently drops events (security review H1).
func (h *Hub) resume(c *conn, req *v1.Resume) (s *Session, retry bool) {
	id, ok := h.authenticate(c, req.GetToken())
	if !ok {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
	defer cancel()
	gsid, err := uuid.Parse(req.GetSessionId())
	if err != nil {
		h.invalid(c)
		return nil, true
	}
	meta, found, err := h.buf.meta(ctx, gsid)
	if err != nil || !found || meta.user != id.UserID || meta.asess != id.SessionID {
		h.invalid(c)
		return nil, true
	}
	h.mu.RLock()
	local := h.sessions[gsid]
	h.mu.RUnlock()
	if local != nil {
		ok = h.replayLocal(ctx, local, c, req.GetSeq())
	} else if local = h.takeover(ctx, gsid, meta); local != nil {
		ok = h.replayTakenOver(ctx, local, c, req.GetSeq())
	}
	if local == nil || !ok {
		if local != nil {
			// Detach this socket first so destroying the session does not close it before
			// INVALID_SESSION goes out (review R4): the client then IDENTIFYs right here.
			local.mu.Lock()
			if local.conn == c {
				local.conn = nil
				h.sockets(-1)
			}
			local.mu.Unlock()
			c.setReplay(nil)
			h.destroy(local, 0, "")
		}
		h.invalid(c)
		return nil, true
	}
	h.touch(local)
	h.reclaimTab(ctx, local)
	h.publishPresence(ctx, local.user)
	return local, false
}

// takeover moves a session from another live instance to this one. It succeeds only if
// the owner confirms the release (it has then flushed everything it dispatched into the
// buffer); events for the session arriving here meanwhile wait in the pending queue.
func (h *Hub) takeover(ctx context.Context, gsid uuid.UUID, meta sessMeta) *Session {
	if meta.owner == "" || meta.owner == h.instance {
		return nil // released on shutdown (or lost here): nobody buffered the gap
	}
	alive, err := h.redis.Do(ctx, h.redis.B().Exists().Key(instKey(meta.owner)).Build()).AsInt64()
	if err != nil || alive == 0 {
		return nil // owner crashed: its unflushed and later events are gone
	}
	wids, err := h.db.Q.ListUserWorkspaceIDs(ctx, meta.user)
	if err != nil {
		return nil
	}
	s := newSession(h, gsid, meta.user, meta.asess, meta.bot)
	s.tab = meta.tab
	if !meta.bot {
		p, err := h.auth.ResolvePrincipal(ctx, s.identity())
		if err != nil {
			s.closeQueue()
			return nil
		}
		s.principal = p
	}
	s.client = h.pres.client(ctx, meta.user, gsid)
	h.register(s, wids) // events from now on are queued (s.ready=false)
	for _, w := range wids {
		if !h.ensureState(ctx, w) {
			h.abandon(s) // the client IDENTIFYs (INVALID_SESSION) and loads it again
			return nil
		}
	}
	ch := make(chan struct{})
	h.mu.Lock()
	h.releases[gsid] = ch
	h.mu.Unlock()
	h.sendControl(ctx, meta.owner, "release "+gsid.String()+" "+h.instance)
	confirmed := false
	select {
	case <-ch:
		confirmed = true
	case <-time.After(3 * time.Second):
	case <-ctx.Done():
	}
	h.mu.Lock()
	delete(h.releases, gsid)
	h.mu.Unlock()
	if !confirmed || h.buf.setOwner(ctx, gsid, h.instance) != nil {
		h.abandon(s)
		return nil
	}
	return s
}

// abandon forgets a session that never became usable (no Redis cleanup: another instance
// or the TTL owns that).
func (h *Hub) abandon(s *Session) {
	s.mu.Lock()
	s.dead = true
	s.mu.Unlock()
	h.unregister(s)
	s.closeQueue()
}

func transcodeAll(c *conn, s *Session, es []entry) ([]outMsg, bool) {
	out := make([]outMsg, 0, len(es))
	for _, e := range es {
		typ, b, err := c.codec.transcode(e.frame)
		if err != nil {
			return nil, false
		}
		out = append(out, outMsg{typ: typ, data: b, session: s, event: e.enc})
	}
	return out, true
}

// replayLocal resumes a session owned here without holding s.mu during Redis I/O (M2):
// the socket is attached "held" (new events queue behind), the buffer is flushed and read,
// and the missed frames are released ahead of the queue.
func (h *Hub) replayLocal(ctx context.Context, s *Session, c *conn, clientSeq uint64) bool {
	c.hold()
	s.mu.Lock()
	if s.dead || s.broken.Load() {
		s.mu.Unlock()
		c.setReplay(nil)
		return false
	}
	upTo := s.seq
	s.attachLocked(c)
	s.mu.Unlock()

	s.flush() // everything up to upTo is in Redis now
	entries, err := h.buf.entries(ctx, s.id)
	if err != nil || s.broken.Load() {
		c.setReplay(nil)
		return false
	}
	missed, ok := since(entries, clientSeq, upTo)
	if !ok {
		c.setReplay(nil)
		return false
	}
	kept := missed[:0]
	for _, e := range missed {
		if e.seq <= upTo { // later frames are already queued on the socket
			kept = append(kept, e)
		}
	}
	if !s.replayAllowed(kept) {
		c.setReplay(nil)
		return false
	}
	frames, ok := transcodeAll(c, s, kept)
	if !ok {
		c.setReplay(nil)
		return false
	}
	c.setReplay(frames)
	s.mu.Lock()
	s.emit(uuid.New(), newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Resumed{Resumed: &v1.Resumed{Replayed: uint32(len(kept))}}})) //nolint:gosec // ≤ 1000
	s.mu.Unlock()
	return true
}

// replayTakenOver finishes a takeover: the released buffer is read without locks (events
// for the session wait in pending), then numbering continues and pending events follow.
func (h *Hub) replayTakenOver(ctx context.Context, s *Session, c *conn, clientSeq uint64) bool {
	meta, ok, err := h.buf.meta(ctx, s.id)
	if err != nil || !ok {
		return false
	}
	entries, err := h.buf.entries(ctx, s.id)
	if err != nil {
		return false
	}
	missed, ok := since(entries, clientSeq, meta.seq)
	if !ok {
		return false
	}
	if !s.replayAllowed(missed) {
		return false
	}
	frames, ok := transcodeAll(c, s, missed)
	if !ok {
		return false
	}
	skip := make(map[uuid.UUID]bool, len(entries))
	for _, e := range entries {
		skip[e.id] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return false
	}
	s.seq = meta.seq
	s.attachLocked(c)
	c.setReplay(frames)
	s.ready = true
	s.flushPending(skip)
	s.emit(uuid.New(), newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_Resumed{Resumed: &v1.Resumed{Replayed: uint32(len(missed))}}})) //nolint:gosec // ≤ 1000
	return true
}

// softExempt reports frames processed even over the soft inbound budget: heartbeats, and a
// PRESENCE_UPDATE that actually changes the status (review B4) — dropping it silently would
// leave the user's status wrong until the next change. Repeats are still dropped; the hard
// flood limit applies to everything.
func softExempt(s *Session, f *v1.GatewayFrame) bool {
	switch p := f.GetPayload().(type) {
	case *v1.GatewayFrame_Heartbeat:
		return true
	case *v1.GatewayFrame_SetPresence:
		if p.SetPresence.GetUntil() != nil {
			return true // a manual choice from the status menu (rare, user-initiated)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.status != p.SetPresence.GetStatus()
	}
	return false
}

func (h *Hub) setPresence(s *Session, st v1.PresenceStatus) {
	switch st {
	case v1.PresenceStatus_PRESENCE_STATUS_ONLINE, v1.PresenceStatus_PRESENCE_STATUS_IDLE,
		v1.PresenceStatus_PRESENCE_STATUS_DND, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE:
	default:
		return
	}
	s.mu.Lock()
	same := s.status == st
	s.status = st
	s.mu.Unlock()
	if same {
		return // debounce: no Redis write / broadcast for a repeated status (M3)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := h.pres.set(ctx, s.user, s.id, st, s.client); err == nil {
		h.publishPresence(ctx, s.user)
	}
}

// sessionActive ends the session's automatic AFK idle: choosing a manual status is input on
// this device. Without it a stale idle (e.g. an older client that does not report «back»
// after a manual choice) would show the user as away once the manual status is cleared.
// Nothing is published here: setManualPresence announces the new aggregate.
func (h *Hub) sessionActive(s *Session) {
	s.mu.Lock()
	idle := s.status == v1.PresenceStatus_PRESENCE_STATUS_IDLE
	if idle {
		s.status = v1.PresenceStatus_PRESENCE_STATUS_ONLINE
	}
	s.mu.Unlock()
	if !idle {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := h.pres.set(ctx, s.user, s.id, v1.PresenceStatus_PRESENCE_STATUS_ONLINE, s.client); err != nil {
		slog.Warn("gateway: session active", "err", err)
	}
}

// maxManualPresence bounds SetPresence.until (the status menu offers up to 3 days).
const maxManualPresence = 30 * 24 * time.Hour

// setManualPresence stores the user's manual status for all their devices (docs/05
// «Presence»): Postgres first (durable, read by the sweeper), then Valkey, then announces it.
// ONLINE, an unknown status or an end already past clears it.
func (h *Hub) setManualPresence(user uuid.UUID, st v1.PresenceStatus, until *timestamppb.Timestamp) {
	now := time.Now()
	var m manualStatus
	if manualAllowed(st) {
		m.status = st
		if until.GetSeconds() != 0 || until.GetNanos() != 0 {
			m.until = until.AsTime()
			if lim := now.Add(maxManualPresence); m.until.After(lim) {
				m.until = lim
			}
		}
		if !m.active(now) {
			m = manualStatus{}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	arg := sqlc.SetManualPresenceParams{ID: user}
	if m.status != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
		n := int16(m.status) //nolint:gosec // small enum
		arg.Status = &n
		if !m.until.IsZero() {
			arg.Until = &m.until
		}
	}
	if err := h.db.Q.SetManualPresence(ctx, arg); err != nil {
		slog.Warn("gateway: set manual presence", "err", err)
		return
	}
	if err := h.pres.setManual(ctx, user, m); err != nil {
		slog.Warn("gateway: set manual presence", "err", err)
	}
	h.manualChanged(ctx, user, m)
}

// manualChanged tells the user's devices their manual status (USER_UPDATE.presence) and
// everyone else the new aggregate (PRESENCE_UPDATE, if it changed).
func (h *Hub) manualChanged(ctx context.Context, user uuid.UUID, m manualStatus) {
	h.pub.User(ctx, user, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{Presence: m.self(user)}}})
	h.publishPresence(ctx, user)
}

// typing publishes TYPING_START (VIEW_ROOM + SEND_MESSAGES; at most once per 3 s per user
// and room across devices).
func (h *Hub) typing(s *Session, roomIDStr string) {
	rid, err := uuid.Parse(roomIDStr)
	if err != nil {
		return
	}
	var wid uuid.UUID
	s.mu.Lock()
	wss := make([]uuid.UUID, 0, len(s.workspaces))
	for w := range s.workspaces {
		wss = append(wss, w)
	}
	s.mu.Unlock()
	allowed := false
	for _, w := range wss {
		st := h.state(w)
		if st == nil {
			continue
		}
		st.mu.RLock()
		if st.rooms[rid] != nil {
			wid, allowed = w, st.bits(rid, s.user).Has(perm.ViewRoom|perm.SendMessages)
		}
		st.mu.RUnlock()
		if wid != uuid.Nil {
			break
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if !s.bot {
		if wid != uuid.Nil {
			if !s.allowsWorkspace(ctx, wid) {
				return
			}
		} else if h.auth.CheckGlobal(ctx, s.identity(), identitypolicy.GlobalRead) != nil {
			return
		}
	}
	// A receive lease cannot authorize publication. Bot credentials retain
	// the existing machine suspension check through the same fresh command gate.
	if wid != uuid.Nil && h.auth != nil && h.auth.CheckWorkspace(ctx, s.identity(), wid, identitypolicy.Realtime) != nil {
		return
	}
	peer := uuid.Nil
	if wid == uuid.Nil { // not a workspace room: a DM of the user? (both participants may type)
		peer = h.dmPeer(ctx, s, rid)
		allowed = peer != uuid.Nil
	}
	if !allowed {
		return
	}
	if isNil(h.redis.Do(ctx, h.redis.B().Set().Key(typingKey(rid, s.user)).Value("1").Nx().Ex(typingInterval).Build()).Error()) {
		return // rate limited
	}
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_TypingStart{TypingStart: &v1.TypingStart{
		RoomId: rid.String(), UserId: s.user.String(), Timestamp: nowTS(),
	}}}
	if peer != uuid.Nil {
		h.pub.User(ctx, peer, ev) // routeUser delivers it to the peer's sessions subscribed to the DM
		return
	}
	h.pub.Workspace(ctx, wid, ev)
}

// maxDMPeers bounds the per-session DM cache (a client may send typing for arbitrary ids).
const maxDMPeers = 1024

// dmPeer returns the other participant of DM room rid if s's user is in it, else uuid.Nil.
// Answers are cached per session (READY and DM_CREATE fill the cache; a miss asks Postgres
// once): participation never changes (ADR-0020).
func (h *Hub) dmPeer(ctx context.Context, s *Session, rid uuid.UUID) uuid.UUID {
	s.mu.Lock()
	peer, ok := s.dmPeers[rid]
	s.mu.Unlock()
	if ok {
		return peer
	}
	peer, err := h.db.Q.GetDMPeer(ctx, sqlc.GetDMPeerParams{RoomID: rid, UserID: s.user})
	if err != nil && !db.IsNotFound(err) {
		return uuid.Nil // transient: do not cache
	}
	s.rememberDM(rid, peer)
	return peer
}

// rememberDM caches a DM room's peer (uuid.Nil = not a DM of the user).
func (s *Session) rememberDM(rid, peer uuid.UUID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.dmPeers) < maxDMPeers || peer != uuid.Nil {
		s.dmPeers[rid] = peer
	}
}

func (s *Session) setSubscribed(ids []string) {
	m := map[uuid.UUID]bool{}
	for _, id := range ids {
		if r, err := uuid.Parse(id); err == nil && len(m) < maxSubscribed {
			m[r] = true
		}
	}
	s.mu.Lock()
	s.subscribed = m
	s.mu.Unlock()
}

func (s *Session) isSubscribed(rid uuid.UUID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.subscribed[rid]
}
