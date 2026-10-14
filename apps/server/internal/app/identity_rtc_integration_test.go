//go:build integration

package app_test

import (
	"context"
	"fmt"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
)

type identitySFU struct {
	rtc.LiveKit
	mu          sync.Mutex
	people      map[string]map[string]rtc.Participant
	removed     []string
	afterCreate func()
}

func (s *identitySFU) CreateRoom(_ context.Context, name string, _, _ uint32) error {
	s.mu.Lock()
	if s.people[name] == nil {
		s.people[name] = map[string]rtc.Participant{}
	}
	hook := s.afterCreate
	s.afterCreate = nil
	s.mu.Unlock()
	if hook != nil {
		hook()
	}
	return nil
}
func (s *identitySFU) ListRooms(context.Context) ([]rtc.Room, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []rtc.Room{}
	for name := range s.people {
		out = append(out, rtc.Room{Name: name})
	}
	return out, nil
}
func (s *identitySFU) ListParticipants(_ context.Context, name string) ([]rtc.Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []rtc.Participant{}
	for _, p := range s.people[name] {
		out = append(out, p)
	}
	return out, nil
}
func (s *identitySFU) GetParticipant(_ context.Context, room, id string) (*rtc.Participant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.people[room][id]
	if !ok {
		return nil, &rtc.Error{Code: "not_found", Status: 404}
	}
	return &p, nil
}
func (s *identitySFU) RemoveParticipant(_ context.Context, room, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.people[room], id)
	s.removed = append(s.removed, room+":"+id)
	return nil
}
func (s *identitySFU) UpdatePermission(context.Context, string, string, rtc.Permission) error {
	return nil
}
func (s *identitySFU) MoveParticipant(_ context.Context, room, id, dst string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.people[room][id]
	delete(s.people[room], id)
	if s.people[dst] == nil {
		s.people[dst] = map[string]rtc.Participant{}
	}
	s.people[dst][id] = p
	return nil
}
func (s *identitySFU) put(room, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.people[room] == nil {
		s.people[room] = map[string]rtc.Participant{}
	}
	s.people[room][id] = rtc.Participant{Identity: id, Sid: uuid.NewString()}
}
func (s *identitySFU) wasRemoved(room, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Contains(s.removed, room+":"+id)
}
func identityVoiceRooms(t *testing.T, f identityFixture) (string, string) {
	t.Helper()
	ownerID := uuid.MustParse(owner(t).id)
	ids := []string{}
	for _, ws := range []string{f.a.Id, f.b.Id} {
		room, err := testDB.Q.CreateRoom(context.Background(), sqlc.CreateRoomParams{WorkspaceID: uuid.MustParse(ws), Name: "Identity voice", Type: "voice", CreatedBy: &ownerID})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, room.ID.String())
	}
	return ids[0], ids[1]
}

func TestIdentityRTCReconcileWithLostRedisPreservesIndependentWorkspace(t *testing.T) {
	f := identitySetup(t, "enforced")
	ra, rb := identityVoiceRooms(t, f)
	uid := uuid.MustParse(f.local.id)
	wsA, wsB := uuid.MustParse(f.a.Id), uuid.MustParse(f.b.Id)
	identity := voice.Identity(uid, f.scopedSession.ID)
	localIdentity := voice.Identity(uid, uuid.MustParse(f.local.session))
	roomA, roomB := voice.RoomName(wsA, uuid.MustParse(ra)), voice.RoomName(wsB, uuid.MustParse(rb))
	sfu := &identitySFU{LiveKit: lkRec, people: map[string]map[string]rtc.Participant{}}
	sfu.put(roomA, identity)
	sfu.put(roomB, localIdentity)
	r, err := redisx.Connect(context.Background(), testRedisURL)
	if err != nil {
		t.Fatal(err)
	}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: r, LiveKit: sfu, Events: events.Nop{}, Blob: testStore, Mail: testMail})
	if err := a.RTC.EnforceIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sfu.wasRemoved(roomA, identity) || sfu.wasRemoved(roomB, localIdentity) {
		t.Fatal("positive corporate/independent sessions evicted")
	}
	if _, err = testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: wsA, SessionID: &f.scopedSession.ID}); err != nil {
		t.Fatal(err)
	}
	r.Close() // no invalidation pubsub and no voice bookkeeping is available
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if err := a.RTC.EnforceIdentity(ctx); err != nil {
		t.Fatal(err)
	}
	if !sfu.wasRemoved(roomA, identity) || sfu.wasRemoved(roomB, localIdentity) {
		t.Fatal("DB policy eviction did not isolate A from independent B")
	}
}

func TestIdentityRTCJoinAndLiveReplayRecheckAfterRevocation(t *testing.T) {
	f := identitySetup(t, "enforced")
	ra, rb := identityVoiceRooms(t, f)
	uid := uuid.MustParse(f.local.id)
	ws := uuid.MustParse(f.a.Id)
	rid := uuid.MustParse(ra)
	sfu := &identitySFU{LiveKit: lkRec, people: map[string]map[string]rtc.Participant{}}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, LiveKit: sfu, Events: events.Nop{}, Blob: testStore, Mail: testMail})
	server := httptest.NewServer(a.Handler)
	defer server.Close()
	// Workspace B cannot be selected with a valid A device, including voice routes.
	status, _, _ := identityRequest(t, server.URL, "POST", "/api/rooms/"+rb+"/join", f.scoped.token, "https://app.example.com", nil, nil)
	if status != 403 {
		t.Fatalf("cross-workspace join=%d", status)
	}
	sfu.mu.Lock()
	sfu.afterCreate = func() {
		_, err := testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: ws, SessionID: &f.scopedSession.ID})
		if err != nil {
			t.Error(err)
		}
	}
	sfu.mu.Unlock()
	status, raw, _ := identityRequest(t, server.URL, "POST", "/api/rooms/"+ra+"/join", f.scoped.token, "https://app.example.com", nil, nil)
	if status != 403 {
		t.Fatalf("join granted after remote preparation/revocation=%d %s", status, raw)
	}
	name := voice.RoomName(ws, rid)
	identity := voice.Identity(uid, f.scopedSession.ID)
	for _, event := range []string{rtc.EventParticipantJoined, rtc.EventTrackPublished} {
		sfu.put(name, identity)
		if err := a.RTC.HandleEvent(context.Background(), &rtc.WebhookEvent{Event: event, Room: &rtc.Room{Name: name}, Participant: &rtc.Participant{Identity: identity, Sid: uuid.NewString()}, Track: &rtc.Track{Sid: "TR_replay", Source: rtc.SourceMicrophone}}); err != nil {
			t.Fatal(err)
		}
		if _, err := sfu.GetParticipant(context.Background(), name, identity); !rtc.IsNotFound(err) {
			t.Fatalf("stale/live replay %s remained connected", event)
		}
	}
	// Room/workspace mismatches and a session belonging to another user fail closed.
	if err := a.RTC.IdentityAccess(context.Background(), uuid.MustParse(f.b.Id), rid, uid, f.scopedSession.ID); err == nil {
		t.Fatal("SFU workspace mismatch admitted")
	}
	if err := a.RTC.IdentityAccess(context.Background(), ws, rid, uuid.MustParse(owner(t).id), f.scopedSession.ID); err == nil {
		t.Fatal("SFU device/user mismatch admitted")
	}
}

// The sweep checks a room's devices together, reading each kind of row once; every verdict
// must be the one the single-device check (a room of one) gives.
func TestIdentityRTCRoomCheckMatchesSingleChecks(t *testing.T) {
	f := identitySetup(t, "optional")
	ra, _ := identityVoiceRooms(t, f)
	ctx := context.Background()
	o := owner(t)
	b := createBot(t, o, f.a.Id, "sweep") // enforced mode would require SSO from the owner
	wsA, wsB, rid := uuid.MustParse(f.a.Id), uuid.MustParse(f.b.Id), uuid.MustParse(ra)
	policy, err := testDB.Q.EnsureIdentityPolicy(ctx, wsA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = testDB.Q.SetIdentityPolicy(ctx, sqlc.SetIdentityPolicyParams{WorkspaceID: wsA, Mode: "enforced", AssuranceMaxAgeSeconds: 3600, ExpectedVersion: policy.Version}); err != nil {
		t.Fatal(err)
	}
	f.prove(t, f.scopedSession.ID, time.Now()) // the assurance binds the policy version
	botID := uuid.MustParse(b.id)
	botAuth, err := testDB.Q.GetBotAuth(ctx, botID)
	if err != nil || botAuth.TokenID == nil {
		t.Fatalf("bot auth: %v", err)
	}
	var dm v1.CreateDmResponse
	o.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: f.local.id}, &dm)
	uid, oid := uuid.MustParse(f.local.id), uuid.MustParse(o.id)
	people := []rtc.IdentityKey{
		{User: uid, Session: f.scopedSession.ID},
		{User: uid, Session: uuid.MustParse(f.local.session)},
		{User: oid, Session: uuid.MustParse(o.session)},
		{User: oid, Session: f.scopedSession.ID},
		{User: botID, Session: *botAuth.TokenID},
		{User: botID, Session: uuid.New()},
		{User: uuid.New(), Session: uuid.New()},
	}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, LiveKit: lkRec, Events: events.Nop{}, Blob: testStore, Mail: testMail})
	dmID := uuid.MustParse(dm.GetDm().GetRoom().GetId())
	check := func(stage string, ws, room uuid.UUID, admitted string) {
		t.Helper()
		roomCheckMatchesSingle(t, a, stage, ws, room, people, admitted)
	}
	check("enforced", wsA, rid, "+---+--")
	check("dm", dmID, dmID, "-++----")
	check("workspace mismatch", wsB, rid, "-------")
	if _, err = testDB.Q.RevokeWorkspaceAssurances(ctx, sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: wsA, SessionID: &f.scopedSession.ID}); err != nil {
		t.Fatal(err)
	}
	check("revoked", wsA, rid, "----+--")
}

// The room statements (users, sessions, identity states, room access for a list) and the
// single-device ones they mirror give the same verdicts, user overrides of a private room included.
func TestIdentityRTCRoomCheckMatchesSingleChecksWithOverrides(t *testing.T) {
	ctx := context.Background()
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.Id+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "v", IsPrivate: true}, &cr)
	rid := uuid.MustParse(cr.GetRoom().GetId())
	allowed, denied, plain := register(t, invite(t, o, ws.Id)), register(t, invite(t, o, ws.Id)), register(t, invite(t, o, ws.Id))
	outsider := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).Id)) // a member elsewhere
	if _, err := testDB.Pool.Exec(ctx, "INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny) VALUES ($1, 'user', $2, $3, 0), ($1, 'user', $4, $5, $6)",
		rid, allowed.id, int64(perm.ViewRoom|perm.Connect), denied.id, int64(perm.ViewRoom), int64(perm.Connect)); err != nil {
		t.Fatal(err)
	}
	key := func(u *user) rtc.IdentityKey {
		return rtc.IdentityKey{User: uuid.MustParse(u.id), Session: uuid.MustParse(u.session)}
	}
	people := []rtc.IdentityKey{key(o), key(allowed), key(denied), key(plain), key(outsider)}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, LiveKit: lkRec, Events: events.Nop{}, Blob: testStore, Mail: testMail})
	roomCheckMatchesSingle(t, a, "overrides", uuid.MustParse(ws.Id), rid, people, "++---")
}

// roomCheckMatchesSingle: IdentityAccessRoom gives every device the verdict IdentityAccess gives
// it alone, and admitted is the resulting pattern (+ admitted, - denied) in people order.
func roomCheckMatchesSingle(t *testing.T, a *app.App, stage string, ws, room uuid.UUID, people []rtc.IdentityKey, admitted string) {
	t.Helper()
	ctx := context.Background()
	got := a.RTC.IdentityAccessRoom(ctx, ws, room, people)
	if len(got) != len(people) {
		t.Fatalf("%s: %d verdicts for %d people", stage, len(got), len(people))
	}
	pattern := ""
	for i, p := range people {
		one := a.RTC.IdentityAccess(ctx, ws, room, p.User, p.Session)
		if fmt.Sprint(got[i]) != fmt.Sprint(one) {
			t.Fatalf("%s person %d: room check %v, single check %v", stage, i, got[i], one)
		}
		if one == nil {
			pattern += "+"
		} else {
			pattern += "-"
		}
	}
	if pattern != admitted {
		t.Fatalf("%s: admitted %s, want %s", stage, pattern, admitted)
	}
}
