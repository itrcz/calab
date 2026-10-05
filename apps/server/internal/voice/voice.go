// Package voice keeps voice state in Redis, per device session, and aggregates it per user
// (docs/05 "Несколько устройств"). LiveKit webhooks + reconcile are the source of truth;
// PATCH /api/voice/self applies optimistic mute/deafen.
//
// Keys:
//
//	voice:ws:<workspace_id>      hash  "<user_id>:<session_id>" -> JSON SessionState
//	voice:sess:<session_id>      string "<workspace_id>/<room_id>" (where a device is connected)
//	voice:streams:<room_id>      hash  track_sid -> JSON Stream
//	voice:streamreq:<identity>   string preset reserved by /stream/request (TTL 10 min)
//	voice:cameras:<room_id>      hash  track_sid -> JSON Camera (webcams, limited by camera_limit)
//	voice:camreq:<identity>      string camera grant reserved by /camera/request (TTL 10 min)
//	voice:camoff:<identity>      string camera stopped by a moderator: no camera until leave / allow-camera
//	voice:workspaces             set   workspaces with any voice state (for reconcile)
//	voice:started:<room_id>      string unix ms when the current call began (first connected device; pending ones do not count)
//	voice:smuted:<workspace_id>  set   user ids server-muted by a moderator (kept until unmuted, across rejoins)
//	voice:superseded:<session_id> string "<workspace_id>/<room_id>" the device was taken out of for another device of the user (TTL 15 min; cleared by its own /join)
//	voice:ulock:<user_id>        string per-user lock of a /join (one device in voice at a time)
//
// A DM call (ADR-0034) is a voice session of a DM room, which has no workspace: its voice
// scope is the DM room itself — the DM room id stands in for <workspace_id> in every key
// above, and RoomName(id, id) is the LiveKit room "dm:<room_id>". A workspace id never equals
// a room id, so wid == rid identifies a DM scope (IsDM).
package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// SessionState is the voice state of one device (LiveKit participant).
type SessionState struct {
	UserID    uuid.UUID `json:"u"`
	SessionID uuid.UUID `json:"s"`
	RoomID    uuid.UUID `json:"r"`
	Muted     bool      `json:"m,omitempty"`
	Deafened  bool      `json:"d,omitempty"`
	Streaming bool      `json:"st,omitempty"`
	Camera    bool      `json:"c,omitempty"`
	// Musician: the device sends its mic in musician mode (ADR-0052); PATCH /api/voice/self.
	Musician bool `json:"mu,omitempty"`
	// Pending: recorded by /join (or an app-level move) and not connected to LiveKit yet;
	// participant_joined clears it, a device that never connects is removed after 15 s.
	Pending  bool  `json:"p,omitempty"`
	JoinedAt int64 `json:"j"` // unix ms
}

// Stream is an active screen share track.
type Stream struct {
	Identity string               `json:"i"`
	UserID   uuid.UUID            `json:"u"`
	Preset   v1.ScreenSharePreset `json:"p"`
	Started  int64                `json:"t"`
}

// Identity is the LiveKit participant identity of a device session.
func Identity(userID, sessionID uuid.UUID) string { return userID.String() + ":" + sessionID.String() }

// ParseIdentity splits "<user_id>:<session_id>".
func ParseIdentity(id string) (userID, sessionID uuid.UUID, ok bool) {
	u, s, found := strings.Cut(id, ":")
	if !found {
		return uuid.Nil, uuid.Nil, false
	}
	uid, err1 := uuid.Parse(u)
	sid, err2 := uuid.Parse(s)
	return uid, sid, err1 == nil && err2 == nil
}

// RoomName is the LiveKit room name of a Calaba voice room; for a DM scope (workspaceID ==
// roomID) it is DMRoomName.
func RoomName(workspaceID, roomID uuid.UUID) string {
	if IsDM(workspaceID, roomID) {
		return DMRoomName(roomID)
	}
	return "ws_" + workspaceID.String() + "_room_" + roomID.String()
}

// DMRoomName is the LiveKit room of a DM call (ADR-0034): "dm:<room_id>".
func DMRoomName(roomID uuid.UUID) string { return dmPrefix + roomID.String() }

const dmPrefix = "dm:"

// IsDMRoomName reports a DM call's LiveKit room name.
func IsDMRoomName(name string) bool { return strings.HasPrefix(name, dmPrefix) }

// IsDM reports a DM voice scope: the DM room id is used as its workspace id.
func IsDM(workspaceID, roomID uuid.UUID) bool { return workspaceID == roomID }

// ParseRoomName is the inverse of RoomName; "dm:<room_id>" gives (room_id, room_id).
func ParseRoomName(name string) (workspaceID, roomID uuid.UUID, ok bool) {
	if id, found := strings.CutPrefix(name, dmPrefix); found {
		rid, err := uuid.Parse(id)
		return rid, rid, err == nil
	}
	rest, found := strings.CutPrefix(name, "ws_")
	if !found {
		return uuid.Nil, uuid.Nil, false
	}
	w, r, found := strings.Cut(rest, "_room_")
	if !found {
		return uuid.Nil, uuid.Nil, false
	}
	wid, err1 := uuid.Parse(w)
	rid, err2 := uuid.Parse(r)
	return wid, rid, err1 == nil && err2 == nil
}

// Aggregate computes the per-user voice state from all of the user's device sessions in a
// workspace: the user is in the room of their most recently joined session; muted/deafened
// = all sessions in that room are; streaming / camera / musician = any session in that room
// is; pending = all
// sessions in that room are still connecting (one connected device makes the user connected).
// Returns a state with empty RoomId when the user has no sessions.
func Aggregate(workspaceID, userID uuid.UUID, sessions []SessionState) *v1.VoiceState {
	out := &v1.VoiceState{WorkspaceId: workspaceID.String(), UserId: userID.String()}
	var latest *SessionState
	for i := range sessions {
		s := &sessions[i]
		if s.UserID != userID {
			continue
		}
		if latest == nil || s.JoinedAt > latest.JoinedAt || (s.JoinedAt == latest.JoinedAt && s.SessionID.String() > latest.SessionID.String()) {
			latest = s
		}
	}
	if latest == nil {
		return out
	}
	out.RoomId = latest.RoomID.String()
	out.Muted, out.Deafened, out.Pending = true, true, true
	joined := latest.JoinedAt
	for _, s := range sessions {
		if s.UserID != userID || s.RoomID != latest.RoomID {
			continue
		}
		out.Muted = out.Muted && s.Muted
		out.Deafened = out.Deafened && s.Deafened
		out.Streaming = out.Streaming || s.Streaming
		out.Camera = out.Camera || s.Camera
		out.Musician = out.Musician || s.Musician
		out.Pending = out.Pending && s.Pending
		joined = min(joined, s.JoinedAt)
	}
	out.JoinedAt = timestamppb.New(time.UnixMilli(joined))
	return out
}

// AggregateAll returns one state per user present in sessions, sorted by user id.
func AggregateAll(workspaceID uuid.UUID, sessions []SessionState) []*v1.VoiceState {
	users := map[uuid.UUID]bool{}
	for _, s := range sessions {
		users[s.UserID] = true
	}
	out := make([]*v1.VoiceState, 0, len(users))
	for u := range users {
		out = append(out, Aggregate(workspaceID, u, sessions))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetUserId() < out[j].GetUserId() })
	return out
}

// Equal compares two aggregated states.
func Equal(a, b *v1.VoiceState) bool {
	return a.GetRoomId() == b.GetRoomId() && a.GetMuted() == b.GetMuted() &&
		a.GetDeafened() == b.GetDeafened() && a.GetStreaming() == b.GetStreaming() && a.GetCamera() == b.GetCamera() &&
		a.GetJoinedAt().AsTime().Equal(b.GetJoinedAt().AsTime()) && a.GetServerMuted() == b.GetServerMuted() &&
		a.GetPending() == b.GetPending() && a.GetMusician() == b.GetMusician()
}

// Store is the Redis-backed voice state.
type Store struct {
	C rueidis.Client
	// OnCalls, if set, is called by UpdateLocked — still holding the workspace lock — with
	// the rooms whose call started or ended. Announcing them under the lock keeps start/end
	// events of a room in order across goroutines and instances (review 4 L7).
	OnCalls func(ctx context.Context, wid uuid.UUID, rooms []uuid.UUID)
}

func wsKey(wid uuid.UUID) string     { return redisx.Key("voice:ws:" + wid.String()) }
func sessKey(sid uuid.UUID) string   { return redisx.Key("voice:sess:" + sid.String()) }
func smutedKey(wid uuid.UUID) string { return redisx.Key("voice:smuted:" + wid.String()) }

// ServerMuted reports whether a moderator muted userID in the workspace.
func (s Store) ServerMuted(ctx context.Context, wid, userID uuid.UUID) (bool, error) {
	return s.C.Do(ctx, s.C.B().Sismember().Key(smutedKey(wid)).Member(userID.String()).Build()).AsBool()
}

// SetServerMuted sets or clears a user's server mute and returns the aggregate change.
func (s Store) SetServerMuted(ctx context.Context, wid, userID uuid.UUID, on bool) (Change, error) {
	var c Change
	err := s.WithLock(ctx, wid, func() error {
		all, err := s.List(ctx, wid)
		if err != nil {
			return err
		}
		was, err := s.ServerMuted(ctx, wid, userID)
		if err != nil {
			return err
		}
		cmd := s.C.B().Srem().Key(smutedKey(wid)).Member(userID.String()).Build()
		if on {
			cmd = s.C.B().Sadd().Key(smutedKey(wid)).Member(userID.String()).Build()
		}
		if err := s.C.Do(ctx, cmd).Error(); err != nil {
			return err
		}
		c.Before, c.After = Aggregate(wid, userID, all), Aggregate(wid, userID, all)
		c.Before.ServerMuted, c.After.ServerMuted = was, on
		return nil
	})
	return c, err
}

// Rooms returns who is in a call of the workspace and where (user -> room), pending
// devices included: the people a guest of that room sees (perm.GuestVisible).
func (s Store) Rooms(ctx context.Context, wid uuid.UUID) (map[uuid.UUID]uuid.UUID, error) {
	all, err := s.List(ctx, wid)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]uuid.UUID, len(all))
	for _, vs := range AggregateAll(wid, all) {
		u, uerr := uuid.Parse(vs.GetUserId())
		r, rerr := uuid.Parse(vs.GetRoomId())
		if uerr == nil && rerr == nil {
			out[u] = r
		}
	}
	return out, nil
}

// State returns one user's current aggregated voice state in the workspace (empty RoomId:
// not in voice), server mute included.
func (s Store) State(ctx context.Context, wid, userID uuid.UUID) (*v1.VoiceState, error) {
	all, err := s.List(ctx, wid)
	if err != nil {
		return nil, err
	}
	out := Aggregate(wid, userID, all)
	if out.ServerMuted, err = s.ServerMuted(ctx, wid, userID); err != nil {
		return nil, err
	}
	return out, nil
}

// States returns every user's aggregated voice state in the workspace (READY snapshots).
func (s Store) States(ctx context.Context, wid uuid.UUID) ([]*v1.VoiceState, error) {
	all, err := s.List(ctx, wid)
	if err != nil {
		return nil, err
	}
	muted, err := s.C.Do(ctx, s.C.B().Smembers().Key(smutedKey(wid)).Build()).AsStrSlice()
	if err != nil {
		return nil, err
	}
	sm := map[string]bool{}
	for _, u := range muted {
		sm[u] = true
	}
	out := AggregateAll(wid, all)
	for _, vs := range out {
		vs.ServerMuted = sm[vs.GetUserId()]
	}
	return out, nil
}
func streamsKey(rid uuid.UUID) string     { return redisx.Key("voice:streams:" + rid.String()) }
func streamReqKey(identity string) string { return redisx.Key("voice:streamreq:" + identity) }
func camerasKey(rid uuid.UUID) string     { return redisx.Key("voice:cameras:" + rid.String()) }
func cameraReqKey(identity string) string { return redisx.Key("voice:camreq:" + identity) }
func cameraOffKey(identity string) string { return redisx.Key("voice:camoff:" + identity) }
func startedKey(rid uuid.UUID) string     { return redisx.Key("voice:started:" + rid.String()) }
func workspacesKey() string               { return redisx.Key("voice:workspaces") }

// List returns all device sessions in a workspace.
func (s Store) List(ctx context.Context, wid uuid.UUID) ([]SessionState, error) {
	m, err := s.C.Do(ctx, s.C.B().Hgetall().Key(wsKey(wid)).Build()).AsStrMap()
	if err != nil {
		return nil, err
	}
	out := make([]SessionState, 0, len(m))
	for _, v := range m {
		var st SessionState
		if json.Unmarshal([]byte(v), &st) == nil {
			out = append(out, st)
		}
	}
	return out, nil
}

// Workspaces returns workspaces that may have voice state.
func (s Store) Workspaces(ctx context.Context) ([]uuid.UUID, error) {
	ms, err := s.C.Do(ctx, s.C.B().Smembers().Key(workspacesKey()).Build()).AsStrSlice()
	if err != nil {
		return nil, err
	}
	out := make([]uuid.UUID, 0, len(ms))
	for _, m := range ms {
		if id, err := uuid.Parse(m); err == nil {
			out = append(out, id)
		}
	}
	return out, nil
}

// Change is the result of a mutation: the user's aggregate before and after.
type Change struct {
	Before, After *v1.VoiceState
	// Calls lists rooms whose call started (first connected device) or ended (last connected
	// device gone) with this change; ROOM_UPDATE with voice_started_at is due for them.
	Calls []uuid.UUID
}

// Changed reports whether the aggregate changed (i.e. VOICE_STATE_UPDATE is due).
func (c Change) Changed() bool { return !Equal(c.Before, c.After) }

var errLockTimeout = errors.New("voice: workspace lock timeout")

// delInScopeScript deletes a device location (voice:sess) only if it starts with ARGV[1]
// ("<scope id>/").
var delInScopeScript = rueidis.NewLuaScript(`
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, #ARGV[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`)

// unlockScript deletes the lock only if we still own it.
var unlockScript = rueidis.NewLuaScript(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`)

// WithLock runs fn holding the workspace's voice lock: all read-modify-write of voice
// state (and checks that must be atomic with it, like user_limit) happen under it.
func (s Store) WithLock(ctx context.Context, wid uuid.UUID, fn func() error) error {
	return s.withKeyLock(ctx, redisx.Key("voice:lock:"+wid.String()), fn)
}

// WithUserLock runs fn holding the user's /join lock (one device in voice at a time, docs/05
// "Несколько устройств"): two devices joining at once are ordered, the later one takes out
// the earlier. Lock order: the user lock before any workspace lock.
func (s Store) WithUserLock(ctx context.Context, uid uuid.UUID, fn func() error) error {
	return s.withKeyLock(ctx, redisx.Key("voice:ulock:"+uid.String()), fn)
}

func (s Store) withKeyLock(ctx context.Context, key string, fn func() error) error {
	token := uuid.NewString()
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := s.C.Do(ctx, s.C.B().Set().Key(key).Value(token).Nx().Px(5*time.Second).Build()).Error()
		if err == nil {
			break
		}
		if !rueidis.IsRedisNil(err) {
			return err
		}
		if time.Now().After(deadline) {
			return errLockTimeout
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
	defer unlockScript.Exec(context.WithoutCancel(ctx), s.C, []string{key}, []string{token})
	return fn()
}

// Update applies fn to the session's state (nil = absent; returning nil removes it) and
// returns the user's aggregate before/after. Atomic per workspace (WithLock).
func (s Store) Update(ctx context.Context, wid, userID, sessionID uuid.UUID, fn func(cur *SessionState) *SessionState) (Change, error) {
	var c Change
	err := s.WithLock(ctx, wid, func() error {
		var err error
		c, err = s.UpdateLocked(ctx, wid, userID, sessionID, fn)
		return err
	})
	return c, err
}

// UpdateLocked is Update for callers already inside WithLock.
func (s Store) UpdateLocked(ctx context.Context, wid, userID, sessionID uuid.UUID, fn func(cur *SessionState) *SessionState) (Change, error) {
	all, err := s.List(ctx, wid)
	if err != nil {
		return Change{}, err
	}
	before := Aggregate(wid, userID, all)
	var cur *SessionState
	rest := all[:0:0]
	for i := range all {
		if all[i].UserID == userID && all[i].SessionID == sessionID {
			c := all[i]
			cur = &c
			continue
		}
		rest = append(rest, all[i])
	}
	next := fn(cur)
	field := Identity(userID, sessionID)
	var cmds rueidis.Commands
	if next == nil {
		cmds = append(cmds, s.C.B().Hdel().Key(wsKey(wid)).Field(field).Build())
		// The device's location goes only if it still points into this scope: a device that
		// joined another scope meanwhile (a DM call after a workspace room, or another
		// workspace) keeps its new location when the old room's participant_left arrives.
		if err := delInScopeScript.Exec(ctx, s.C, []string{sessKey(sessionID)}, []string{wid.String() + "/"}).Error(); err != nil {
			return Change{}, err
		}
	} else {
		next.UserID, next.SessionID = userID, sessionID
		if next.JoinedAt == 0 {
			next.JoinedAt = time.Now().UnixMilli()
		}
		b, _ := json.Marshal(next)
		cmds = append(cmds, s.C.B().Hset().Key(wsKey(wid)).FieldValue().FieldValue(field, string(b)).Build(),
			s.C.B().Set().Key(sessKey(sessionID)).Value(wid.String()+"/"+next.RoomID.String()).Build(),
			s.C.B().Sadd().Key(workspacesKey()).Member(wid.String()).Build())
		rest = append(rest, *next)
	}
	// Call start per room: set when a room gains its first connected device, cleared when the
	// last one goes. Pending devices (optimistic /join, app-level move) do not make a call: a
	// join rolled back before LiveKit connected leaves no phantom call behind.
	var calls []uuid.UUID
	now := strconv.FormatInt(time.Now().UnixMilli(), 10)
	for _, rid := range touchedRooms(cur, next) {
		was, is := occupied(all, rid), occupied(rest, rid)
		switch {
		case !was && is:
			start := now // connected just now (pending cleared by participant_joined / reconcile)
			if next != nil && next.RoomID == rid && (cur == nil || cur.RoomID != rid) {
				start = strconv.FormatInt(next.JoinedAt, 10) // recorded connected: the call starts with this join
			}
			cmds = append(cmds, s.C.B().Set().Key(startedKey(rid)).Value(start).Build())
			calls = append(calls, rid)
		case was && is: // heals a missing key, keeps the running call's start
			cmds = append(cmds, s.C.B().Set().Key(startedKey(rid)).Value(now).Nx().Build())
		default:
			cmds = append(cmds, s.C.B().Del().Key(startedKey(rid)).Build())
			if was {
				calls = append(calls, rid)
			}
		}
	}
	for _, r := range s.C.DoMulti(ctx, cmds...) {
		if err := r.Error(); err != nil && !rueidis.IsRedisNil(err) {
			return Change{}, err
		}
	}
	after := Aggregate(wid, userID, rest)
	sm, err := s.ServerMuted(ctx, wid, userID)
	if err != nil {
		return Change{}, err
	}
	before.ServerMuted, after.ServerMuted = sm, sm
	if len(calls) > 0 && s.OnCalls != nil {
		s.OnCalls(ctx, wid, calls)
	}
	return Change{Before: before, After: after, Calls: calls}, nil
}

func touchedRooms(cur, next *SessionState) []uuid.UUID {
	var out []uuid.UUID
	if cur != nil {
		out = append(out, cur.RoomID)
	}
	if next != nil && (cur == nil || next.RoomID != cur.RoomID) {
		out = append(out, next.RoomID)
	}
	return out
}

// occupied reports a call in rid: a device connected to it (pending ones do not count).
func occupied(sessions []SessionState, rid uuid.UUID) bool {
	for _, s := range sessions {
		if s.RoomID == rid && !s.Pending {
			return true
		}
	}
	return false
}

// StartedAt returns when the current call in each room began (rooms without a call are absent).
func (s Store) StartedAt(ctx context.Context, rids []uuid.UUID) (map[uuid.UUID]time.Time, error) {
	out := map[uuid.UUID]time.Time{}
	if len(rids) == 0 {
		return out, nil
	}
	cmds := make(rueidis.Commands, len(rids))
	for i, r := range rids {
		cmds[i] = s.C.B().Get().Key(startedKey(r)).Build()
	}
	for i, res := range s.C.DoMulti(ctx, cmds...) {
		ms, err := res.AsInt64()
		if rueidis.IsRedisNil(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out[rids[i]] = time.UnixMilli(ms)
	}
	return out, nil
}

// Forget removes a workspace from the reconcile set if it has no voice state.
func (s Store) Forget(ctx context.Context, wid uuid.UUID) error {
	return s.WithLock(ctx, wid, func() error {
		n, err := s.C.Do(ctx, s.C.B().Hlen().Key(wsKey(wid)).Build()).AsInt64()
		if err != nil || n > 0 {
			return err
		}
		return s.C.Do(ctx, s.C.B().Srem().Key(workspacesKey()).Member(wid.String()).Build()).Error()
	})
}

// Location returns where a device session is connected (ok=false if not in voice).
func (s Store) Location(ctx context.Context, sessionID uuid.UUID) (wid, rid uuid.UUID, ok bool, err error) {
	v, err := s.C.Do(ctx, s.C.B().Get().Key(sessKey(sessionID)).Build()).ToString()
	if rueidis.IsRedisNil(err) {
		return uuid.Nil, uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, false, err
	}
	w, r, _ := strings.Cut(v, "/")
	wid, err1 := uuid.Parse(w)
	rid, err2 := uuid.Parse(r)
	return wid, rid, err1 == nil && err2 == nil, nil
}

// Locations returns where each of the device sessions is in voice; sessions not in voice
// are absent. One round trip (MGET).
func (s Store) Locations(ctx context.Context, sessionIDs []uuid.UUID) (map[uuid.UUID][2]uuid.UUID, error) {
	out := map[uuid.UUID][2]uuid.UUID{}
	if len(sessionIDs) == 0 {
		return out, nil
	}
	keys := make([]string, len(sessionIDs))
	for i, sid := range sessionIDs {
		keys[i] = sessKey(sid)
	}
	vals, err := s.C.Do(ctx, s.C.B().Mget().Key(keys...).Build()).ToArray()
	if err != nil {
		return nil, err
	}
	for i, v := range vals {
		str, err := v.ToString()
		if err != nil {
			continue // nil: not in voice
		}
		w, r, _ := strings.Cut(str, "/")
		wid, err1 := uuid.Parse(w)
		rid, err2 := uuid.Parse(r)
		if err1 == nil && err2 == nil {
			out[sessionIDs[i]] = [2]uuid.UUID{wid, rid}
		}
	}
	return out, nil
}

func supersededKey(sid uuid.UUID) string { return redisx.Key("voice:superseded:" + sid.String()) }

// supersededTTL outlives a join token (10 min): a device taken out cannot come back with the
// token it had.
const supersededTTL = 15 * time.Minute

// Supersede marks a device session as taken out of room rid of scope wid because the user
// joined voice from another device: its LiveKit connection there is refused from now on
// (participant_joined, reconcile) until the device itself joins again (ClearSuperseded).
func (s Store) Supersede(ctx context.Context, sid, wid, rid uuid.UUID) error {
	return s.C.Do(ctx, s.C.B().Set().Key(supersededKey(sid)).Value(wid.String()+"/"+rid.String()).Ex(supersededTTL).Build()).Error()
}

// ClearSuperseded drops the mark of Supersede: the device joined voice again itself.
func (s Store) ClearSuperseded(ctx context.Context, sid uuid.UUID) error {
	return s.C.Do(ctx, s.C.B().Del().Key(supersededKey(sid)).Build()).Error()
}

// Superseded reports whether the device session was taken out of room rid of scope wid for
// another device of the user (Supersede).
func (s Store) Superseded(ctx context.Context, sid, wid, rid uuid.UUID) (bool, error) {
	v, err := s.C.Do(ctx, s.C.B().Get().Key(supersededKey(sid)).Build()).ToString()
	if rueidis.IsRedisNil(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return v == wid.String()+"/"+rid.String(), nil
}

// Streams returns active streams in a room keyed by track sid.
func (s Store) Streams(ctx context.Context, rid uuid.UUID) (map[string]Stream, error) {
	m, err := s.C.Do(ctx, s.C.B().Hgetall().Key(streamsKey(rid)).Build()).AsStrMap()
	if err != nil {
		return nil, err
	}
	out := make(map[string]Stream, len(m))
	for k, v := range m {
		var st Stream
		if json.Unmarshal([]byte(v), &st) == nil {
			out[k] = st
		}
	}
	return out, nil
}

// addStream atomically records a stream unless the room already has `max` other streams.
var addStream = rueidis.NewLuaScript(`
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 1 end
local max = tonumber(ARGV[3])
if max >= 0 and redis.call('HLEN', KEYS[1]) >= max then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`)

// AddStream records a stream if the room has fewer than limit streams (limit < 0: none).
// Check and insert are one atomic step, so two concurrent streams cannot both pass.
func (s Store) AddStream(ctx context.Context, rid uuid.UUID, trackSID string, st Stream, limit int) (bool, error) {
	b, _ := json.Marshal(st)
	n, err := addStream.Exec(ctx, s.C, []string{streamsKey(rid)}, []string{trackSID, string(b), strconv.Itoa(limit)}).AsInt64()
	return n == 1, err
}

// RemoveStream deletes a stream; ok=false if it was not recorded.
func (s Store) RemoveStream(ctx context.Context, rid uuid.UUID, trackSID string) (bool, error) {
	n, err := s.C.Do(ctx, s.C.B().Hdel().Key(streamsKey(rid)).Field(trackSID).Build()).AsInt64()
	return n > 0, err
}

// ClearRoom removes a room's streams and cameras (room finished).
func (s Store) ClearRoom(ctx context.Context, rid uuid.UUID) error {
	return s.C.Do(ctx, s.C.B().Del().Key(streamsKey(rid), camerasKey(rid)).Build()).Error()
}

// Camera is an active webcam track.
type Camera struct {
	Identity string    `json:"i"`
	UserID   uuid.UUID `json:"u"`
	Started  int64     `json:"s,omitempty"` // unix ms when recorded (reconcile spares young records)
}

// Cameras returns active webcams in a room keyed by track sid.
func (s Store) Cameras(ctx context.Context, rid uuid.UUID) (map[string]Camera, error) {
	m, err := s.C.Do(ctx, s.C.B().Hgetall().Key(camerasKey(rid)).Build()).AsStrMap()
	if err != nil {
		return nil, err
	}
	out := make(map[string]Camera, len(m))
	for sid, raw := range m {
		var c Camera
		if json.Unmarshal([]byte(raw), &c) == nil {
			out[sid] = c
		}
	}
	return out, nil
}

// AddCamera records a webcam if the room has fewer than limit cameras (limit < 0: none);
// the check and the insert are one atomic step (same script as streams).
func (s Store) AddCamera(ctx context.Context, rid uuid.UUID, trackSID string, c Camera, limit int) (bool, error) {
	b, _ := json.Marshal(c)
	n, err := addStream.Exec(ctx, s.C, []string{camerasKey(rid)}, []string{trackSID, string(b), strconv.Itoa(limit)}).AsInt64()
	return n == 1, err
}

// RemoveCamera deletes a webcam record; ok=false if it was not recorded.
func (s Store) RemoveCamera(ctx context.Context, rid uuid.UUID, trackSID string) (bool, error) {
	n, err := s.C.Do(ctx, s.C.B().Hdel().Key(camerasKey(rid)).Field(trackSID).Build()).AsInt64()
	return n > 0, err
}

// ReserveCamera lets a device publish a webcam (grant) for 10 minutes; ReleaseCamera ends it.
func (s Store) ReserveCamera(ctx context.Context, identity string) error {
	return s.C.Do(ctx, s.C.B().Set().Key(cameraReqKey(identity)).Value("1").Ex(10*time.Minute).Build()).Error()
}

// ReleaseCamera drops a device's camera reservation; had reports whether there was one.
func (s Store) ReleaseCamera(ctx context.Context, identity string) (had bool, err error) {
	n, err := s.C.Do(ctx, s.C.B().Del().Key(cameraReqKey(identity)).Build()).AsInt64()
	return n > 0, err
}

// BlockCamera marks a device's camera as stopped by a moderator (sticky; 12 h safety TTL,
// cleared when the device leaves the call or by AllowCamera).
func (s Store) BlockCamera(ctx context.Context, identity string) error {
	return s.C.Do(ctx, s.C.B().Set().Key(cameraOffKey(identity)).Value("1").Ex(12*time.Hour).Build()).Error()
}

// AllowCamera lifts a moderator's camera stop for a device.
func (s Store) AllowCamera(ctx context.Context, identity string) error {
	return s.C.Do(ctx, s.C.B().Del().Key(cameraOffKey(identity)).Build()).Error()
}

// CameraBlocked reports a moderator's camera stop for a device.
func (s Store) CameraBlocked(ctx context.Context, identity string) (bool, error) {
	n, err := s.C.Do(ctx, s.C.B().Exists().Key(cameraOffKey(identity)).Build()).AsInt64()
	return n > 0, err
}

// CameraHeld reports whether a device may keep the camera source in its grant: it is not
// blocked by a moderator and has a reservation or a recorded webcam in the room.
func (s Store) CameraHeld(ctx context.Context, rid uuid.UUID, identity string) (bool, error) {
	if blocked, err := s.CameraBlocked(ctx, identity); err != nil || blocked {
		return false, err
	}
	n, err := s.C.Do(ctx, s.C.B().Exists().Key(cameraReqKey(identity)).Build()).AsInt64()
	if err != nil || n > 0 {
		return n > 0, err
	}
	cams, err := s.Cameras(ctx, rid)
	if err != nil {
		return false, err
	}
	for _, c := range cams {
		if c.Identity == identity {
			return true, nil
		}
	}
	return false, nil
}

// ReserveStream stores the preset requested by a device (consumed by track_published).
func (s Store) ReserveStream(ctx context.Context, identity string, p v1.ScreenSharePreset) error {
	return s.C.Do(ctx, s.C.B().Set().Key(streamReqKey(identity)).Value(fmt.Sprint(int32(p))).Ex(10*time.Minute).Build()).Error()
}

// ReservedStream returns the reserved preset (UNSPECIFIED if none).
func (s Store) ReservedStream(ctx context.Context, identity string) v1.ScreenSharePreset {
	n, err := s.C.Do(ctx, s.C.B().Get().Key(streamReqKey(identity)).Build()).AsInt64()
	if err != nil {
		return v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED
	}
	return v1.ScreenSharePreset(n) //nolint:gosec // small enum
}
