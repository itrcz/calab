package rtc

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/voice"
)

// SyncPublisher decorates the event publisher: after publishing, it brings LiveKit in line
// with permission / membership / session changes (docs/04: "при изменении прав сервер
// обновляет grant"). It runs in the instance that performed the mutation, asynchronously.
type SyncPublisher struct {
	events.Publisher
	S *Service
}

func (p SyncPublisher) async(fn func(ctx context.Context)) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		fn(ctx)
	}()
}

// withCallStarts: a ROOM_UPDATE replaces the room on clients, so it carries the running
// call's start (e.g. a rename must not reset the call timer). All voice rooms of evs are read
// in ONE Redis round trip: this is post-commit work sharing the request's budget with
// publishing (events.Detached), and a per-room read would let a reorder of hundreds of rooms
// spend the whole budget before the first PUBLISH (and log one warning per room once it is
// gone). evs is not modified; on a read error the rooms go out as they are.
func (p SyncPublisher) withCallStarts(ctx context.Context, evs []*v1.DispatchEvent) []*v1.DispatchEvent {
	var idx []int
	var rids []uuid.UUID
	for i, ev := range evs {
		r := ev.GetRoomUpdate().GetRoom()
		if r.GetType() != v1.RoomType_ROOM_TYPE_VOICE {
			continue
		}
		if rid, err := uuid.Parse(r.GetId()); err == nil {
			idx, rids = append(idx, i), append(rids, rid)
		}
	}
	if len(rids) == 0 {
		return evs
	}
	dctx, done := events.Detached(ctx, 3*time.Second)
	started, err := p.S.voice.StartedAt(dctx, rids)
	done()
	if err != nil {
		slog.WarnContext(ctx, "read call start for ROOM_UPDATE", "rooms", len(rids), "err", err)
		return evs
	}
	out := append([]*v1.DispatchEvent(nil), evs...)
	for k, i := range idx {
		r := proto.Clone(evs[i].GetRoomUpdate().GetRoom()).(*v1.Room)
		r.VoiceStartedAt = nil
		if t, ok := started[rids[k]]; ok {
			r.VoiceStartedAt = timestamppb.New(t)
		}
		out[i] = &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: r}}}
	}
	return out
}

// Workspace implements events.Publisher.
func (p SyncPublisher) Workspace(ctx context.Context, wid uuid.UUID, ev *v1.DispatchEvent) {
	ev = p.withCallStarts(ctx, []*v1.DispatchEvent{ev})[0]
	p.Publisher.Workspace(ctx, wid, ev)
	p.sync(wid, ev)
}

// WorkspaceEvents implements events.Publisher.
func (p SyncPublisher) WorkspaceEvents(ctx context.Context, wid uuid.UUID, evs []*v1.DispatchEvent) {
	out := p.withCallStarts(ctx, evs)
	p.Publisher.WorkspaceEvents(ctx, wid, out)
	roles := false
	for _, ev := range out {
		if roleChange(ev) { // one resync of the workspace covers a whole batch (role order)
			if roles {
				continue
			}
			roles = true
		}
		p.sync(wid, ev)
	}
}

func roleChange(ev *v1.DispatchEvent) bool {
	return ev.GetRoleUpdate() != nil || ev.GetRoleDelete() != nil
}

// sync brings LiveKit in line with a published workspace event (asynchronously).
func (p SyncPublisher) sync(wid uuid.UUID, ev *v1.DispatchEvent) {
	switch e := ev.GetEvent().(type) {
	case *v1.DispatchEvent_RoomPermissionsUpdate:
		if rid, err := uuid.Parse(e.RoomPermissionsUpdate.GetRoomId()); err == nil {
			p.async(func(ctx context.Context) {
				p.S.resync(ctx, wid, func(st voice.SessionState) bool { return st.RoomID == rid })
			})
		}
	case *v1.DispatchEvent_WorkspaceMemberUpdate:
		if uid, err := uuid.Parse(e.WorkspaceMemberUpdate.GetMember().GetUser().GetId()); err == nil {
			p.async(func(ctx context.Context) {
				p.S.resync(ctx, wid, func(st voice.SessionState) bool { return st.UserID == uid })
			})
		}
	case *v1.DispatchEvent_RoleUpdate, *v1.DispatchEvent_RoleDelete:
		// A role's permissions / position changed or it is gone (ADR-0026): every device in
		// the workspace may hold it.
		p.async(func(ctx context.Context) {
			p.S.resync(ctx, wid, func(voice.SessionState) bool { return true })
		})
	case *v1.DispatchEvent_WorkspaceMemberRemove:
		if uid, err := uuid.Parse(e.WorkspaceMemberRemove.GetUserId()); err == nil {
			p.async(func(ctx context.Context) {
				p.S.disconnect(ctx, wid, func(st voice.SessionState) bool { return st.UserID == uid })
				// A server mute does not follow a member who left the workspace.
				if _, err := p.S.voice.SetServerMuted(ctx, wid, uid, false); err != nil {
					slog.WarnContext(ctx, "clear server mute", "user", uid, "err", err)
				}
			})
		}
	case *v1.DispatchEvent_RoomDelete:
		if rid, err := uuid.Parse(e.RoomDelete.GetRoomId()); err == nil {
			p.async(func(ctx context.Context) { p.S.closeRoom(ctx, wid, rid) })
		}
	case *v1.DispatchEvent_WorkspaceDelete:
		p.async(func(ctx context.Context) { p.S.disconnect(ctx, wid, func(voice.SessionState) bool { return true }) })
	case *v1.DispatchEvent_WorkspaceUpdate:
		// A suspended workspace has no calls (item 32): everyone is disconnected; joining again
		// is refused (403 WORKSPACE_SUSPENDED). A billing suspension (Workspace.billing
		// SUSPENDED, ADR-0080 §12) goes through the resync: its identity check (RTC) denies
		// every device while enforcement is on, so they are removed; tokens are refused the
		// same way, and the identity sweep (identity.go) catches a missed event.
		p.async(func(ctx context.Context) { p.S.resync(ctx, wid, func(voice.SessionState) bool { return true }) })
		if e.WorkspaceUpdate.GetWorkspace().GetSuspension() != nil {
			p.async(func(ctx context.Context) { p.S.disconnect(ctx, wid, func(voice.SessionState) bool { return true }) })
		}
	}
}

// SessionRevoked implements events.Publisher: the device is removed from LiveKit.
func (p SyncPublisher) SessionRevoked(ctx context.Context, sid uuid.UUID, reason string) {
	p.Publisher.SessionRevoked(ctx, sid, reason)
	p.async(func(ctx context.Context) {
		wid, _, ok, err := p.S.voice.Location(ctx, sid)
		if err != nil || !ok {
			return
		}
		p.S.disconnect(ctx, wid, func(st voice.SessionState) bool { return st.SessionID == sid })
	})
}

// resync recomputes grants for matching devices; those who lost VIEW_ROOM/CONNECT are removed.
func (s *Service) resync(ctx context.Context, wid uuid.UUID, match func(voice.SessionState) bool) {
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return
	}
	res := perm.NewResolver(s.db.Q)
	for _, st := range states {
		if !match(st) {
			continue
		}
		room := voice.RoomName(wid, st.RoomID)
		identity := voice.Identity(st.UserID, st.SessionID)
		if err := s.checkIdentity(ctx, wid, st.RoomID, st.UserID, st.SessionID); err != nil {
			s.removeIdentities(ctx, room, []string{identity})
			s.dropPending(ctx, wid, st)
			continue
		}
		acc, err := res.Room(ctx, st.RoomID, st.UserID)
		if err != nil || !acc.Bits.Has(perm.ViewRoom|perm.Connect) {
			s.removeIdentities(ctx, room, []string{identity})
			s.dropPending(ctx, wid, st)
			continue
		}
		if err := s.pushGrant(ctx, room, identity, wid, st.UserID, acc.Bits, st.Streaming); err != nil && !IsNotFound(err) {
			slog.WarnContext(ctx, "livekit update permission", "identity", identity, "err", err)
		}
	}
}

func (s *Service) disconnect(ctx context.Context, wid uuid.UUID, match func(voice.SessionState) bool) {
	states, err := s.voice.List(ctx, wid)
	if err != nil {
		return
	}
	for _, st := range states {
		if match(st) {
			s.removeIdentities(ctx, voice.RoomName(wid, st.RoomID), []string{voice.Identity(st.UserID, st.SessionID)})
			s.dropPending(ctx, wid, st)
		}
	}
}

func (s *Service) closeRoom(ctx context.Context, wid, rid uuid.UUID) {
	if err := s.lk.DeleteRoom(ctx, voice.RoomName(wid, rid)); err != nil && !IsNotFound(err) {
		slog.WarnContext(ctx, "livekit delete room", "err", err)
	}
	_ = s.roomFinished(ctx, wid, rid)
}

// joinGrace: voice states younger than this are not removed by reconcile (they may have
// joined between our Redis snapshot and the LiveKit listing).
const joinGrace = 15 * time.Second

// Reconcile compares LiveKit participants with Redis voice state and fixes drift from
// missed webhooks. Only one instance runs it per period (Redis lock). Redis state is
// snapshotted before LiveKit is listed; fresh states are never removed (joinGrace).
func (s *Service) Reconcile(ctx context.Context) error {
	lock := s.redis.B().Set().Key(redisx.Key("rtc:reconcile")).Value("1").Nx().Ex(25 * time.Second).Build()
	if err := s.redis.Do(ctx, lock).Error(); err != nil {
		return nil //nolint:nilerr // another instance holds the lock (or Redis is down)
	}
	start := time.Now()
	known, err := s.voice.Workspaces(ctx)
	if err != nil {
		return err
	}
	snap := map[uuid.UUID][]voice.SessionState{}
	for _, w := range known {
		if snap[w], err = s.voice.List(ctx, w); err != nil {
			return err
		}
	}
	lkRooms, err := s.lk.ListRooms(ctx)
	if err != nil {
		return err
	}
	type roomRef struct{ wid, rid uuid.UUID }
	live := map[roomRef][]Participant{}
	for _, r := range lkRooms {
		wid, rid, ok := voice.ParseRoomName(r.Name)
		if !ok {
			continue
		}
		ps, err := s.lk.ListParticipants(ctx, r.Name)
		if err != nil {
			return err
		}
		live[roomRef{wid, rid}] = ps
		if _, ok := snap[wid]; !ok {
			snap[wid] = nil
		}
	}
	for wid, states := range snap {
		present := map[string]uuid.UUID{} // identity -> room
		for ref, ps := range live {
			if ref.wid != wid {
				continue
			}
			for _, p := range ps {
				present[p.Identity] = ref.rid
				uid, sid, ok := voice.ParseIdentity(p.Identity)
				if !ok {
					continue
				}
				if !hasState(states, sid, ref.rid) {
					// Re-adding voice state needs a fresh identity check; evicting denied
					// participants with state is the identity sweep's job (identity.go).
					if err := s.checkIdentity(ctx, wid, ref.rid, uid, sid); err != nil {
						s.removeIdentities(ctx, voice.RoomName(wid, ref.rid), []string{p.Identity})
						continue
					}
					if s.superseded(ctx, wid, ref.rid, sid) {
						// Taken out for another device of the user (devices.go): not back in.
						s.removeIdentities(ctx, voice.RoomName(wid, ref.rid), []string{p.Identity})
						continue
					}
					muted := micMuted(&p)
					rid := ref.rid
					fresh := start.Add(-joinGrace).UnixMilli()
					_ = s.update(ctx, wid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
						if cur != nil && cur.RoomID == rid {
							return cur // appeared meanwhile via webhook
						}
						if cur != nil && cur.JoinedAt > fresh {
							// Recently recorded elsewhere (app-level move, ADR-0019: the device is
							// still in the old room for a moment): do not flip it back.
							return cur
						}
						return &voice.SessionState{RoomID: rid, Muted: muted}
					})
				}
			}
			s.reconcileStreams(ctx, wid, ref.rid, ps, start)
			s.reconcileCameras(ctx, wid, ref.rid, ps)
		}
		cutoff := start.Add(-joinGrace).UnixMilli()
		for _, st := range states {
			if rid, ok := present[voice.Identity(st.UserID, st.SessionID)]; ok && rid == st.RoomID {
				if st.Pending { // connected, but participant_joined was lost
					_ = s.setFlag(ctx, wid, st.RoomID, st.UserID, st.SessionID, func(n *voice.SessionState) { n.Pending = false })
				}
				continue
			}
			if st.JoinedAt > cutoff {
				continue // too fresh to judge: may have joined after the listing (a pending /join too)
			}
			s.stopStreams(ctx, wid, st.RoomID, voice.Identity(st.UserID, st.SessionID), v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
			joined := st.JoinedAt
			_ = s.update(ctx, wid, st.UserID, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
				if cur != nil && cur.RoomID == st.RoomID && cur.JoinedAt == joined {
					return nil
				}
				return cur // changed since the snapshot: leave it
			})
		}
		if len(states) == 0 {
			_ = s.voice.Forget(ctx, wid) // drop idle workspaces from the reconcile set
		}
	}
	return nil
}

func hasState(states []voice.SessionState, sid, rid uuid.UUID) bool {
	for _, st := range states {
		if st.SessionID == sid && st.RoomID == rid {
			return true
		}
	}
	return false
}

// reconcileStreams drops recorded streams whose tracks are gone and records live screen
// shares that were missed (e.g. a track_published that arrived before participant_joined).
// Streams recorded after start−joinGrace are never dropped: their track_published may have
// arrived after ps was listed (start is taken before listing). A record without a start time
// (Started == 0) counts as old.
func (s *Service) reconcileStreams(ctx context.Context, wid, rid uuid.UUID, ps []Participant, start time.Time) {
	actual := map[string]Participant{}
	for _, p := range ps {
		for _, t := range p.Tracks {
			if t.Source == SourceScreenShare && !t.Muted {
				actual[t.Sid] = p
			}
		}
	}
	streams, err := s.voice.Streams(ctx, rid)
	if err != nil {
		return
	}
	fresh := start.Add(-joinGrace).UnixMilli()
	for sidTrack, st := range streams {
		if st.Started > fresh {
			continue // too fresh to judge: may have been published after the listing
		}
		if _, ok := actual[sidTrack]; !ok {
			if ok, _ := s.voice.RemoveStream(ctx, rid, sidTrack); ok {
				s.publishStreamStop(ctx, wid, rid, st.UserID, sidTrack, v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED)
			}
		}
	}
	for sidTrack, p := range actual {
		if _, ok := streams[sidTrack]; ok {
			continue
		}
		uid, sid, ok := voice.ParseIdentity(p.Identity)
		if !ok {
			continue
		}
		_ = s.streamStarted(ctx, wid, rid, uid, sid, p.Identity, &Track{Sid: sidTrack, Source: SourceScreenShare})
	}
}

// RunReconcile runs Reconcile every interval until ctx is done.
func (s *Service) RunReconcile(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Reconcile(ctx); err != nil {
				slog.Warn("voice reconcile", "err", err)
			}
		}
	}
}
