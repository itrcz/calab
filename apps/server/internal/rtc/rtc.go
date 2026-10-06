// Package rtc issues LiveKit tokens, enforces voice permissions and stream limits, and keeps
// voice state in sync with LiveKit via webhooks and a periodic reconcile (docs/01, docs/04).
package rtc

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/voice"
)

// Tunables (docs/01: token TTL 10 min, empty_timeout 300 s).
const (
	TokenTTL     = 10 * time.Minute
	EmptyTimeout = 300
)

// Config is the rtc part of the server config.
type Config struct {
	PublicURL       string // LIVEKIT_URL, given to clients
	APIKey, Secret  string
	MaxParticipants uint32
}

// Service implements the rtc endpoints and background sync.
type Service struct {
	cfg    Config
	db     *db.DB
	redis  rueidis.Client
	lk     LiveKit
	voice  voice.Store
	events events.Publisher
	// Revoked reports revoked auth sessions (set by the app); joins of revoked devices are kicked.
	Revoked func(ctx context.Context, sessionID uuid.UUID) (bool, error)
	// IdentityAccess verifies the exact device principal and target at the DB source.
	identityWake   chan struct{}
	IdentityAccess func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error
	// IdentityAccessRoom is IdentityAccess for several devices of one room at once, one
	// verdict per device in order (the sweep checks a room in a few statements instead of a
	// few per device). nil: the sweep calls IdentityAccess per device.
	IdentityAccessRoom func(ctx context.Context, ws, room uuid.UUID, people []IdentityKey) []error
	identitySweep      identitySweepState
	// noSFUMove is set once LiveKit answered MoveParticipant with "not implemented"
	// (open-source LiveKit): moves then go the app-level way right away (ADR-0019).
	noSFUMove atomic.Bool
	// waits: the armed expectConnect timers of this instance, session id -> *connectWait.
	waits sync.Map
	// Plans resolves workspace plan limits (ADR-0024); nil = no plan limits.
	Plans *plans.Service
	// OnEgress receives egress webhook events (meeting recording, ADR-0025); an error makes
	// LiveKit redeliver the event.
	OnEgress func(ctx context.Context, event string, info *EgressInfo) error
	// Calls gates the voice session of a DM (one-to-one calls, ADR-0034, dm.go); nil = no
	// calls: a DM cannot be joined.
	Calls CallGate
	// SIP receives the events of phone lines in rooms (telephony, ADR-0046); nil = none.
	SIP SIPHook
	// sessionsOf lists a user's device sessions (tests; nil = the sessions table, devices.go).
	sessionsOf func(ctx context.Context, uid uuid.UUID) ([]uuid.UUID, error)
}

// SetSFUMove overrides the detected move mode — tests, or ops after a LiveKit upgrade that
// adds or removes MoveParticipant: false = app-level moves (ADR-0019).
func (s *Service) SetSFUMove(supported bool) { s.noSFUMove.Store(!supported) }

// NewService wires the rtc service. ev must be the plain publisher (not the Sync decorator).
func NewService(cfg Config, d *db.DB, r rueidis.Client, lk LiveKit, ev events.Publisher) *Service {
	s := &Service{cfg: cfg, db: d, redis: r, lk: lk, voice: voice.Store{C: r}, events: ev, identityWake: make(chan struct{}, 1)}
	s.voice.OnCalls = s.publishCalls
	return s
}

// Routes registers the rtc routes. The webhook is public (signature-checked).
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/rooms/{id}/join", wrap(httpx.HandlerFunc(s.join)))
	mux.Handle("POST /api/rooms/{id}/voice/leave", wrap(httpx.HandlerFunc(s.leave)))
	mux.Handle("POST /api/rooms/{id}/stream/request", wrap(httpx.HandlerFunc(s.requestStream)))
	mux.Handle("POST /api/rooms/{id}/camera/request", wrap(httpx.HandlerFunc(s.requestCamera)))
	mux.Handle("POST /api/rooms/{id}/camera/stop", wrap(httpx.HandlerFunc(s.stopOwnCamera)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/stop-camera", wrap(httpx.HandlerFunc(s.stopMemberCamera)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/allow-camera", wrap(httpx.HandlerFunc(s.allowCamera)))
	mux.Handle("PATCH /api/voice/self", wrap(httpx.HandlerFunc(s.voiceSelf)))
	mux.Handle("PATCH /api/rooms/{id}/voice-status", wrap(httpx.HandlerFunc(s.setVoiceStatus)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/mute", wrap(httpx.HandlerFunc(s.muteMember)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/unmute", wrap(httpx.HandlerFunc(s.unmuteMember)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/disconnect", wrap(httpx.HandlerFunc(s.disconnectMember)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/stop-stream", wrap(httpx.HandlerFunc(s.stopStream)))
	mux.Handle("POST /api/rooms/{id}/voice/{userId}/move", wrap(httpx.HandlerFunc(s.moveMember)))
	mux.Handle("POST /api/rtc/webhook", httpx.HandlerFunc(s.webhook))
}

// wsRoom is a room of a workspace as the voice code needs it: DMs (no workspace) have no
// voice (ADR-0020), getRoom reports them as not found.
type wsRoom struct {
	sqlc.Room
	WorkspaceID uuid.UUID // shadows the nullable Room.WorkspaceID
	// Plan: effective limits of the workspace plan (ADR-0024); set by roomInfo only.
	Plan plans.Limits
}

func (s *Service) getRoom(ctx context.Context, roomID uuid.UUID) (wsRoom, error) {
	room, err := s.db.Q.GetRoom(ctx, roomID)
	if err != nil {
		return wsRoom{}, err
	}
	if room.WorkspaceID == nil {
		return wsRoom{}, httpx.NotFound("room")
	}
	return wsRoom{Room: room, WorkspaceID: *room.WorkspaceID}, nil
}

// roomInfo loads a live room with its effective media settings: the room's own capped by the
// workspace plan (max_stream_preset, max_streams; ADR-0024). room.Plan carries the plan limits.
func (s *Service) roomInfo(ctx context.Context, roomID uuid.UUID) (wsRoom, *v1.RoomMediaSettings, error) {
	room, err := s.getRoom(ctx, roomID)
	if err != nil {
		return room, nil, err
	}
	ws, err := s.db.Q.GetWorkspace(ctx, room.WorkspaceID)
	if err != nil {
		return room, nil, err
	}
	if s.Plans != nil {
		if room.Plan, err = s.Plans.Effective(ctx, room.WorkspaceID); err != nil {
			return room, nil, err
		}
	}
	return room, room.Plan.CapMedia(pbconv.EffectiveMedia(room.Room, pbconv.WorkspaceDefaults(ws))), nil
}

// admission is the occupancy check of a voice room: the room's user_limit (0 = none or the
// caller is exempt) and the plan's room_members (0 = none), which applies to everyone.
type admission struct{ room, plan int }

func (a admission) active() bool { return a.room > 0 || a.plan > 0 }

// admissionFor builds the check for a user joining room; exempt skips the room's user_limit
// (MOVE_MEMBERS on join, ADMINISTRATOR on moves), never the plan limit.
func admissionFor(room wsRoom, exempt bool) admission {
	a := admission{plan: int(room.Plan.RoomMembers)}
	if room.UserLimit > 0 && !exempt {
		a.room = int(room.UserLimit)
	}
	return a
}

// streamSlotFree reports whether identity may start a stream: fewer than max streams by
// other participants are active.
func (s *Service) streamSlotFree(ctx context.Context, roomID uuid.UUID, identity string, maxStreams uint32) (bool, error) {
	streams, err := s.voice.Streams(ctx, roomID)
	if err != nil {
		return false, err
	}
	n := uint32(0)
	for _, st := range streams {
		if st.Identity != identity {
			n++
		}
	}
	return n < maxStreams, nil
}

func (s *Service) displayName(ctx context.Context, wsID, userID uuid.UUID) string {
	rows, err := s.db.Q.ListMemberNames(ctx, sqlc.ListMemberNamesParams{WorkspaceID: wsID, UserIds: []uuid.UUID{userID}})
	if err != nil || len(rows) == 0 {
		return ""
	}
	name, _ := rows[0].Name.(string)
	return name
}

// join issues a LiveKit token for a voice room and records the device there at once as
// pending (optimistic join, docs/05): everyone sees the user in the room before LiveKit
// connects; participant_joined clears pending, a device that does not connect within
// connectConfirm is removed again. The user_limit check (pending devices count) and the
// write happen under the workspace voice lock. A repeated /join of a device already recorded
// in the room changes nothing. The user's other devices leave voice (joinExclusive, devices.go).
func (s *Service) join(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if acc.Notes { // a notes shelf has no voice (ADR-0039)
		return httpx.NotFound("room")
	}
	if acc.DM {
		return s.joinDM(w, r, roomID)
	}
	if !acc.Bits.Has(perm.Connect) {
		return httpx.Forbidden("CONNECT required")
	}
	room, media, err := s.roomInfo(r.Context(), roomID)
	if err != nil {
		return err
	}
	if room.Type != "voice" {
		return httpx.Validation("id", "not a voice room")
	}
	id := auth.MustFromContext(r.Context())
	identity := voice.Identity(id.UserID, id.SessionID)
	name := voice.RoomName(room.WorkspaceID, room.ID)
	adm := admissionFor(room, acc.Bits.Has(perm.MoveMembers))
	if adm.active() { // early answer without LiveKit; repeated atomically with the write below
		if err := s.admit(r.Context(), room.WorkspaceID, room.ID, id.UserID, adm); err != nil {
			return err
		}
	}
	if err := s.lk.CreateRoom(r.Context(), name, EmptyTimeout, s.cfg.MaxParticipants); err != nil {
		return httpx.Unavailable(err)
	}
	if err := s.checkIdentity(r.Context(), room.WorkspaceID, room.ID, id.UserID, id.SessionID); err != nil {
		return err
	}
	slot := false
	if acc.Bits.Has(perm.Stream) {
		if slot, err = s.streamSlotFree(r.Context(), roomID, identity, media.GetMaxStreams()); err != nil {
			return err
		}
	}
	tok, err := JoinToken(s.cfg.APIKey, s.cfg.Secret, name, identity,
		s.displayName(r.Context(), room.WorkspaceID, id.UserID), s.grant(r.Context(), room.WorkspaceID, id.UserID, acc.Bits, slot), TokenTTL)
	if err != nil {
		return err
	}
	var (
		pending  bool
		joinedAt int64
	)
	if err := s.joinExclusive(r.Context(), id.UserID, id.SessionID, func() (err error) {
		pending, joinedAt, err = s.recordPending(r.Context(), room, id.UserID, id.SessionID, adm)
		return err
	}); err != nil {
		return err
	}
	if pending {
		s.expectConnect(room.WorkspaceID, room.ID, id.UserID, id.SessionID, joinedAt)
	}
	httpx.Write(w, http.StatusOK, &v1.JoinVoiceResponse{
		Url: s.cfg.PublicURL, Token: tok, Identity: identity, Media: media,
		CanSpeak: s.canSpeak(r.Context(), room.WorkspaceID, id.UserID, acc.Bits), CanStream: slot,
		CanVideo:   acc.Bits.Has(perm.Video) && media.GetCameraLimit() > 0,
		Pending:    pending,
		PlanLimits: room.Plan.Proto(),
	})
	return nil
}

// recordPending records the device in the room as pending under the workspace voice lock
// (with the occupancy check when adm is active) and publishes the new state. A device already
// recorded in the room is left as it is: pending reports whether it still waits for its
// LiveKit connection, joinedAt identifies that wait (expectConnect). A device recorded in
// another room (switching rooms) moves here and keeps its mute / deafen / musician mode.
func (s *Service) recordPending(ctx context.Context, room wsRoom, uid, sid uuid.UUID, adm admission) (pending bool, joinedAt int64, err error) {
	var c voice.Change
	err = s.voice.WithLock(ctx, room.WorkspaceID, func() error {
		if err := s.checkIdentity(ctx, room.WorkspaceID, room.ID, uid, sid); err != nil {
			return err
		}
		if adm.active() {
			if err := s.admit(ctx, room.WorkspaceID, room.ID, uid, adm); err != nil {
				return err
			}
		}
		var err error
		c, err = s.voice.UpdateLocked(ctx, room.WorkspaceID, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
			if cur != nil && cur.RoomID == room.ID {
				pending, joinedAt = cur.Pending, cur.JoinedAt
				return cur // repeated /join: idempotent
			}
			n := voice.SessionState{RoomID: room.ID, Pending: true, JoinedAt: time.Now().UnixMilli()}
			if cur != nil {
				n.Muted, n.Deafened, n.Musician = cur.Muted, cur.Deafened, cur.Musician
			}
			pending, joinedAt = true, n.JoinedAt
			return &n
		})
		return err
	})
	if err != nil {
		return false, 0, err
	}
	s.publishVoice(ctx, room.WorkspaceID, c)
	return pending, joinedAt, nil
}

func (s *Service) requestStream(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if acc.Notes { // a notes shelf has no voice (ADR-0039)
		return httpx.NotFound("room")
	}
	if acc.DM {
		return s.requestDMMedia(w, r, roomID, true)
	}
	if !acc.Bits.Has(perm.Connect | perm.Stream) {
		return httpx.Forbidden("STREAM required")
	}
	var req v1.RequestStreamRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	room, media, err := s.roomInfo(r.Context(), roomID)
	if err != nil {
		return err
	}
	id := auth.MustFromContext(r.Context())
	identity := voice.Identity(id.UserID, id.SessionID)
	name := voice.RoomName(room.WorkspaceID, room.ID)
	if _, err := s.lk.GetParticipant(r.Context(), name, identity); err != nil {
		if IsNotFound(err) {
			return httpx.Conflict("join the voice room first")
		}
		return httpx.Unavailable(err)
	}
	free, err := s.streamSlotFree(r.Context(), roomID, identity, media.GetMaxStreams())
	if err != nil {
		return err
	}
	if !free {
		if p := room.Plan.StreamsPerRoom; p > 0 && media.GetMaxStreams() >= p { // the plan cap is what binds
			return plans.LimitError("streams in a room", uint64(p), uint64(p))
		}
		return httpx.Conflict("stream limit of the room is reached")
	}
	preset := ClampPreset(req.GetPreset(), media.GetMaxStreamPreset()) // media is capped by the plan
	if err := s.voice.ReserveStream(r.Context(), identity, preset); err != nil {
		return err
	}
	if err := s.pushGrant(r.Context(), name, identity, room.WorkspaceID, id.UserID, acc.Bits, true); err != nil {
		return httpx.Unavailable(err)
	}
	httpx.Write(w, http.StatusOK, &v1.RequestStreamResponse{Preset: preset, Fps: room.Plan.StreamFPS(preset, req.GetFps())})
	return nil
}

// serverMuted reports a moderator's mute. It fails closed (review 4 L9): if the flag
// cannot be read, the user is treated as muted and gets no microphone.
func (s *Service) serverMuted(ctx context.Context, wid, uid uuid.UUID) bool {
	sm, err := s.voice.ServerMuted(ctx, wid, uid)
	if err != nil {
		slog.WarnContext(ctx, "read server mute, treating as muted", "user", uid, "err", err)
		return true
	}
	return sm
}

// pushGrant sends a device's LiveKit permissions and re-reads the server-mute flag after
// the push: if a mute / unmute landed meanwhile, the push may have carried a stale value,
// so it is repeated with the current one (review 4 L1). Any push computed from an old flag
// is thus followed by a corrective one from the same caller.
//
// The same applies to the camera source (webcam review L1): a push that read the camera
// state before a /camera/request, or before a moderator's stop-camera, is corrected by
// re-reading it after the push.
func (s *Service) pushGrant(ctx context.Context, lkRoom, identity string, wid, uid uuid.UUID, bits perm.Bits, slot bool) error {
	if user, sid, ok := voice.ParseIdentity(identity); ok {
		ws, rid, roomOK := voice.ParseRoomName(lkRoom)
		if !roomOK || ws != wid || user != uid {
			return httpx.Forbidden("voice scope mismatch")
		}
		if err := s.checkIdentity(ctx, wid, rid, user, sid); err != nil {
			s.removeIdentities(ctx, lkRoom, []string{identity})
			return err
		}
	}
	sm, cam := s.serverMuted(ctx, wid, uid), s.cameraHeld(ctx, lkRoom, identity)
	if voice.IsDMRoomName(lkRoom) { // a call keeps its camera source (dm.go)
		return s.lk.UpdatePermission(ctx, lkRoom, identity, Grant(bits, slot, true))
	}
	for range 3 {
		b := bits
		if sm {
			b &^= perm.Speak
		}
		if err := s.lk.UpdatePermission(ctx, lkRoom, identity, Grant(b, slot, cam)); err != nil {
			return err
		}
		sm2, cam2 := s.serverMuted(ctx, wid, uid), s.cameraHeld(ctx, lkRoom, identity)
		if sm2 == sm && cam2 == cam {
			return nil
		}
		sm, cam = sm2, cam2
	}
	return nil
}

// grant is Grant for a concrete user: a server-muted user loses the microphone source, so
// the SFU itself refuses to publish or unmute a microphone track.
func (s *Service) grant(ctx context.Context, wid, uid uuid.UUID, bits perm.Bits, slot bool) Permission {
	if bits.Has(perm.Speak) && s.serverMuted(ctx, wid, uid) {
		bits &^= perm.Speak
	}
	return Grant(bits, slot, false) // the camera source comes with /camera/request
}

func (s *Service) canSpeak(ctx context.Context, wid, uid uuid.UUID, bits perm.Bits) bool {
	return bits.Has(perm.Speak) && !s.serverMuted(ctx, wid, uid)
}

func (s *Service) publishVoice(ctx context.Context, wsID uuid.UUID, c voice.Change) {
	if c.Changed() && (c.Before.GetRoomId() == wsID.String() || c.After.GetRoomId() == wsID.String()) {
		s.publishDMVoice(ctx, wsID, c) // a DM session: its scope id is the room id (dm.go)
		return
	}
	if c.Changed() {
		s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{
			VoiceStateUpdate: &v1.VoiceStateUpdate{State: c.After},
		}})
	}
}

// publishCalls runs under the workspace voice lock (voice.Store.OnCalls).
func (s *Service) publishCalls(ctx context.Context, wsID uuid.UUID, rooms []uuid.UUID) {
	for _, rid := range rooms {
		if voice.IsDM(wsID, rid) {
			continue // a DM call has no ROOM_UPDATE timer: Call.answered_at
		}
		s.publishCall(ctx, wsID, rid)
	}
}

// publishCall announces a call start or end as ROOM_UPDATE carrying voice_started_at, so
// every client counts the call timer from server time. It runs under the workspace voice
// lock, so events of one room are published in the order of the state changes; the start
// is read from Redis at that point. If Redis cannot be read nothing is published (a wrong
// "no call" would reset every client's timer); the next change or READY corrects it.
func (s *Service) publishCall(ctx context.Context, wsID, rid uuid.UUID) {
	row, err := s.db.Q.GetRoom(ctx, rid)
	if err != nil {
		return // room deleted meanwhile: ROOM_DELETE covers it
	}
	room, err := rooms.Load(ctx, s.db.Q, row)
	if err != nil {
		slog.WarnContext(ctx, "load room for call update", "room", rid, "err", err)
		return
	}
	if err := s.fillStarted(ctx, room); err != nil {
		slog.WarnContext(ctx, "read call start", "room", rid, "err", err)
		return
	}
	if room.GetVoiceStartedAt() == nil && room.GetVoiceStatus() != "" {
		// The call ended: its status line goes with it (same ROOM_UPDATE).
		if _, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) { return guarded.ClearVoiceStatus(ctx, rid) }); err != nil {
			slog.WarnContext(ctx, "clear voice status", "room", rid, "err", err)
		} else {
			room.VoiceStatus = ""
		}
	}
	s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: room}}})
}

// fillStarted sets room.voice_started_at from Redis (unset when nobody is in the call).
// On a Redis error the room is left unchanged and the error returned.
func (s *Service) fillStarted(ctx context.Context, room *v1.Room) error {
	if room.GetType() != v1.RoomType_ROOM_TYPE_VOICE {
		return nil
	}
	rid, err := uuid.Parse(room.GetId())
	if err != nil {
		return nil
	}
	started, err := s.voice.StartedAt(ctx, []uuid.UUID{rid})
	if err != nil {
		return err
	}
	room.VoiceStartedAt = nil
	if t, ok := started[rid]; ok {
		room.VoiceStartedAt = timestamppb.New(t)
	}
	return nil
}

func (s *Service) voiceSelf(w http.ResponseWriter, r *http.Request) error {
	var req v1.UpdateVoiceSelfRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	id := auth.MustFromContext(r.Context())
	wsID, roomID, ok, err := s.voice.Location(r.Context(), id.SessionID)
	if err != nil {
		return err
	}
	if !ok {
		return httpx.Conflict("not connected to a voice room")
	}
	if err := s.checkIdentity(r.Context(), wsID, roomID, id.UserID, id.SessionID); err != nil {
		return err
	}
	// Musician mode (ADR-0052) is a plan feature: Team and above (409 PLAN_LIMIT on Free).
	if req.GetMusician() {
		allowed, err := s.Plans.AllowsMusician(r.Context(), wsID, voice.IsDM(wsID, roomID), id.UserID)
		if err != nil {
			return err
		}
		if !allowed {
			return plans.FeatureError("musician mode")
		}
	}
	// The server-mute check runs inside the update, under the workspace voice lock that
	// SetServerMuted also takes: a concurrent mute cannot slip between check and write (L2).
	blocked := false
	c, err := s.voice.Update(r.Context(), wsID, id.UserID, id.SessionID, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil {
			return nil
		}
		if req.Muted != nil && !req.GetMuted() && s.serverMuted(r.Context(), wsID, id.UserID) {
			blocked = true
			return cur
		}
		n := *cur
		if req.Muted != nil {
			n.Muted = req.GetMuted()
		}
		if req.Deafened != nil {
			n.Deafened = req.GetDeafened()
		}
		if req.Musician != nil {
			n.Musician = req.GetMusician()
		}
		return &n
	})
	if err != nil {
		return err
	}
	if blocked {
		return httpx.Forbidden("muted by a moderator")
	}
	s.publishVoice(r.Context(), wsID, c)
	httpx.NoContent(w)
	return nil
}

// memberSessions returns the device sessions of userID connected to roomID.
func (s *Service) memberSessions(ctx context.Context, wsID, roomID, userID uuid.UUID) ([]voice.SessionState, error) {
	all, err := s.voice.List(ctx, wsID)
	if err != nil {
		return nil, err
	}
	var out []voice.SessionState
	for _, st := range all {
		if st.UserID == userID && st.RoomID == roomID {
			out = append(out, st)
		}
	}
	return out, nil
}

func (s *Service) moderate(r *http.Request) (wsRoom, uuid.UUID, []voice.SessionState, error) {
	room, target, sess, err := s.moderateAny(r)
	if err == nil && len(sess) == 0 {
		err = httpx.NotFound("member in this voice room")
	}
	return room, target, sess, err
}

// moderateAny checks MUTE_MEMBERS in the path room and the moderation hierarchy; the
// target's devices in that room may be none (e.g. unmute after they left).
func (s *Service) moderateAny(r *http.Request) (wsRoom, uuid.UUID, []voice.SessionState, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return wsRoom{}, uuid.Nil, nil, err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return wsRoom{}, uuid.Nil, nil, err
	}
	if !acc.Bits.Has(perm.MuteMembers) {
		return wsRoom{}, uuid.Nil, nil, httpx.Forbidden("MUTE_MEMBERS required")
	}
	target, err := httpx.PathUUID(r, "userId", "member")
	if err != nil {
		return wsRoom{}, uuid.Nil, nil, err
	}
	if err := outranks(r, acc.WorkspaceID, target); err != nil {
		return wsRoom{}, uuid.Nil, nil, err
	}
	room, err := s.getRoom(r.Context(), roomID)
	if err != nil {
		return room, target, nil, err
	}
	sess, err := s.memberSessions(r.Context(), room.WorkspaceID, roomID, target)
	if err != nil {
		return room, target, nil, err
	}
	return room, target, sess, nil
}

// muteMember server-mutes the member (VoiceState.server_muted) until a moderator unmutes:
// the microphone source is withdrawn from the grants of all their devices (LiveKit then
// refuses to publish or unmute it) and published microphone tracks are muted.
func (s *Service) muteMember(w http.ResponseWriter, r *http.Request) error {
	room, target, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
	if err := workspaceMute(r, room.WorkspaceID); err != nil {
		return err
	}
	c, err := s.voice.SetServerMuted(r.Context(), room.WorkspaceID, target, true)
	if err != nil {
		return err
	}
	s.publishVoice(r.Context(), room.WorkspaceID, c)
	s.resync(r.Context(), room.WorkspaceID, func(st voice.SessionState) bool { return st.UserID == target })
	name := voice.RoomName(room.WorkspaceID, room.ID)
	for _, st := range sess {
		identity := voice.Identity(st.UserID, st.SessionID)
		p, err := s.lk.GetParticipant(r.Context(), name, identity)
		if err != nil {
			continue
		}
		for _, t := range p.Tracks {
			if t.Source == SourceMicrophone && !t.Muted {
				if err := s.lk.MuteTrack(r.Context(), name, identity, t.Sid, true); err != nil && !IsNotFound(err) {
					return httpx.Unavailable(err)
				}
			}
		}
		c, err := s.voice.Update(r.Context(), room.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil {
				return nil
			}
			n := *cur
			n.Muted = true
			return &n
		})
		if err == nil {
			s.publishVoice(r.Context(), room.WorkspaceID, c)
		}
	}
	httpx.NoContent(w)
	return nil
}

// workspaceMute requires MUTE_MEMBERS at workspace level (owner / admin by role). A server
// mute applies in every room of the workspace, so a moderator of one room (room override)
// may not impose or lift it (review 4 L3); room moderators still disconnect / stop streams.
func workspaceMute(r *http.Request, wid uuid.UUID) error {
	bits, _, err := perm.FromContext(r.Context()).Workspace(r.Context(), wid, auth.MustFromContext(r.Context()).UserID)
	if err != nil {
		return err
	}
	if !bits.Has(perm.MuteMembers) {
		return httpx.Forbidden("MUTE_MEMBERS at workspace level required: a server mute applies to every room")
	}
	return nil
}

// unmuteMember lifts a server mute (MUTE_MEMBERS; the member cannot lift it). The
// microphone grant is restored; the member unmutes themselves.
func (s *Service) unmuteMember(w http.ResponseWriter, r *http.Request) error {
	room, target, _, err := s.moderateAny(r)
	if err != nil {
		return err
	}
	if err := workspaceMute(r, room.WorkspaceID); err != nil {
		return err
	}
	c, err := s.voice.SetServerMuted(r.Context(), room.WorkspaceID, target, false)
	if err != nil {
		return err
	}
	s.publishVoice(r.Context(), room.WorkspaceID, c)
	s.resync(r.Context(), room.WorkspaceID, func(st voice.SessionState) bool { return st.UserID == target })
	httpx.NoContent(w)
	return nil
}

// stopStream stops the member's screen shares on all devices: tracks are muted server-side,
// the screen share grant is withdrawn (a new stream needs /stream/request) and
// VOICE_STREAM_STOP{MODERATOR} is published.
func (s *Service) stopStream(w http.ResponseWriter, r *http.Request) error {
	room, target, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
	name := voice.RoomName(room.WorkspaceID, room.ID)
	acc, err := perm.NewResolver(s.db.Q).Room(r.Context(), room.ID, target)
	if err != nil && !errors.Is(err, perm.ErrNoRoom) {
		return err
	}
	streams, err := s.voice.Streams(r.Context(), room.ID)
	if err != nil {
		return err
	}
	stopped := 0
	for _, st := range sess {
		identity := voice.Identity(st.UserID, st.SessionID)
		muted := map[string]bool{}
		if p, err := s.lk.GetParticipant(r.Context(), name, identity); err == nil {
			for _, t := range p.Tracks {
				if (t.Source == SourceScreenShare || t.Source == SourceScreenShareAudio) && !t.Muted {
					if err := s.lk.MuteTrack(r.Context(), name, identity, t.Sid, true); err != nil && !IsNotFound(err) {
						return httpx.Unavailable(err)
					}
					muted[t.Sid] = true
				}
			}
		} else if !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		if err := s.pushGrant(r.Context(), name, identity, room.WorkspaceID, st.UserID, acc.Bits, false); err != nil && !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		// Recorded streams of this device (also covers tracks LiveKit no longer reports).
		for sid, rec := range streams {
			if rec.Identity == identity {
				muted[sid] = true
			}
		}
		for sid := range muted {
			if ok, _ := s.voice.RemoveStream(r.Context(), room.ID, sid); ok {
				s.publishStreamStop(r.Context(), room.WorkspaceID, room.ID, target, sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_MODERATOR)
				stopped++
			}
		}
		c, err := s.voice.Update(r.Context(), room.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil {
				return nil
			}
			n := *cur
			n.Streaming = false
			return &n
		})
		if err == nil {
			s.publishVoice(r.Context(), room.WorkspaceID, c)
		}
	}
	if stopped == 0 {
		return httpx.NotFound("stream of this member")
	}
	httpx.NoContent(w)
	return nil
}

func (s *Service) disconnectMember(w http.ResponseWriter, r *http.Request) error {
	room, _, sess, err := s.moderate(r)
	if err != nil {
		return err
	}
	name := voice.RoomName(room.WorkspaceID, room.ID)
	for _, st := range sess {
		if err := s.lk.RemoveParticipant(r.Context(), name, voice.Identity(st.UserID, st.SessionID)); err != nil && !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		// Voice state is cleared by the participant_left webhook (or reconcile).
	}
	httpx.NoContent(w)
	return nil
}

// removeIdentities disconnects identities from a room; not-found is fine.
func (s *Service) removeIdentities(ctx context.Context, room string, ids []string) {
	for _, id := range ids {
		if err := s.lk.RemoveParticipant(ctx, room, id); err != nil && !IsNotFound(err) {
			slog.WarnContext(ctx, "livekit remove participant", "room", room, "identity", id, "err", err)
		}
	}
}

var (
	errRoomFull     = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_ROOM_FULL, "the room is full")
	errRoomFullPlan = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_ROOM_FULL, "the room is full: the workspace plan limits users in a room")
)

// admit fails with ROOM_FULL when the room already has as many distinct users other than
// self (pending devices included) as a limit of adm allows; a user already inside (e.g.
// joining from a second device) does not take a new place. The plan limit is reported with
// reason PLAN_LIMIT.
func (s *Service) admit(ctx context.Context, wid, rid, self uuid.UUID, adm admission) error {
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return err
	}
	users := map[uuid.UUID]bool{}
	for _, st := range states {
		if st.RoomID == rid {
			if st.UserID == self {
				return nil
			}
			users[st.UserID] = true
		}
	}
	n := len(users)
	switch {
	case adm.plan > 0 && n >= adm.plan:
		return errRoomFullPlan.WithDetails(httpx.ReasonPlanLimit, uint64(n), uint64(adm.plan))
	case adm.room > 0 && n >= adm.room:
		return errRoomFull.WithDetails("", uint64(n), uint64(adm.room))
	}
	return nil
}

func rank(r perm.Role) int {
	switch r {
	case perm.RoleOwner:
		return 3
	case perm.RoleAdmin:
		return 2
	}
	return 1
}

// outranks enforces the moderation hierarchy for mute/disconnect/stop-stream (move: mayMove): the
// owner is untouchable, an admin can be moderated only by the owner; moderators among
// members (via room overrides) act on members and guests only. Acting on oneself is fine.
func outranks(r *http.Request, wsID, target uuid.UUID) error {
	actor := auth.MustFromContext(r.Context()).UserID
	if actor == target {
		return nil
	}
	res := perm.FromContext(r.Context())
	ar, err := res.Role(r.Context(), wsID, actor)
	if err != nil {
		return err
	}
	tr, err := res.Role(r.Context(), wsID, target)
	if errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("member")
	}
	if err != nil {
		return err
	}
	if rank(tr) >= 2 && rank(ar) <= rank(tr) {
		return httpx.Forbidden("cannot moderate a member of equal or higher rank")
	}
	return nil
}

// mayMove is the hierarchy check of a move (docs/09 п. 54, ADR-0026 clarified 27.09): an
// administrator (built-in admin or owner) may move anyone, other admins and the owner
// included — a move is not a sanction. Anyone else with MOVE_MEMBERS is bound by outranks.
// Mute/deafen/disconnect/stop-stream keep outranks.
func mayMove(r *http.Request, wsID, target uuid.UUID) error {
	res := perm.FromContext(r.Context())
	ar, err := res.Role(r.Context(), wsID, auth.MustFromContext(r.Context()).UserID)
	if err != nil {
		return err
	}
	if rank(ar) < 2 {
		return outranks(r, wsID, target)
	}
	if _, err := res.Role(r.Context(), wsID, target); errors.Is(err, perm.ErrNotMember) {
		return httpx.NotFound("member")
	} else if err != nil {
		return err
	}
	return nil
}

// DisabledRoutes answers rtc endpoints with 503 when LiveKit is not configured.
func DisabledRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	h := httpx.HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return httpx.Unavailable(errors.New("rtc: LiveKit is not configured"))
	})
	for _, p := range []string{"POST /api/rooms/{id}/join", "POST /api/rooms/{id}/voice/leave", "POST /api/rooms/{id}/stream/request",
		"POST /api/rooms/{id}/camera/request", "POST /api/rooms/{id}/camera/stop", "POST /api/rooms/{id}/voice/{userId}/stop-camera",
		"POST /api/rooms/{id}/voice/{userId}/allow-camera", "PATCH /api/voice/self",
		"PATCH /api/rooms/{id}/voice-status", "POST /api/rooms/{id}/voice/{userId}/mute", "POST /api/rooms/{id}/voice/{userId}/unmute", "POST /api/rooms/{id}/voice/{userId}/disconnect",
		"POST /api/rooms/{id}/voice/{userId}/stop-stream", "POST /api/rooms/{id}/voice/{userId}/move"} {
		mux.Handle(p, wrap(h))
	}
	mux.Handle("POST /api/rtc/webhook", h)
}

// maxVoiceStatus bounds rooms.voice_status (runes; DB CHECK matches).
const maxVoiceStatus = 60

// setVoiceStatus sets the status line of a voice room's current call: by a participant
// of the call (CONNECT and in the room now) or by MANAGE_ROOM. The membership check and the
// write run under the workspace voice lock, like the clearing when the room empties, so a
// status cannot outlive the call it was set for.
func (s *Service) setVoiceStatus(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	var req v1.UpdateVoiceStatusRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	status := strings.TrimSpace(req.GetStatus())
	if utf8.RuneCountInString(status) > maxVoiceStatus {
		return httpx.Validation("status", "status must be at most 60 characters")
	}
	room, err := s.getRoom(r.Context(), roomID)
	if err != nil {
		return err
	}
	if room.Type != "voice" {
		return httpx.Validation("id", "only voice rooms have a call status")
	}
	me := auth.MustFromContext(r.Context()).UserID
	var upd sqlc.Room
	err = s.voice.WithLock(r.Context(), acc.WorkspaceID, func() error {
		if !rooms.MayManage(acc, me) { // MANAGE_ROOM, or the creator of a temporary room (ADR-0044)
			if !acc.Bits.Has(perm.Connect) {
				return httpx.Forbidden("CONNECT required")
			}
			in, err := s.memberSessions(r.Context(), acc.WorkspaceID, roomID, me)
			if err != nil {
				return err
			}
			if len(in) == 0 {
				return httpx.Forbidden("join the call to set its status (or MANAGE_ROOM)")
			}
		}
		var val *string
		if status != "" {
			val = &status
		}
		var err error
		upd, err = db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.Room, error) {
			return guarded.SetVoiceStatus(r.Context(), sqlc.SetVoiceStatusParams{ID: roomID, Status: val})
		})
		return err
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("room")
	}
	if err != nil {
		return err
	}
	pb, err := rooms.Load(r.Context(), s.db.Q, upd)
	if err != nil {
		return err
	}
	if err := s.fillStarted(r.Context(), pb); err != nil {
		slog.WarnContext(r.Context(), "read call start", "room", roomID, "err", err)
	}
	s.events.Workspace(r.Context(), acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: pb}}})
	httpx.Write(w, http.StatusOK, &v1.UpdateRoomResponse{Room: pb})
	return nil
}
