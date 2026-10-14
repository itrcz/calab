//go:build integration

package app_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rtc"
)

func voiceRoom(t *testing.T, o *user, wsID, name string, limit uint32) string {
	t.Helper()
	var r v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wsID+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: name, UserLimit: limit}, &r)
	return r.GetRoom().GetId()
}

// joinVoice issues a join token and confirms the participant via a signed webhook.
func joinVoice(t *testing.T, u *user, wsID, roomID string) string {
	t.Helper()
	var j v1.JoinVoiceResponse
	u.must(200, "POST", "/api/rooms/"+roomID+"/join", nil, &j)
	webhook(t, whEvent("participant_joined", "ws_"+wsID+"_room_"+roomID, j.GetIdentity(), nil), "secret")
	return j.GetIdentity()
}

func TestUserLimit(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, _ := setupTeam(t)
	alice := register(t, invite(t, o, ws.GetId()))
	small := voiceRoom(t, o, ws.GetId(), "duo", 1)
	joinVoice(t, bob, ws.GetId(), small)
	time.Sleep(50 * time.Millisecond)

	var e v1.ApiError
	if st := alice.do("POST", "/api/rooms/"+small+"/join", nil, &e); st != 409 {
		t.Fatalf("full room: %d", st)
	}
	raw := alice.rawErr("POST", "/api/rooms/"+small+"/join")
	if raw.GetCode() != v1.ErrorCode_ERROR_CODE_ROOM_FULL {
		t.Fatalf("error code: %v", raw.GetCode())
	}
	// Owner, 07.10: only the workspace owner ignores the limit; ADMINISTRATOR and MOVE_MEMBERS do not.
	adm := register(t, invite(t, o, ws.GetId()))
	mod := register(t, invite(t, o, ws.GetId()))
	rs := listRoles(t, o, ws.GetId())
	if st, _ := setMemberRoles(o, ws.GetId(), adm.id, rs[1].GetId()); st != 200 {
		t.Fatalf("make admin: %d", st)
	}
	modRole := newRole(t, o, ws.GetId(), "Mods", perm.MoveMembers)
	if st, _ := setMemberRoles(o, ws.GetId(), mod.id, modRole.GetId()); st != 200 {
		t.Fatalf("make moderator: %d", st)
	}
	for name, u := range map[string]*user{"admin": adm, "moderator": mod} {
		if st := u.do("POST", "/api/rooms/"+small+"/join", nil, nil); st != 409 {
			t.Fatalf("%s into a full room: %d, want 409", name, st)
		}
	}
	o.must(200, "POST", "/api/rooms/"+small+"/join", nil, nil)   // the owner ignores the limit
	bob.must(200, "POST", "/api/rooms/"+small+"/join", nil, nil) // already inside: second device is fine
	var tr v1.CreateRoomResponse
	o.must(422, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "t", UserLimit: 2}, &tr)
	hundred := uint32(100)
	o.must(422, "PATCH", "/api/rooms/"+small, &v1.UpdateRoomRequest{UserLimit: &hundred}, nil)
	zero := uint32(0)
	o.must(200, "PATCH", "/api/rooms/"+small, &v1.UpdateRoomRequest{UserLimit: &zero}, nil)
	alice.must(200, "POST", "/api/rooms/"+small+"/join", nil, nil)
}

func TestMoveMember(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, roomA := setupTeam(t)
	wid, a := ws.GetId(), roomA.GetId()
	b := voiceRoom(t, o, wid, "B", 0)
	full := voiceRoom(t, o, wid, "Full", 1)
	alice := register(t, invite(t, o, wid))

	// Compatibility with the real LiveKit: our MoveParticipant request (token with roomAdmin +
	// destinationRoom, JSON body) is accepted; for an absent participant LiveKit answers
	// not_found or "no response from servers" (503) — anything but an auth/argument error.
	ctx := context.Background()
	src, dst := "ws_"+wid+"_room_"+a, "ws_"+wid+"_room_"+b
	_ = lkRec.CreateRoom(ctx, src, 60, 10)
	_ = lkRec.CreateRoom(ctx, dst, 60, 10)
	var lkErr *rtc.Error
	if err := lkRec.LiveKit.MoveParticipant(ctx, src, "nobody:nobody", dst); !errors.As(err, &lkErr) ||
		lkErr.Status == 401 || lkErr.Status == 403 || lkErr.Code == "invalid_argument" || lkErr.Code == "malformed" {
		t.Fatalf("real LiveKit MoveParticipant rejected our request: %v", err)
	}

	lkRec.mu.Lock()
	lkRec.fakeMove = true
	lkRec.mu.Unlock()
	testApp.RTC.SetSFUMove(true) // fakeMove stands for a LiveKit with MoveParticipant
	defer func() { lkRec.mu.Lock(); lkRec.fakeMove = false; lkRec.mu.Unlock() }()

	bg := dialGW(t)
	bg.identify(bob.token)
	joinVoice(t, bob, wid, a)
	joinVoice(t, alice, wid, full)

	move := func(u *user, from, userID, to string) int {
		return u.do("POST", "/api/rooms/"+from+"/voice/"+userID+"/move", &v1.MoveMemberRequest{TargetRoomId: to}, nil)
	}
	if st := move(alice, a, bob.id, b); st != 403 {
		t.Fatalf("member without MOVE_MEMBERS: %d", st)
	}
	var tr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "t"}, &tr)
	if st := move(o, a, bob.id, tr.GetRoom().GetId()); st != 422 {
		t.Fatalf("text target: %d", st)
	}
	// The moved user must be able to connect to the target.
	o.must(200, "PUT", "/api/rooms/"+b+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Deny: uint64(perm.Connect)},
	}}, nil)
	if st := move(o, a, bob.id, b); st != 403 {
		t.Fatalf("target without CONNECT: %d", st)
	}
	o.must(200, "PUT", "/api/rooms/"+b+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)

	if st := move(o, a, bob.id, b); st != 204 {
		t.Fatalf("move: %d", st)
	}
	var mv *v1.VoiceMoved
	inB := false
	bg.wait("VOICE_MOVED and VOICE_STATE_UPDATE in B", func(e *v1.DispatchEvent) bool {
		if m := e.GetVoiceMoved(); m != nil {
			mv = m
		}
		if s := e.GetVoiceStateUpdate().GetState(); s.GetUserId() == bob.id && s.GetRoomId() == b {
			inB = true
		}
		return mv != nil && inB
	})
	if mv.GetFromRoomId() != a || mv.GetToRoomId() != b || mv.GetByUserId() != o.id {
		t.Fatalf("VOICE_MOVED: %v", mv)
	}
	if st := move(o, a, bob.id, b); st != 404 {
		t.Fatalf("bob is no longer in A: %d", st)
	}

	// A member with MOVE_MEMBERS (room overrides) is bound by the target's limit; the owner is not.
	for _, rid := range []string{b, full} {
		o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
			{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: alice.id, Allow: uint64(perm.MoveMembers)},
		}}, nil)
	}
	if st := move(alice, b, bob.id, full); st != 409 {
		t.Fatalf("mover without admin into a full room: %d", st)
	}
	// Owner, 07.10: an admin is bound by the limit too; only the owner moves into a full room.
	adm := register(t, invite(t, o, wid))
	if st, _ := setMemberRoles(o, wid, adm.id, listRoles(t, o, wid)[1].GetId()); st != 200 {
		t.Fatalf("make admin: %d", st)
	}
	if st := move(adm, b, bob.id, full); st != 409 {
		t.Fatalf("admin into a full room: %d, want 409", st)
	}
	if st := move(o, b, bob.id, full); st != 204 {
		t.Fatalf("owner into a full room: %d", st)
	}
}

func TestNicknames(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	alice := register(t, invite(t, o, ws.GetId()))
	base := "/api/workspaces/" + ws.GetId() + "/members/"
	nick := func(s string) *v1.UpdateMemberRequest { return &v1.UpdateMemberRequest{Nickname: &s} }
	g := dialGW(t)
	g.identify(alice.token)

	bob.must(200, "PATCH", base+"@me", nick("Бобби"), nil)
	bob.must(403, "PATCH", base+alice.id, nick("хакер"), nil) // MANAGE_NICKNAMES needed for others
	var upd v1.UpdateMemberResponse
	o.must(200, "PATCH", base+bob.id, nick("Боб (QA)"), &upd)
	if upd.GetMember().GetNickname() != "Боб (QA)" {
		t.Fatal("admin rename not applied")
	}
	g.wait("WORKSPACE_MEMBER_UPDATE", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberUpdate().GetMember().GetNickname() == "Боб (QA)"
	})
	no := false
	var wu v1.UpdateWorkspaceResponse
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{AllowSelfNickname: &no}, &wu)
	if wu.GetWorkspace().GetAllowSelfNickname() {
		t.Fatal("allow_self_nickname not saved")
	}
	bob.must(403, "PATCH", base+"@me", nick("снова я"), nil)
	o.must(200, "PATCH", base+"@me", nick("Шеф"), nil) // MANAGE_NICKNAMES ignores the setting
}

func TestGuests(t *testing.T) {
	o, _, ws, room := setupTeam(t)
	rid, wid := room.GetId(), ws.GetId()
	var other v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "other"}, &other)

	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	inv := link.GetInvite()
	if !inv.GetAllowGuests() || !inv.GetAllowSpeak() || !inv.GetAllowMessages() || inv.GetAllowFiles() || inv.GetAllowStream() ||
		time.Until(inv.GetExpiresAt().AsTime()) < 6*24*time.Hour || len(inv.GetCode()) != 12 {
		t.Fatalf("link defaults: %v", inv)
	}
	code := inv.GetCode()

	// Public preview.
	anon := &client{t: t, ip: "10.60.0.1"}
	var pv v1.GetRoomInviteResponse
	anon.must(200, "GET", "/api/room-invites/"+code, nil, &pv)
	if pv.GetRoomName() != "voice" || pv.GetWorkspaceName() != "Team" || !pv.GetAllowGuests() {
		t.Fatalf("preview: %v", &pv)
	}

	// (c) guest without an account.
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость Вася"}, &gj)
	if gj.GetRoomId() != rid || gj.GetWorkspaceId() != wid || !gj.GetMe().GetUser().GetIsGuest() || gj.GetMe().GetEmail() != "" {
		t.Fatalf("guest join: %v", &gj)
	}
	if d := time.Until(gj.GetTokens().GetRefreshExpiresAt().AsTime()); d > 25*time.Hour || d < 23*time.Hour {
		t.Fatalf("guest session TTL %v, want 24h", d)
	}
	guest := &user{client: &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.60.0.2"}, id: gj.GetMe().GetUser().GetId()}
	var rooms v1.ListRoomsResponse
	guest.must(200, "GET", "/api/workspaces/"+wid+"/rooms", nil, &rooms)
	if len(rooms.GetRooms()) != 1 || rooms.GetRooms()[0].GetId() != rid {
		t.Fatalf("guest sees %d rooms", len(rooms.GetRooms()))
	}
	var gr v1.GetRoomResponse
	guest.must(200, "GET", "/api/rooms/"+rid, nil, &gr)
	if perm.Bits(gr.GetPermissions()) != perm.ViewRoom|perm.Connect|perm.Speak|perm.SendMessages {
		t.Fatalf("guest bits %d", gr.GetPermissions())
	}
	guest.must(404, "GET", "/api/rooms/"+other.GetRoom().GetId(), nil, nil)
	gm := send(t, guest, rid, "привет от гостя", "")
	guest.must(403, "POST", "/api/workspaces", &v1.CreateWorkspaceRequest{Slug: "guest-ws", Name: "x"}, nil)
	guest.must(403, "PATCH", "/api/me/status", &v1.UpdateStatusRequest{Text: "x"}, nil)
	newName := "Василий"
	guest.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{DisplayName: &newName}, nil)
	guest.must(403, "POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{}, nil)

	// Web guests get the refresh token as a cookie; wrong origin is rejected.
	r := webPost(t, "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: "Веб"}, goodOrigin, "")
	var wj v1.JoinRoomInviteResponse
	_ = protojson.Unmarshal(r.body, &wj)
	if r.status != 201 || r.cookie == nil || wj.GetTokens().GetRefreshToken() != "" {
		t.Fatalf("web guest join: %d %s", r.status, r.body)
	}
	if r := webPost(t, "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: "Злой"}, map[string]string{"X-Client": "web", "Origin": "https://evil.example.com"}, ""); r.status != 403 {
		t.Fatalf("cross-origin guest join: %d", r.status)
	}

	// (b) registered non-member → guest of the workspace with this room only.
	otherWS := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	outsider := register(t, invite(t, o, otherWS.GetId()))
	outsider.must(200, "POST", "/api/room-invites/"+code+"/join", nil, nil)
	var ms v1.ListMembersResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &ms)
	role := v1.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED
	for _, m := range ms.GetMembers() {
		if m.GetUser().GetId() == outsider.id {
			role = m.GetRole()
		}
	}
	if role != v1.WorkspaceRole_WORKSPACE_ROLE_GUEST {
		t.Fatalf("outsider role %v", role)
	}
	// (a) already has access: no use consumed.
	var before v1.ListRoomInvitesResponse
	o.must(200, "GET", "/api/rooms/"+rid+"/invites", nil, &before)
	o.must(200, "POST", "/api/room-invites/"+code+"/join", nil, nil)
	var after v1.ListRoomInvitesResponse
	o.must(200, "GET", "/api/rooms/"+rid+"/invites", nil, &after)
	if before.GetInvites()[0].GetUses() != after.GetInvites()[0].GetUses() {
		t.Fatal("member with access consumed a use")
	}

	// Links without guests, used-up and revoked links.
	no, one := false, uint32(1)
	var closed, single v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{AllowGuests: &no}, &closed)
	(&client{t: t, ip: "10.60.0.3"}).must(401, "POST", "/api/room-invites/"+closed.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "x"}, nil)
	o.must(201, "POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{MaxUses: one}, &single)
	(&client{t: t, ip: "10.60.0.4"}).must(201, "POST", "/api/room-invites/"+single.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "one"}, nil)
	(&client{t: t, ip: "10.60.0.5"}).must(404, "POST", "/api/room-invites/"+single.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "two"}, nil)
	o.must(204, "DELETE", "/api/rooms/"+rid+"/invites/"+closed.GetInvite().GetId(), nil, nil)
	anon.must(404, "GET", "/api/room-invites/"+closed.GetInvite().GetCode(), nil, nil)

	// Guest creation is rate limited per IP (5 per hour).
	burst := &client{t: t, ip: "10.61.0.1"}
	codes := map[int]int{}
	for i := range 7 {
		codes[burst.do("POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{Nickname: fmt.Sprint("g", i)}, nil)]++
	}
	if codes[201] != 5 || codes[429] != 2 {
		t.Fatalf("guest rate limit: %v", codes)
	}

	// Promote: the guest becomes a member and sees every room.
	o.must(200, "POST", "/api/workspaces/"+wid+"/members/"+outsider.id+"/promote", nil, nil)
	outsider.must(200, "GET", "/api/rooms/"+other.GetRoom().GetId(), nil, nil)
	o.must(404, "POST", "/api/workspaces/"+wid+"/members/"+outsider.id+"/promote", nil, nil) // not a guest any more

	// Cleanup after 7 days of inactivity: anonymised, memberships and sessions gone, messages kept.
	if _, err := testDB.Pool.Exec(ctx0, "UPDATE users SET guest_expires_at = now() - interval '1 minute' WHERE id = $1", guest.id); err != nil {
		t.Fatal(err)
	}
	if n, err := testApp.Guests.Cleanup(ctx0); err != nil || n < 1 {
		t.Fatalf("cleanup: %d %v", n, err)
	}
	guest.must(401, "GET", "/api/me", nil, nil)
	var page v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+rid+"/messages?limit=10", nil, &page)
	kept := false
	for _, m := range page.GetMessages() {
		kept = kept || (m.GetId() == gm.GetId() && m.GetAuthorId() == guest.id)
	}
	if !kept {
		t.Fatal("guest message lost")
	}
	var name string
	if err := testDB.Pool.QueryRow(ctx0, "SELECT display_name FROM users WHERE id = $1", guest.id).Scan(&name); err != nil || name != "Гость (удалён)" {
		t.Fatalf("anonymised name %q %v", name, err)
	}
	o.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &ms)
	for _, m := range ms.GetMembers() {
		if m.GetUser().GetId() == guest.id {
			t.Fatal("removed guest still a member")
		}
	}
}

var ctx0 = context.Background()

func TestAFKPresence(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	og := dialGW(t)
	og.identify(o.token)
	email := mustEmail(t, bob)
	second := &client{t: t, ip: "10.62.0.1"}
	var l v1.LoginResponse
	second.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, &l)
	d1, d2 := dialGW(t), dialGW(t)
	d1.identify(bob.token)
	d2.identify(l.GetTokens().GetAccessToken())
	set := func(g *gw, st v1.PresenceStatus) {
		g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_PRESENCE_UPDATE, Payload: &v1.GatewayFrame_SetPresence{SetPresence: &v1.SetPresence{Status: st}}})
	}
	want := func(st v1.PresenceStatus) {
		t.Helper()
		og.wait("presence "+st.String(), func(e *v1.DispatchEvent) bool {
			p := e.GetPresenceUpdate().GetPresence()
			return p.GetUserId() == bob.id && p.GetStatus() == st
		})
	}
	set(d1, v1.PresenceStatus_PRESENCE_STATUS_DND)
	want(v1.PresenceStatus_PRESENCE_STATUS_DND)
	set(d2, v1.PresenceStatus_PRESENCE_STATUS_IDLE) // AFK on the other device: stays DND
	og.quiet("dnd overridden", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetPresenceUpdate().GetPresence().GetUserId() == bob.id
	})
	set(d1, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE)
	want(v1.PresenceStatus_PRESENCE_STATUS_OFFLINE) // invisible beats idle too
	set(d1, v1.PresenceStatus_PRESENCE_STATUS_ONLINE)
	want(v1.PresenceStatus_PRESENCE_STATUS_ONLINE)
	_ = d1.ws.Close(1000, "")
	want(v1.PresenceStatus_PRESENCE_STATUS_IDLE)
	// Heartbeats keep the session's idle status.
	d2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT, Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{}}})
	og.quiet("idle reset by heartbeat", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetPresenceUpdate().GetPresence().GetUserId() == bob.id
	})
	_ = http.StatusOK
}
