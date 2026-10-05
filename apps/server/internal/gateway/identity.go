package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/workspaces"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func newScopedEnc(ws uuid.UUID, ev *v1.DispatchEvent) *encEvent {
	return &encEvent{ev: ev, workspace: ws}
}
func (s *Session) dispatchScoped(ws, id uuid.UUID, ev *v1.DispatchEvent) {
	s.dispatchEnc(id, newScopedEnc(ws, ev))
}
func (s *Session) identityEnabled() bool {
	return s.hub != nil && (s.hub.auth != nil || s.hub.checkWorkspace != nil)
}
func (s *Session) identity() auth.Identity {
	return auth.Identity{UserID: s.user, SessionID: s.asess, IsBot: s.bot, Principal: s.principal}
}

func (s *Session) allowsWorkspace(_ context.Context, ws uuid.UUID) bool {
	if s.bot {
		return true
	}
	return s.sessionLeaseAllows() && s.workspaceLeaseAllows(ws)
}

// eventResources extracts durable parent references, including nested task notifications
// and room move tokens. User-channel delivery never assumes all sessions share authority.
func (h *Hub) eventResources(ctx context.Context, ev *v1.DispatchEvent) (map[uuid.UUID]bool, bool) {
	workspaces := map[uuid.UUID]bool{}
	valid := true
	resolved := map[string]uuid.UUID{}
	var visit func(protoreflect.Message)
	visit = func(m protoreflect.Message) {
		m.Range(func(f protoreflect.FieldDescriptor, v protoreflect.Value) bool {
			if !valid || ctx.Err() != nil {
				valid = false
				return false
			}
			if f.IsMap() {
				if f.MapValue().Kind() == protoreflect.MessageKind {
					v.Map().Range(func(_ protoreflect.MapKey, value protoreflect.Value) bool { visit(value.Message()); return valid })
				}
				return valid
			}
			if f.IsList() {
				if f.Kind() == protoreflect.MessageKind {
					list := v.List()
					for i := 0; i < list.Len() && valid; i++ {
						visit(list.Get(i).Message())
					}
				}
				return true
			}
			if f.Kind() == protoreflect.MessageKind {
				visit(v.Message())
				return true
			}
			if f.Kind() != protoreflect.StringKind || v.String() == "" {
				return true
			}
			name := string(f.Name())
			kind := string(m.Descriptor().Name())
			if name == "id" {
				switch kind {
				case "Workspace":
					name = "workspace_id"
				case "Room":
					name = "room_id"
				case "Board":
					name = "board_id"
				case "Task":
					name = "task_id"
				}
			}
			if name != "workspace_id" && name != "room_id" && name != "board_id" && name != "task_id" {
				return true
			}
			id, err := uuid.Parse(v.String())
			if err != nil || id == uuid.Nil {
				valid = false
				return true
			}
			key := name + ":" + id.String()
			if ws, ok := resolved[key]; ok {
				workspaces[ws] = true
				return true
			}
			if len(resolved) >= 128 {
				valid = false
				return false
			}
			ws := uuid.Nil
			switch name {
			case "workspace_id":
				ws = id
			case "room_id":
				row, e := h.db.Q.GetRoom(ctx, id)
				if e != nil {
					valid = false
				} else if row.WorkspaceID != nil {
					ws = *row.WorkspaceID
				}
			case "board_id":
				row, e := h.db.Q.GetBoard(ctx, id)
				if e != nil {
					valid = false
				} else {
					ws = row.WorkspaceID
				}
			case "task_id":
				row, e := h.db.Q.GetTaskRow(ctx, id)
				if e != nil {
					valid = false
				} else {
					board, e := h.db.Q.GetBoard(ctx, row.BoardID)
					if e != nil {
						valid = false
					} else {
						ws = board.WorkspaceID
					}
				}
			}
			resolved[key] = ws
			workspaces[ws] = true
			return true
		})
	}
	visit(ev.ProtoReflect())
	return workspaces, valid
}

// allowsEvent is memory-only, including when called under workspace/session locks.
// Scope attribution is immutable and prepared before fan-out; unknown events deny.
func (s *Session) allowsEvent(enc *encEvent) bool {
	if enc == nil || enc.ev == nil || enc.ev.GetEvent() == nil {
		return false
	}
	if s.bot {
		if enc.workspace == uuid.Nil && (ownReceipt(enc.ev.GetRoomAdmissionDecided().GetAdmission()) || len(enc.ev.GetReady().GetPendingAdmissions()) > 0) {
			return false
		}
		return true
	} // existing machine route and viewer gates remain mandatory
	if !s.sessionLeaseAllows() {
		return false
	}
	ev := enc.ev
	if enc.workspace == uuid.Nil && ownReceipt(ev.GetRoomAdmissionDecided().GetAdmission()) {
		return s.allowsAdmissionReceipt(enc, ev.GetRoomAdmissionDecided().GetAdmission())
	}
	if gone := ev.GetWorkspaceDelete(); gone != nil {
		ws := parseID(gone.GetWorkspaceId())
		return ws != uuid.Nil && (s.principal.Authority == identitypolicy.LocalAccount || s.principal.WorkspaceID == ws)
	}
	if status := ev.GetWorkspaceIdentityAccessUpdate(); status != nil {
		return status.GetSessionId() == s.asess.String()
	}
	if ev.GetResumed() != nil {
		return true
	}
	if ready := ev.GetReady(); ready != nil {
		if s.principal.Authority == identitypolicy.Recovery {
			return false
		}
		for _, snap := range ready.Workspaces {
			if !s.workspaceLeaseAllows(parseID(snap.GetWorkspace().GetId())) {
				return false
			}
		}
		for _, receipt := range ready.PendingAdmissions {
			if !s.allowsAdmissionReceipt(enc, receipt) {
				return false
			}
		}
		return true
	}
	if enc.workspace != uuid.Nil {
		return knownScopedEvent(ev) && s.workspaceLeaseAllows(enc.workspace)
	}
	if !enc.scoped {
		return false
	}
	for _, ws := range enc.scopes {
		if ws == uuid.Nil {
			if s.principal.Authority != identitypolicy.LocalAccount || !ownProfileOrPresence(s.user, ev) {
				return false
			}
		} else if !s.workspaceLeaseAllows(ws) {
			return false
		}
	}
	return len(enc.scopes) > 0
}

// ownProfileOrPresence: a profile/presence event without workspace attribution (user
// channel) may only be about the recipient. Another person's profile or presence goes
// through a shared workspace's lease, so it never bypasses that workspace's policy.
func ownProfileOrPresence(user uuid.UUID, ev *v1.DispatchEvent) bool {
	if p := ev.GetPresenceUpdate(); p != nil {
		return parseID(p.GetPresence().GetUserId()) == user
	}
	if u := ev.GetUserUpdate(); u != nil && u.GetUser() != nil {
		return parseID(u.GetUser().GetId()) == user
	}
	return true
}

// eventScope classifies every DispatchEvent variant by name. workspaceScoped variants may
// travel as workspace-attributed events (lease-gated by that workspace); unscoped ones are
// delivered only through their own explicit allowsEvent/prepareEvent paths. A variant
// missing from this list is denied when workspace-attributed; TestEventScopeClassified
// fails until a new oneof field is classified here.
var eventScope = map[protoreflect.Name]bool{
	"ready": false, "resumed": false, "dm_create": false, "dm_state_update": false,
	"call_ring": false, "call_state": false, "notes_create": false, "notes_update": false,
	"notes_delete": false, "bot_callback": false, "workspace_identity_access_update": false,

	"workspace_create": true, "workspace_update": true, "workspace_delete": true,
	"workspace_member_add": true, "workspace_member_update": true, "workspace_member_remove": true,
	"room_create": true, "room_update": true, "room_delete": true, "room_permissions_update": true,
	"message_create": true, "message_update": true, "message_delete": true, "typing_start": true,
	"presence_update": true, "voice_state_update": true, "voice_stream_start": true,
	"voice_stream_stop": true, "read_state_update": true, "user_update": true,
	"category_create": true, "category_update": true, "category_delete": true,
	"message_reaction_add": true, "message_reaction_remove": true, "voice_moved": true,
	"room_notification_update": true, "voice_camera_stop": true, "workspace_notification_update": true,
	"room_recording": true, "workspace_ban_add": true, "workspace_ban_remove": true,
	"role_create": true, "role_update": true, "role_delete": true,
	"sticker_pack_create": true, "sticker_pack_update": true, "sticker_pack_delete": true,
	"badge_create": true, "badge_update": true, "badge_delete": true, "read_receipt": true,
	"background_create": true, "background_update": true, "background_delete": true,
	"voice_disconnected": true, "sound_create": true, "sound_update": true, "sound_delete": true,
	"sound_play": true, "bot_create": true, "bot_update": true, "bot_delete": true,
	"event_create": true, "event_update": true, "event_delete": true, "event_rsvp": true,
	"event_reminder": true, "room_event_active": true, "room_event_ended": true,
	"room_admission_request": true, "room_admission_decided": true,
	"board_create": true, "board_update": true, "board_delete": true,
	"task_create": true, "task_update": true, "task_delete": true, "task_activity": true,
	"sip_call_update": true, "workspace_app_upsert": true, "workspace_app_delete": true,
	// Boards 2.0 (ADR-0058): workspace channel; routed by routeBoards (members without guests /
	// the board's viewers).
	"board_category_create": true, "board_category_update": true, "board_category_delete": true,
	"task_checklist_update": true, "task_checklist_delete": true,
	// Automations (ADR-0060): workspace channel; routed by routeBoards (the board's viewers;
	// Git links also to the task's invitees).
	"board_rule_update": true, "board_rule_delete": true, "task_git_links_update": true,
	// Achievement catalogs (ADR-0061, amendment 1): workspace channel, every member.
	"workspace_achievements_update": true,
}

// knownScopedEvent: the variant is explicitly classified as workspace-scoped; an absent
// or unclassified oneof denies.
func knownScopedEvent(ev *v1.DispatchEvent) bool {
	m := ev.ProtoReflect()
	f := m.WhichOneof(m.Descriptor().Oneofs().ByName("event"))
	return f != nil && eventScope[f.Name()]
}

// prepareEvent resolves resource parents once, outside all gateway locks. Its result is
// shared by recipients and remains attached through pauses and the socket write queue.
func (h *Hub) prepareEvent(ctx context.Context, enc *encEvent) {
	if enc.workspace != uuid.Nil || enc.ev.GetReady() != nil || enc.ev.GetResumed() != nil || enc.ev.GetWorkspaceDelete() != nil || enc.ev.GetWorkspaceIdentityAccessUpdate() != nil {
		return
	}
	if ownReceipt(enc.ev.GetRoomAdmissionDecided().GetAdmission()) {
		return // recipient preparation checks only the narrow receipt's durable policy
	}
	// These two local deletion/departure signals carry no surviving resource to
	// resolve. Only their explicit variants qualify, never arbitrary missing IDs.
	if gone := enc.ev.GetNotesDelete(); gone != nil {
		if parseID(gone.GetRoomId()) != uuid.Nil {
			enc.scopes, enc.scoped = []uuid.UUID{uuid.Nil}, true
		}
		return
	}
	if state := enc.ev.GetVoiceStateUpdate().GetState(); state != nil && state.GetRoomId() == "" && state.GetWorkspaceId() == "" {
		if parseID(state.GetUserId()) != uuid.Nil {
			enc.scopes, enc.scoped = []uuid.UUID{uuid.Nil}, true
		}
		return
	}
	scopes, valid := h.eventResources(ctx, enc.ev)
	if !valid {
		return
	}
	if len(scopes) == 0 {
		switch enc.ev.GetEvent().(type) {
		case *v1.DispatchEvent_UserUpdate, *v1.DispatchEvent_PresenceUpdate,
			*v1.DispatchEvent_CallRing, *v1.DispatchEvent_CallState,
			*v1.DispatchEvent_NotesCreate, *v1.DispatchEvent_NotesUpdate, *v1.DispatchEvent_NotesDelete,
			*v1.DispatchEvent_BotCreate, *v1.DispatchEvent_BotUpdate, *v1.DispatchEvent_BotDelete:
			scopes[uuid.Nil] = true
		case *v1.DispatchEvent_EventReminder:
			// A reminder of the user's own imported CalDAV event (ADR-0045 amendment 3): personal,
			// like notes. A meeting's reminder always resolves its workspace above.
			if r := enc.ev.GetEventReminder(); r.GetEvent() == nil && r.GetExternalEvent() != nil {
				scopes[uuid.Nil] = true
			} else {
				return
			}
		default:
			return
		}
	}
	for ws := range scopes {
		enc.scopes = append(enc.scopes, ws)
	}
	enc.scoped = true
}

// replayAllowed revalidates every stored event, retaining sequence continuity only when
// the entire replay is allowed. A denied event forces a filtered fresh READY.
func (s *Session) replayAllowed(es []entry) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.bot {
		s.refreshSessionLease(ctx)
	}
	checked := map[uuid.UUID]bool{}
	for i, e := range es {
		if !e.identityFormat {
			return false
		} // pre-identity buffers cannot prove their source scope
		var frame v1.GatewayFrame
		if proto.Unmarshal(e.frame, &frame) != nil || frame.GetDispatch() == nil {
			return false
		}
		enc := newScopedEnc(e.workspace, frame.GetDispatch())
		if s.bot {
			es[i].enc = enc
			continue
		}
		s.hub.prepareEvent(ctx, enc)
		s.prepareAdmissionReceipts(ctx, enc)
		scopes := append([]uuid.UUID{enc.workspace}, enc.scopes...)
		if ready := enc.ev.GetReady(); ready != nil {
			for _, snap := range ready.Workspaces {
				scopes = append(scopes, parseID(snap.GetWorkspace().GetId()))
			}
		}
		for _, ws := range scopes {
			if ws != uuid.Nil && !checked[ws] {
				_, _ = s.refreshWorkspaceLease(ctx, ws)
				checked[ws] = true
			}
		}
		if !s.allowsEvent(enc) {
			return false
		}
		es[i].enc = enc
	}
	return true
}

// EnforceIdentity reconciles subscriptions and sends only a content-free removal/status
// when access is lost. It works without pubsub and never closes unrelated workspace B.
func (h *Hub) EnforceIdentity(ctx context.Context) {
	h.identityRun.Lock()
	defer h.identityRun.Unlock()
	sessions := h.sessionsWhere(func(s *Session) bool { return !s.bot })
	slices.SortFunc(sessions, func(a, b *Session) int { return bytes.Compare(a.id[:], b.id[:]) })
	offset := 0
	for offset < len(sessions) && bytes.Compare(sessions[offset].id[:], h.identityCursor[:]) <= 0 {
		offset++
	}
	if offset == len(sessions) {
		offset = 0
	}

	jobs := make(chan *Session)
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for s := range jobs {
				h.enforceIdentitySession(ctx, s)
			}
		}()
	}
scheduling:
	for i := range sessions {
		s := sessions[(offset+i)%len(sessions)]
		select {
		case jobs <- s:
			h.identityCursor = s.id
		case <-ctx.Done():
			break scheduling
		}
	}
	close(jobs)
	workers.Wait()
}
func (h *Hub) enforceIdentitySession(ctx context.Context, s *Session) {
	ctx, done := context.WithTimeout(ctx, 3*time.Second)
	defer done()
	sessionCtx, sessionCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	s.refreshSessionLease(sessionCtx)
	sessionCancel()
	query, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	var ids []uuid.UUID
	var err error
	if h.identityWorkspaces != nil {
		ids, err = h.identityWorkspaces(query, s.user)
	} else {
		ids, err = h.db.Q.ListUserWorkspaceIDs(query, s.user)
	}
	cancel()
	if err != nil {
		// A failed membership read says nothing about access (incident 2026-10-05: a slow
		// DB removed every workspace from every client). Keep the leases; they expire on
		// their own (ReadLeaseTTL), and the next pass retries.
		return
	}
	s.mu.Lock()
	old := make(map[uuid.UUID]bool, len(s.workspaces))
	for ws := range s.workspaces {
		old[ws] = true
	}
	s.mu.Unlock()
	present := map[uuid.UUID]bool{}
	for _, ws := range ids {
		present[ws] = true
	}
	if err == nil {
		s.leases.mu.Lock()
		for ws := range s.leases.workspaces {
			if !present[ws] {
				delete(s.leases.workspaces, ws)
			}
		}
		s.leases.mu.Unlock()
	}
	for ws := range old {
		if !present[ws] {
			h.identityRemoveWorkspace(s, ws, identitypolicy.Decision{Reason: identitypolicy.MembershipRequired}, err)
		}
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	due, probes := s.dueWorkspaceChecks(ids, old)
	allowed := map[uuid.UUID]identitypolicy.Decision{}
	check := func(ws uuid.UUID) {
		gate, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		decision, err := s.refreshWorkspaceLease(gate, ws)
		cancel()
		if err == nil && decision.Allowed && s.workspaceLeaseAllows(ws) {
			allowed[ws] = decision
		} else if old[ws] && (!identityTransient(decision, err) || !s.workspaceLeaseAllows(ws)) {
			// A transient failure keeps a still-valid lease (incident 2026-10-05).
			h.identityRemoveWorkspace(s, ws, decision, err)
		}
	}
	for i := 0; i < len(due) && ctx.Err() == nil; i++ {
		check(due[i])
	}
	// Rotation persists across canceled passes, so a slow first workspace cannot
	// repeatedly starve the tail of the probes.
	for i := 0; i < len(probes) && ctx.Err() == nil; i++ {
		check(probes[i])
		s.leases.mu.Lock()
		s.leases.cursor = probes[i]
		s.leases.mu.Unlock()
	}
	for ws, decision := range allowed {
		if old[ws] {
			continue
		}
		// A new assurance can open just this workspace without reauthenticating B.
		row, err := h.db.Q.GetWorkspace(ctx, ws)
		if err != nil {
			continue
		}
		member, err := perm.NewResolver(h.db.Q).Member(ctx, ws, s.user)
		if err != nil {
			continue
		}
		snap, err := workspaces.Snapshot(ctx, h.db.Q, h.cfg.Plans, row, s.user, member)
		if err != nil {
			continue
		}
		access := identityAccessStatus(ws, decision, nil, s.principal)
		if policy, e := h.db.Q.GetIdentityPolicy(ctx, ws); e == nil {
			access.Mode = identityMode(policy.Mode)
		} else if db.IsNotFound(e) {
			access.Mode = v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF
		}
		snap.Workspace.IdentityAccess = access
		if err := h.fillLive(ctx, ws, s.user, snap); err != nil {
			continue // re-added by a later pass, with the people in its calls
		}
		h.joinWorkspace(s, ws)
		if !h.ensureState(ctx, ws) {
			return // stateFailed made the session resync
		}
		// The access status first: the client may hold a stale lock for this workspace
		// (an earlier denial) that would otherwise drop its events after the snapshot.
		s.dispatch(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceIdentityAccessUpdate{WorkspaceIdentityAccessUpdate: &v1.WorkspaceIdentityAccessUpdate{SessionId: s.asess.String(), Access: access}}})
		s.dispatchScoped(ws, uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceCreate{WorkspaceCreate: &v1.WorkspaceCreate{Snapshot: snap}}})
	}
}

const (
	identityPass = 5 * time.Second // runIdentityEnforcement period
	// identityRefreshAhead: a lease is re-evaluated once it has less than this left, so
	// each one gets about three passes to be refreshed before it lapses.
	identityRefreshAhead = identitypolicy.ReadLeaseTTL / 2
	// identityProbes bounds the per-pass checks of workspaces the session holds no lease
	// for (SSO required, suspended, left out of READY): a step-up is noticed within
	// ⌈n/4⌉ passes without a DB query per such workspace per pass.
	identityProbes = 4
)

// dueWorkspaceChecks splits the session's workspaces into lease re-evaluations and probes.
// due: subscribed workspaces whose lease is missing or expires within identityRefreshAhead
// (earliest deadline first) and leased-but-undelivered ones, up to max(4, ⌈2N·pass/horizon⌉)
// per pass, which covers all N within the horizon; fresh leases cost no query, so DB load
// follows lease expiry (about one check per workspace per lease), not the pass rate.
// probes: unsubscribed workspaces without a lease, at most identityProbes, rotating from
// the cursor.
func (s *Session) dueWorkspaceChecks(ids []uuid.UUID, subscribed map[uuid.UUID]bool) (due, probes []uuid.UUID) {
	now := time.Now()
	s.leases.mu.Lock()
	cursor := s.leases.cursor
	offset := 0
	for offset < len(ids) && bytes.Compare(ids[offset][:], cursor[:]) <= 0 {
		offset++
	}
	type candidate struct {
		ws    uuid.UUID
		until time.Time
	}
	refresh := make([]candidate, 0, len(ids))
	for i := range ids {
		ws := ids[(offset+i)%len(ids)]
		l := s.leases.workspaces[ws]
		until := time.Time{}
		if s.validLease(l, ws) {
			until = l.until
		}
		switch {
		case !subscribed[ws] && until.IsZero():
			if len(probes) < identityProbes {
				probes = append(probes, ws)
			}
		case !subscribed[ws]:
			refresh = append(refresh, candidate{ws, time.Time{}}) // leased, not delivered: re-add now
		case until.IsZero() || until.Sub(now) <= identityRefreshAhead:
			refresh = append(refresh, candidate{ws, until})
		}
	}
	s.leases.mu.Unlock()
	slices.SortStableFunc(refresh, func(a, b candidate) int { return a.until.Compare(b.until) })
	budget := max(4, (2*len(ids)*int(identityPass)+int(identityRefreshAhead)-1)/int(identityRefreshAhead))
	due = make([]uuid.UUID, 0, min(len(refresh), budget))
	for _, c := range refresh[:min(len(refresh), budget)] {
		due = append(due, c.ws)
	}
	return due, probes
}

// identityTransient reports a failed evaluation that says nothing about access (dependency
// failure, timeout, connection error) as opposed to a decision (4xx, a policy denial, a
// revoked session, a missing row). The stored lease is kept and expires on its own
// (ReadLeaseTTL), so an outage longer than the lease still fails closed; a definitive denial
// acts at once. Incident 2026-10-05: the RTC sweep had the same shape (fixed in 2.3.4).
func identityTransient(d identitypolicy.Decision, err error) bool {
	if err != nil {
		return !httpx.IsDenial(err) && !errors.Is(err, identitypolicy.ErrDenied) && !errors.Is(err, auth.ErrSessionRevoked) && !db.IsNotFound(err)
	}
	return d.Reason == identitypolicy.StateUnavailable
}

func (h *Hub) identityRemoveWorkspace(s *Session, ws uuid.UUID, d identitypolicy.Decision, err error) {
	s.dispatch(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: ws.String()}}})
	s.dispatch(uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceIdentityAccessUpdate{WorkspaceIdentityAccessUpdate: &v1.WorkspaceIdentityAccessUpdate{SessionId: s.asess.String(), Access: identityAccessStatus(ws, d, err, s.principal)}}})
	h.leaveWorkspace(s, ws)
}

func (h *Hub) runIdentityEnforcement(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-h.identityWake:
		}
		{
			work, cancel := context.WithTimeout(ctx, 20*time.Second)
			h.EnforceIdentity(work)
			cancel()
		}
	}
}

// IdentityChanged coalesces durable, versioned invalidations into a fresh DB reconciliation.
// No positive lease is extended by a notification, including stale or duplicate delivery.
func (h *Hub) IdentityChanged() {
	select {
	case h.identityWake <- struct{}{}:
	default:
	}
}

// Notifications carry only workspace policy/access versions. Stale/duplicate
// versions do not alter deadlines; other epochs require fresh DB reconciliation.
func (h *Hub) identityNotification(payload string) {
	var notice struct {
		Workspace uuid.UUID `json:"workspace"`
		User      *string   `json:"user"` // absent: legacy publisher, access applies to everyone
		Policy    int64     `json:"policy_version"`
		Access    int64     `json:"access_version"`
	}
	if json.Unmarshal([]byte(payload), &notice) == nil && notice.Workspace != uuid.Nil {
		// access_version is per (workspace, user): comparing user A's version with B's
		// lease would tombstone B at a version B's own row never reaches, so B could not
		// re-lease until reconnect (READY/events closed, spurious WORKSPACE_DELETE).
		// Policy is workspace-wide and applies to every session of the workspace.
		accessFor := func(s *Session) int64 {
			if notice.User == nil || *notice.User == s.user.String() {
				return notice.Access
			}
			return 0
		}
		// Receipts can outlive membership and have no byWS subscription. Only
		// actually prepared receipts of this workspace track monotonic invalidations.
		for _, s := range h.sessionsWhere(func(s *Session) bool { return !s.bot }) {
			s.leases.mu.Lock()
			for ws, state := range s.leases.receipts {
				if !time.Now().Before(state.until) {
					delete(s.leases.receipts, ws)
				}
			}
			access := accessFor(s)
			state, ok := s.leases.receipts[notice.Workspace]
			if ok && (notice.Policy > state.policy || access > state.access) {
				state.policy = max(state.policy, notice.Policy)
				state.access = max(state.access, access)
				state.epoch++
				s.leases.receipts[notice.Workspace] = state
			}
			s.leases.mu.Unlock()
		}
		for _, s := range h.inWorkspace(notice.Workspace) {
			access := accessFor(s)
			s.leases.mu.Lock()
			l := s.leases.workspaces[notice.Workspace]
			if notice.Policy > l.versions.Policy || access > l.versions.Access {
				l.until = time.Time{}
				l.versions.Policy = max(l.versions.Policy, notice.Policy)
				l.versions.Access = max(l.versions.Access, access)
				if l.session != uuid.Nil {
					s.leases.workspaces[notice.Workspace] = l
				}
				s.leases.revision++
			}
			s.leases.mu.Unlock()
		}
	}
	h.IdentityChanged()
}

func identityAccessStatus(ws uuid.UUID, d identitypolicy.Decision, err error, p identitypolicy.Principal) *v1.WorkspaceIdentityAccess {
	reason := v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SCOPE_DENIED
	switch d.Reason {
	case identitypolicy.Allowed:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_ALLOWED
	case identitypolicy.SSORequired:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SSO_REQUIRED
	case identitypolicy.EntitlementRequired:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_ENTITLEMENT_REQUIRED
	case identitypolicy.DirectoryStale, identitypolicy.MembershipSuspended:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_DIRECTORY_DENIED
	case identitypolicy.WorkspaceSuspended:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SUSPENDED
	case identitypolicy.RecentAuthRequired:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_RECENT_AUTH_REQUIRED
	case identitypolicy.StateUnavailable:
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_DEPENDENCY_UNAVAILABLE
	}
	if err != nil && !errors.Is(err, identitypolicy.ErrDenied) {
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_DEPENDENCY_UNAVAILABLE
	}
	if p.Authority == identitypolicy.Recovery {
		reason = v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_RECOVERY_ONLY
	}
	out := &v1.WorkspaceIdentityAccess{WorkspaceId: ws.String(), Reason: reason, PolicyVersion: uint64(max(d.Versions.Policy, 0)), MembershipVersion: uint64(max(d.Versions.Access, 0))}
	if !d.ValidUntil.IsZero() {
		out.ValidUntil = timestamppb.New(d.ValidUntil)
	}
	return out
}

func identityMode(mode string) v1.IdentityPolicyMode {
	switch identitypolicy.Mode(mode) {
	case identitypolicy.Off:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_OFF
	case identitypolicy.Optional:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_OPTIONAL
	case identitypolicy.Enforced:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED
	default:
		return v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_UNSPECIFIED
	}
}
