package rtc

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/voice"
)

// App-level move timing (ADR-0019): the moved device gets a target-room token valid for
// moveTokenTTL; after moveDropOld it is removed from the old room if still there; it is
// pending in the target, and if it has not connected within connectConfirm (the same
// confirmation as an optimistic /join, pending.go) its voice state is rolled back.
const (
	moveTokenTTL = 2 * time.Minute
	moveDropOld  = 5 * time.Second
)

// appMove is a device moved at app level, waiting to reconnect to the target room.
type appMove struct {
	sessionID uuid.UUID
	identity  string
	token     string
	joinedAt  int64 // its pending state in the target (expectConnect)
}

// moveMember: POST /api/rooms/{id}/voice/{userId}/move {targetRoomId}. The actor needs
// MOVE_MEMBERS in both rooms and passes mayMove (an admin may move admins and the owner);
// the moved user needs VIEW_ROOM + CONNECT in the target; the
// target's user_limit applies unless the actor is an administrator.
//
// Every device of the user in the source room is moved. LiveKit MoveParticipant (Cloud)
// moves it inside the SFU without a reconnect. Open-source LiveKit answers "not
// implemented" (remembered per process); then the move is done by the app (ADR-0019): the
// device gets a join token for the target room in VOICE_MOVED and reconnects itself.
func (s *Service) moveMember(w http.ResponseWriter, r *http.Request) error {
	srcID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, srcID)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.MoveMembers) {
		return httpx.Forbidden("MOVE_MEMBERS required")
	}
	target, err := httpx.PathUUID(r, "userId", "member")
	if err != nil {
		return err
	}
	if err := mayMove(r, acc.WorkspaceID, target); err != nil {
		return err
	}
	var req v1.MoveMemberRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	dstID, err := uuid.Parse(req.GetTargetRoomId())
	if err != nil || dstID == srcID {
		return httpx.Validation("targetRoomId", "target must be another voice room")
	}
	dst, dstMedia, err := s.roomInfo(r.Context(), dstID)
	if db.IsNotFound(err) || (err == nil && (dst.WorkspaceID != acc.WorkspaceID || dst.Type != "voice")) {
		return httpx.Validation("targetRoomId", "target must be a voice room of the same workspace")
	}
	if err != nil {
		return err
	}
	actor := auth.MustFromContext(r.Context()).UserID
	res := perm.FromContext(r.Context())
	actorDst, err := res.Room(r.Context(), dstID, actor)
	if err != nil && !errors.Is(err, perm.ErrNoRoom) {
		return err
	}
	if !actorDst.Bits.Has(perm.ViewRoom | perm.MoveMembers) {
		return httpx.Forbidden("MOVE_MEMBERS required in the target room")
	}
	movedDst, err := res.Room(r.Context(), dstID, target)
	if err != nil && !errors.Is(err, perm.ErrNoRoom) {
		return err
	}
	if !movedDst.Bits.Has(perm.ViewRoom | perm.Connect) {
		return httpx.Forbidden("the member cannot connect to the target room")
	}
	if adm := admissionFor(dst, actorDst.Role == perm.RoleOwner); adm.active() {
		if err := s.admit(r.Context(), dst.WorkspaceID, dstID, target, adm); err != nil {
			return err
		}
	}
	sess, err := s.memberSessions(r.Context(), acc.WorkspaceID, srcID, target)
	if err != nil {
		return err
	}
	if len(sess) == 0 {
		return httpx.NotFound("member in this voice room")
	}
	srcName, dstName := voice.RoomName(acc.WorkspaceID, srcID), voice.RoomName(acc.WorkspaceID, dstID)
	if err := s.lk.CreateRoom(r.Context(), dstName, EmptyTimeout, s.cfg.MaxParticipants); err != nil {
		return httpx.Unavailable(err)
	}
	// From here on voice state is mutated device by device: a moderator who closes the tab
	// mid-request must not leave devices recorded in the target without VOICE_MOVED, timers
	// or a rollback. Finish the move on a context detached from the request.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 20*time.Second)
	defer cancel()
	streams, err := s.voice.Streams(ctx, srcID)
	if err != nil {
		return err
	}
	cameras, err := s.voice.Cameras(ctx, srcID)
	if err != nil {
		return err
	}
	moved := 0
	var apps []appMove
	for _, st := range sess {
		if err := s.checkIdentity(ctx, acc.WorkspaceID, dstID, st.UserID, st.SessionID); err != nil {
			continue
		}
		identity := voice.Identity(st.UserID, st.SessionID)
		prev := st
		// Record the device in the target first: LiveKit may deliver participant_joined for
		// the target before we get here again, and the join revalidation must then see the
		// user as already inside (an admin may move into a full room — review R3).
		var joinedAt int64
		c, err := s.voice.Update(ctx, acc.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
			if cur == nil || cur.RoomID != srcID {
				return cur
			}
			n := *cur
			n.RoomID, n.JoinedAt = dstID, time.Now().UnixMilli()
			// App-level moves (known already) reconnect: pending in the target from the start,
			// so its call starts with the device's LiveKit connection, not with the move.
			n.Pending = s.noSFUMove.Load()
			joinedAt = n.JoinedAt
			return &n
		})
		if err != nil {
			return err
		}
		rollback := func() {
			// Call starts of both rooms are announced by the updates themselves (OnCalls).
			_, _ = s.voice.Update(ctx, acc.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
				if cur == nil || cur.RoomID != dstID {
					return cur
				}
				n := prev
				return &n
			})
		}
		if !s.noSFUMove.Load() {
			err := s.lk.MoveParticipant(ctx, srcName, identity, dstName)
			switch {
			case err == nil:
			case IsNotImplemented(err):
				slog.InfoContext(ctx, "LiveKit has no MoveParticipant: moving participants at app level (ADR-0019)")
				s.noSFUMove.Store(true)
			case IsNotFound(err):
				rollback()
				continue // device already left; webhook / reconcile clean up
			default:
				rollback()
				return httpx.Unavailable(err)
			}
		}
		if s.noSFUMove.Load() {
			// App-level move: a token for the target room, the device reconnects itself.
			// Its streams end with the old connection (the client requests them again).
			tok, err := JoinToken(s.cfg.APIKey, s.cfg.Secret, dstName, identity,
				s.displayName(ctx, acc.WorkspaceID, target), s.grant(ctx, acc.WorkspaceID, target, movedDst.Bits, false), moveTokenTTL)
			if err != nil {
				rollback()
				return err
			}
			moved++
			// The device comes back on a new connection: pending in the target (like an
			// optimistic /join), no camera, no stream. Its webcam is not "stopped" (no
			// VOICE_CAMERA_STOP); the client requests it again in the target.
			camReset := s.resetCameraForReconnect(ctx, srcID, identity, cameras)
			c2, err := s.voice.Update(ctx, acc.WorkspaceID, target, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
				if cur == nil || cur.RoomID != dstID || cur.JoinedAt != joinedAt {
					return cur
				}
				n := *cur
				n.Pending = true
				if camReset {
					n.Camera = false
				}
				return &n
			})
			if err != nil {
				c2 = c
			} else {
				// One announcement of the final state (target room, pending, camera off); the
				// intermediate one is never published.
				c2.Before = c.Before
			}
			s.publishVoice(ctx, acc.WorkspaceID, c2)
			s.stopStreams(ctx, acc.WorkspaceID, srcID, identity, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
			apps = append(apps, appMove{sessionID: st.SessionID, identity: identity, token: tok, joinedAt: joinedAt})
			continue
		}
		moved++
		s.publishVoice(ctx, acc.WorkspaceID, c)
		// Webcams move with the participant too (moderator action: the target's camera_limit
		// is not applied, like user_limit); carried before the grant so it keeps the camera.
		// A target that does not allow cameras for the member (no VIDEO, camera_limit 0)
		// stops them with VOICE_CAMERA_STOP{ROOM_POLICY} instead (webcam review L6).
		camsAllowed := movedDst.Bits.Has(perm.Video) && dstMedia.GetCameraLimit() > 0
		var stoppedCams []string
		for sid, rec := range cameras {
			if rec.Identity != identity {
				continue
			}
			if ok, _ := s.voice.RemoveCamera(ctx, srcID, sid); !ok {
				continue
			}
			if camsAllowed {
				_, _ = s.voice.AddCamera(ctx, dstID, sid, rec, -1)
			} else {
				stoppedCams = append(stoppedCams, sid)
			}
		}
		if !camsAllowed {
			if _, err := s.voice.ReleaseCamera(ctx, identity); err != nil {
				slog.WarnContext(ctx, "release camera on move", "identity", identity, "err", err)
			}
			for _, sid := range stoppedCams {
				if err := s.lk.MuteTrack(ctx, dstName, identity, sid, true); err != nil && !IsNotFound(err) {
					slog.WarnContext(ctx, "mute camera on move", "identity", identity, "err", err)
				}
				s.publishCameraStop(ctx, acc.WorkspaceID, dstID, target, sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ROOM_POLICY)
			}
			if len(stoppedCams) > 0 {
				_ = s.setFlag(ctx, acc.WorkspaceID, dstID, target, st.SessionID, func(n *voice.SessionState) { n.Camera = false })
			}
		}
		if err := s.pushGrant(ctx, dstName, identity, acc.WorkspaceID, target, movedDst.Bits, st.Streaming); err != nil && !IsNotFound(err) {
			return httpx.Unavailable(err)
		}
		// Tracks move with the participant: carry the stream records over.
		for sid, rec := range streams {
			if rec.Identity != identity {
				continue
			}
			if ok, _ := s.voice.RemoveStream(ctx, srcID, sid); ok {
				s.publishStreamStop(ctx, acc.WorkspaceID, srcID, target, sid, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
			}
			if ok, err := s.voice.AddStream(ctx, dstID, sid, rec, -1); err == nil && ok {
				s.events.Workspace(ctx, acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStreamStart{VoiceStreamStart: &v1.VoiceStreamStart{
					WorkspaceId: acc.WorkspaceID.String(), RoomId: dstID.String(), UserId: target.String(), TrackSid: sid, Preset: rec.Preset,
				}}})
			}
		}
	}
	if moved == 0 {
		return httpx.NotFound("member in this voice room")
	}
	moveEv := func(m *appMove) *v1.DispatchEvent {
		ev := &v1.VoiceMoved{WorkspaceId: acc.WorkspaceID.String(), FromRoomId: srcID.String(), ToRoomId: dstID.String(), ByUserId: actor.String()}
		if m != nil {
			ev.Url, ev.Token, ev.SessionId, ev.Identity = s.cfg.PublicURL, m.token, m.sessionID.String(), m.identity
		}
		return &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceMoved{VoiceMoved: ev}}
	}
	var moves []*v1.DispatchEvent
	if len(apps) < moved { // some devices were moved inside the SFU
		moves = append(moves, moveEv(nil))
	}
	for i := range apps {
		moves = append(moves, moveEv(&apps[i]))
	}
	s.publishMoved(ctx, target, moves)
	for i := range apps {
		m := apps[i]
		time.AfterFunc(moveDropOld, func() { s.dropFromOldRoom(srcID, m.sessionID, srcName, m.identity) })
		s.expectConnect(acc.WorkspaceID, dstID, target, m.sessionID, m.joinedAt)
	}
	httpx.NoContent(w)
	return nil
}

// movedBudget is the Redis time VOICE_MOVED gets on its own. It carries the join token of
// an app-level move: if it is lost because the request's shared post-commit budget was used
// up by the VOICE_STATE_UPDATE / stream events before it, the user is left in limbo until
// the 15 s rollback. So it does not share that budget.
const movedBudget = 3 * time.Second

// publishMoved sends VOICE_MOVED to the moved user's devices with its own budget.
func (s *Service) publishMoved(ctx context.Context, target uuid.UUID, evs []*v1.DispatchEvent) {
	ctx = events.WithBudget(context.WithoutCancel(ctx), movedBudget)
	for _, ev := range evs {
		s.events.User(ctx, target, ev)
	}
}

// dropFromOldRoom removes an app-level-moved device from the old LiveKit room if it is
// still connected there (the client did not disconnect itself). A device that is back in
// the old room by now (moved back, or rejoined it itself) is left alone.
func (s *Service) dropFromOldRoom(srcID, sid uuid.UUID, lkRoom, identity string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, rid, ok, err := s.voice.Location(ctx, sid); err == nil && ok && rid == srcID {
		return
	}
	if err := s.lk.RemoveParticipant(ctx, lkRoom, identity); err != nil && !IsNotFound(err) {
		slog.WarnContext(ctx, "remove moved participant from the old room", "identity", identity, "err", err)
	}
}
