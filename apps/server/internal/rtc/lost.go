package rtc

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/voice"
)

// A voice seat survives an involuntary drop (ADR-0150). When LiveKit closes a device's last
// connection in a workspace room without the device or the server asking for it — a phone whose
// page froze in the background, a network that went away — the seat is kept for
// Config.LostGrace (VOICE_LOST_GRACE) and marked lost; others see «no connection» instead of a
// leave. The device's own /join or its next LiveKit connection takes the seat back; otherwise
// Reconcile removes it once the grace has passed, as a leave. DM calls keep their own rule
// (ADR-0034: the call ends when a participant is lost for 30 s).

// DisconnectReason is livekit.DisconnectReason as it appears in a webhook's ParticipantInfo:
// protojson writes the enum's name; a number is accepted too.
type DisconnectReason string

var disconnectReasonNames = map[int]DisconnectReason{
	1: "CLIENT_INITIATED", 2: "DUPLICATE_IDENTITY", 3: "SERVER_SHUTDOWN", 4: "PARTICIPANT_REMOVED",
	5: "ROOM_DELETED", 6: "STATE_MISMATCH", 7: "JOIN_FAILURE", 8: "MIGRATION", 9: "SIGNAL_CLOSE",
	10: "ROOM_CLOSED", 14: "CONNECTION_TIMEOUT", 15: "MEDIA_FAILURE",
}

// UnmarshalJSON accepts the enum's name or its number.
func (r *DisconnectReason) UnmarshalJSON(b []byte) error {
	if bytes.HasPrefix(b, []byte(`"`)) {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*r = DisconnectReason(s)
		return nil
	}
	// A number; null or anything unexpected is no reason (a drop), never a bad webhook.
	n, err := strconv.Atoi(string(b))
	*r = ""
	if err == nil {
		*r = disconnectReasonNames[n]
	}
	return nil
}

// explicitRelease reports a disconnect that ends the seat at once: the client left
// (CLIENT_INITIATED: «Отключиться», closing the app), the server removed the participant
// (PARTICIPANT_REMOVED: /voice/leave, a moderator's kick, lost access, another device of the
// user), the same identity connected again (DUPLICATE_IDENTITY), the room was deleted or closed,
// the connection migrated. Everything else is a drop and holds the seat: the peer connection
// timed out (CONNECTION_TIMEOUT, logged by LiveKit as PEER_CONNECTION_DISCONNECTED — a frozen
// phone page), the signal socket closed, a state mismatch, a join or media failure, a LiveKit
// node shutting down (the clients reconnect), no reason at all.
func explicitRelease(r DisconnectReason) bool {
	switch r {
	case "CLIENT_INITIATED", "PARTICIPANT_REMOVED", "DUPLICATE_IDENTITY", "ROOM_DELETED", "ROOM_CLOSED", "MIGRATION":
		return true
	}
	return false
}

// holdsSeats reports whether a drop in room rid of scope wid holds the seat: the grace is on and
// it is a workspace room (a DM call has its own rule).
func (s *Service) holdsSeats(wid, rid uuid.UUID) bool {
	return s.cfg.LostGrace > 0 && !voice.IsDM(wid, rid)
}

// seatAfterDrop is the device's seat in room rid after its last LiveKit connection there went
// (participant_left / _connection_aborted that no newer connection superseded); nil removes it.
// A seat elsewhere — another room, or none — is not touched. With hold the seat of a connected
// device is kept and marked lost until now+grace; its streams and webcam are gone with the
// connection. A pending device (never connected in this episode) goes as before. A seat that is
// held already keeps its deadline — drops without a connection in between do not extend it —
// and goes at once when that deadline has passed.
func seatAfterDrop(cur *voice.SessionState, rid uuid.UUID, hold bool, grace time.Duration, now time.Time) *voice.SessionState {
	if cur == nil || cur.RoomID != rid {
		return cur
	}
	if !hold || grace <= 0 || cur.Pending {
		return nil
	}
	n := *cur
	if n.Hold == 0 {
		n.Hold = now.Add(grace).UnixMilli()
	} else if now.UnixMilli() >= n.Hold {
		return nil
	}
	n.Lost, n.Streaming, n.Camera = true, false, false
	return &n
}

// seatOnRejoin is a lost seat after the device's own /join of its room: the mark goes (others
// see the user connected again, no leave/join) and the hold stays at least connectConfirm ahead,
// so that Reconcile does not take the seat while LiveKit connects. ok=false: the seat is not
// lost (connected, pending, or taken back already) — a repeated /join changes nothing.
func seatOnRejoin(cur voice.SessionState, now time.Time) (voice.SessionState, bool) {
	if !cur.Lost {
		return cur, false
	}
	n := cur
	n.Lost = false
	n.Hold = max(n.Hold, now.Add(connectConfirm).UnixMilli())
	return n, true
}

// held reports a seat kept without a LiveKit connection (lost, or taken back by /join and not
// connected yet).
func held(st voice.SessionState) bool { return st.Lost || st.Hold > 0 }

// seatBack clears a held or pending seat whose device is in the LiveKit listing (Reconcile). A seat
// that dropped again since the snapshot (its hold changed) keeps the new hold: cleared, the next
// pass would remove it as a plain leave, without the grace.
func seatBack(seen voice.SessionState) func(*voice.SessionState) {
	return func(n *voice.SessionState) {
		if n.Hold != seen.Hold {
			return
		}
		n.Pending, n.Lost, n.Hold = false, false, 0
	}
}

// expireSeat removes a held seat whose grace has passed (Reconcile), exactly as a leave:
// VOICE_STATE_UPDATE with an empty room, the camera reservation and a moderator's camera stop go,
// the last person out hangs up a phone call (ADR-0046). A seat that reconnected, moved or was
// taken back since the snapshot (its hold changed) is left alone.
func (s *Service) expireSeat(ctx context.Context, wid uuid.UUID, st voice.SessionState) {
	removed := false
	if err := s.update(ctx, wid, st.UserID, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil || cur.RoomID != st.RoomID || cur.Hold != st.Hold {
			return cur
		}
		removed = true
		return nil
	}); err != nil || !removed {
		return
	}
	identity := voice.Identity(st.UserID, st.SessionID)
	slog.InfoContext(ctx, "voice seat released: the connection did not come back", "identity", identity, "room", st.RoomID)
	s.dropCompanion(ctx, wid, st.RoomID, st.UserID, st.SessionID) // the seat was all that kept it (ADR-0149 §3)
	s.stopStreams(ctx, wid, st.RoomID, identity, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
	s.dropCameras(ctx, st.RoomID, st.SessionID, identity, nil, false)
	if s.SIP != nil && !voice.IsDM(wid, st.RoomID) {
		s.SIP.PersonLeft(ctx, wid, st.RoomID)
	}
}
