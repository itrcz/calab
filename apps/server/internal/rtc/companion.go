package rtc

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/voice"
)

// The companion connection (ADR-0149 §3): on an iPhone whose room audio is native (identity
// "<user>:<session>"), the WebView keeps a second, subscribe-only LiveKit connection
// "<user>:<session>:web" for cameras, screen shares and the data topics. It belongs to its
// device's seat and never is one: its join and leave never touch voice state, the seat grace
// (ADR-0150), cues or the phone line (ADR-0046). Without its session's seat in the room it is
// removed; every path that takes the device out takes the companion out too (removeIdentities,
// dropCompanion), and a newer companion of the same session replaces the old one in LiveKit
// itself (DUPLICATE_IDENTITY). It counts only against LIVEKIT_MAX_PARTICIPANTS.

// CompanionGrant is the companion's LiveKit permission: subscribe and data (the stream watch and
// annotation topics) with VIEW_ROOM & CONNECT, never a publish source (v1). Not hidden: the data
// topics need a visible participant.
func CompanionGrant(bits perm.Bits) Permission {
	join := bits.Has(perm.ViewRoom | perm.Connect)
	return Permission{CanSubscribe: join, CanPublishData: join, CanPublishSources: []TrackSource{}}
}

// companionToken: POST /api/rooms/{id}/voice/companion → VoiceCompanionResponse. Workspace
// voice rooms only (one-to-one calls keep their engine, ADR-0149 §1).
func (s *Service) companionToken(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if acc.Notes || acc.DM {
		return httpx.NotFound("room")
	}
	if !acc.Bits.Has(perm.ViewRoom | perm.Connect) {
		return httpx.Forbidden("CONNECT required")
	}
	room, err := s.getRoom(r.Context(), roomID)
	if err != nil {
		return err
	}
	if room.Type != "voice" {
		return httpx.Validation("id", "not a voice room")
	}
	id := auth.MustFromContext(r.Context())
	resp, err := s.companion(r.Context(), room.WorkspaceID, room.ID, id.UserID, id.SessionID, acc.Bits, s.displayName(r.Context(), room.WorkspaceID, id.UserID))
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

var errNoSeat = httpx.Conflict("join the voice room first: the companion needs this device's seat in the room")

// companion issues the token of a device's companion: the device must hold a seat in the room
// (pending, connected or held after a drop) and pass the identity check. Nothing is written.
func (s *Service) companion(ctx context.Context, wid, rid, uid, sid uuid.UUID, bits perm.Bits, name string) (*v1.VoiceCompanionResponse, error) {
	ok, err := s.seatIn(ctx, wid, rid, sid)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errNoSeat
	}
	if err := s.checkIdentity(ctx, wid, rid, uid, sid); err != nil {
		return nil, err
	}
	identity := voice.CompanionIdentity(uid, sid)
	tok, err := JoinToken(s.cfg.APIKey, s.cfg.Secret, voice.RoomName(wid, rid), identity, name, CompanionGrant(bits), TokenTTL)
	if err != nil {
		return nil, err
	}
	return &v1.VoiceCompanionResponse{Url: s.cfg.PublicURL, Token: tok, Identity: identity}, nil
}

// seatIn reports whether the device session has a seat in room rid of scope wid: any voice state
// there — pending, connected or held (the device location covers all of them).
func (s *Service) seatIn(ctx context.Context, wid, rid, sid uuid.UUID) (bool, error) {
	w, r, ok, err := s.voice.Location(ctx, sid)
	if err != nil {
		return false, err
	}
	return ok && w == wid && r == rid, nil
}

// companionEvent handles a LiveKit event of a companion participant. Only its arrival is
// checked (seat, session, identity, rights — its token may be up to TokenTTL old); a publish is
// refused (the grant has no source, so this is defence in depth). Its leave changes nothing:
// a duplicate companion (DUPLICATE_IDENTITY) or a closed WebView is not the device leaving.
func (s *Service) companionEvent(ctx context.Context, event string, wid, rid, uid, sid uuid.UUID, lkRoom string, p *Participant) error {
	switch event {
	case EventParticipantJoined:
		reason, err := s.companionDenied(ctx, wid, rid, uid, sid)
		if err != nil {
			return err
		}
		if reason != "" {
			slog.InfoContext(ctx, "voice companion rejected", "identity", p.Identity, "reason", reason)
			s.removeIdentities(ctx, lkRoom, []string{p.Identity})
		}
	case EventTrackPublished:
		slog.WarnContext(ctx, "voice companion published a track, removing it", "identity", p.Identity)
		s.removeIdentities(ctx, lkRoom, []string{p.Identity})
	}
	return nil
}

// companionDenied returns why a companion may not stay in the room ("" = it may). An error is a
// failure to decide (the event is retried).
func (s *Service) companionDenied(ctx context.Context, wid, rid, uid, sid uuid.UUID) (string, error) {
	if voice.IsDM(wid, rid) {
		return "a call has no companion", nil
	}
	ok, err := s.seatIn(ctx, wid, rid, sid)
	if err != nil {
		return "", err
	}
	if !ok {
		return "no seat of its device in the room", nil
	}
	// The identity gate decides the session, the account and VIEW_ROOM & CONNECT in the room
	// (app/rtc_identity.go) at the DB source.
	if err := s.checkIdentity(ctx, wid, rid, uid, sid); err != nil {
		return "identity access denied", nil
	}
	if s.Revoked != nil {
		if revoked, err := s.Revoked(ctx, sid); err != nil {
			return "", err
		} else if revoked {
			return "session revoked", nil
		}
	}
	return "", nil
}

// dropCompanion removes the companion of a device from a room, for the paths that end a seat
// without removing a LiveKit participant of the device (a seat that never connected, a held
// seat whose grace ended, a moved device).
func (s *Service) dropCompanion(ctx context.Context, wid, rid, uid, sid uuid.UUID) {
	s.removeIdentities(ctx, voice.RoomName(wid, rid), []string{voice.CompanionIdentity(uid, sid)})
}

// pushCompanionGrant aligns a companion's grant with the device's current rights (pushGrant of a
// companion identity); one failing the identity check is removed. Not found: no companion.
func (s *Service) pushCompanionGrant(ctx context.Context, lkRoom string, wid, rid, uid, sid uuid.UUID, bits perm.Bits) error {
	if err := s.checkIdentity(ctx, wid, rid, uid, sid); err != nil {
		s.removeIdentities(ctx, lkRoom, []string{voice.CompanionIdentity(uid, sid)})
		return err
	}
	return s.syncCompanionGrant(ctx, lkRoom, uid, sid, bits)
}

// syncCompanionGrant sends the companion grant for bits already checked by the caller (resync);
// without VIEW_ROOM & CONNECT the companion is removed instead.
func (s *Service) syncCompanionGrant(ctx context.Context, lkRoom string, uid, sid uuid.UUID, bits perm.Bits) error {
	identity := voice.CompanionIdentity(uid, sid)
	if !bits.Has(perm.ViewRoom | perm.Connect) {
		s.removeIdentities(ctx, lkRoom, []string{identity})
		return nil
	}
	return s.lk.UpdatePermission(ctx, lkRoom, identity, CompanionGrant(bits))
}

// withCompanions adds the companion of every device identity in ids: removing a device from a
// room removes its companion with it. Other identities (companions, phone lines) stay as given.
func withCompanions(ids []string) []string {
	out := ids
	for _, id := range ids {
		if uid, sid, ok := voice.ParseIdentity(id); ok {
			if len(out) == len(ids) {
				out = append(make([]string, 0, 2*len(ids)), ids...)
			}
			out = append(out, voice.CompanionIdentity(uid, sid))
		}
	}
	return out
}
