//go:build integration

package app_test

import (
	"net/url"
	"slices"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Private rooms (ADR-0029, docs/16; ADR-0078 addendum 2026-10-14: every private room is
// restricted, the owner bypasses only with «Владелец видит приватное»): ADMINISTRATOR gives no
// bypass; the owner here is the rooms' creator and keeps them by a personal allow of the room bits. Actors: the owner; an admin without access; an admin allowed personally; an
// admin allowed through a custom role; a member without access; a member allowed personally;
// a guest.
type restrictedFixture struct {
	o, admin, adminUser, adminRole, member, memberUser, guest *user
	wid, rid, vid, insiders                                   string
	names                                                     []string
	actors                                                    map[string]*user
}

func setupRestricted(t *testing.T) *restrictedFixture {
	t.Helper()
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	var inv v1.CreateInviteResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{MaxUses: 50}, &inv)
	code := inv.GetInvite().GetCode()
	adminR, guestR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN, v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	f := &restrictedFixture{o: o, wid: wid}
	f.admin, f.adminUser, f.adminRole = register(t, code), register(t, code), register(t, code)
	f.member, f.memberUser, f.guest = register(t, code), register(t, code), register(t, code)
	// The custom role first: the legacy PATCH below changes only the built-in role.
	insiders := newRole(t, o, wid, "insiders", 0)
	f.insiders = insiders.GetId()
	if st, _ := setMemberRoles(o, wid, f.adminRole.id, insiders.GetId()); st != 200 {
		t.Fatalf("assign insiders: %d", st)
	}
	for _, a := range []*user{f.admin, f.adminUser, f.adminRole} {
		o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	}
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+f.guest.id, &v1.UpdateMemberRequest{Role: &guestR}, nil)
	mk := func(typ v1.RoomType, name string) string {
		var cr v1.CreateRoomResponse
		o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: typ, Name: name, IsPrivate: true}, &cr)
		id := cr.GetRoom().GetId()
		ovs := append(slices.Clone(cr.GetRoom().GetPermissionOverrides()),
			userOv(f.adminUser.id, perm.ViewRoom, 0), userOv(f.memberUser.id, perm.ViewRoom, 0),
			roleOv(insiders.GetId(), perm.ViewRoom, 0))
		o.must(200, "PUT", "/api/rooms/"+id+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
		on := true
		o.must(200, "PATCH", "/api/rooms/"+id, &v1.UpdateRoomRequest{Restricted: &on}, nil)
		return id
	}
	f.rid = mk(v1.RoomType_ROOM_TYPE_TEXT, "secret")
	f.vid = mk(v1.RoomType_ROOM_TYPE_VOICE, "secret-voice")
	f.names = []string{"owner", "admin", "adminUser", "adminRole", "member", "memberUser", "guest"}
	f.actors = map[string]*user{"owner": o, "admin": f.admin, "adminUser": f.adminUser, "adminRole": f.adminRole,
		"member": f.member, "memberUser": f.memberUser, "guest": f.guest}
	return f
}

// only lists who gets `yes`; everyone else gets `no`.
func (f *restrictedFixture) only(yes, no int, who ...string) map[string]int {
	out := map[string]int{}
	for _, n := range f.names {
		out[n] = no
		if slices.Contains(who, n) {
			out[n] = yes
		}
	}
	return out
}

func TestRestrictedRoomMatrix(t *testing.T) {
	f := setupRestricted(t)
	allowed := []string{"owner", "adminUser", "adminRole", "memberUser"}
	secret := sendRetry(t, f.o, f.rid, "restricted-needle "+uniq("x")+" @"+f.admin.id+" @"+f.adminUser.id)

	// The room as each actor sees it: listed, readable, and with which bits.
	for _, n := range f.names {
		u := f.actors[n]
		_, listed := visibleRooms(t, u, f.wid)[f.rid]
		bits, st := roomPerms(t, u, f.rid)
		want := slices.Contains(allowed, n)
		switch {
		case listed != want:
			t.Errorf("%s: listed=%v, want %v", n, listed, want)
		case want && st != 200, !want && st != 404:
			t.Errorf("%s: GET room %d", n, st)
		case n == "owner" && (perm.Bits(bits)&perm.RoomOnly != perm.RoomOnly || perm.Bits(bits) == perm.All):
			t.Errorf("owner (the creator): bits %d, want every room bit, no bypass", bits)
		case n != "owner" && want && perm.Bits(bits) != perm.RoleDefaults[perm.RoleMember]:
			t.Errorf("%s: bits %d, want the member's %d (no ADMINISTRATOR bypass)", n, bits, perm.RoleDefaults[perm.RoleMember])
		}
	}

	thumbs := url.PathEscape("👍")
	on := true
	cases := []struct {
		action string
		want   map[string]int
		call   func(u *user) int
	}{
		{"read messages", f.only(200, 404, allowed...), func(u *user) int {
			return u.do("GET", "/api/rooms/"+f.rid+"/messages", nil, nil)
		}},
		{"send a message", f.only(201, 404, allowed...), func(u *user) int {
			for {
				if st := u.do("POST", "/api/rooms/"+f.rid+"/messages", &v1.CreateMessageRequest{Content: "hi", Nonce: uniq("n")}, nil); st != 429 {
					return st
				}
				time.Sleep(500 * time.Millisecond)
			}
		}},
		{"react", f.only(204, 404, allowed...), func(u *user) int {
			return u.do("PUT", "/api/messages/"+secret.GetId()+"/reactions/"+thumbs, nil, nil)
		}},
		{"pins", f.only(200, 404, allowed...), func(u *user) int {
			return u.do("GET", "/api/rooms/"+f.rid+"/pins", nil, nil)
		}},
		{"rename (MANAGE_ROOM: only the owner, admins count as members)", func() map[string]int {
			m := f.only(200, 404, "owner")
			m["adminUser"], m["adminRole"], m["memberUser"] = 403, 403, 403
			return m
		}(), func(u *user) int {
			n := "secret"
			return u.do("PATCH", "/api/rooms/"+f.rid, &v1.UpdateRoomRequest{Name: &n}, nil)
		}},
		{"overrides (MANAGE_ROOM)", func() map[string]int {
			m := f.only(200, 404, "owner")
			m["adminUser"], m["adminRole"], m["memberUser"] = 403, 403, 403
			return m
		}(), func(u *user) int {
			var g v1.GetRoomResponse
			if st := f.o.do("GET", "/api/rooms/"+f.rid, nil, &g); st != 200 {
				return st
			}
			return u.do("PUT", "/api/rooms/"+f.rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: g.GetRoom().GetPermissionOverrides()}, nil)
		}},
		{"restricted flag (MANAGE_ROOM in the room)", func() map[string]int {
			m := f.only(200, 404, "owner")
			m["adminUser"], m["adminRole"], m["memberUser"] = 403, 403, 403
			return m
		}(), func(u *user) int {
			return u.do("PATCH", "/api/rooms/"+f.rid, &v1.UpdateRoomRequest{Restricted: &on}, nil)
		}},
		{"delete the room (MANAGE_ROOM)", func() map[string]int {
			m := f.only(0, 404)
			m["owner"] = -1 // not called: the room is needed below
			m["adminUser"], m["adminRole"], m["memberUser"] = 403, 403, 403
			return m
		}(), func(u *user) int {
			if u == f.o {
				return -1
			}
			return u.do("DELETE", "/api/rooms/"+f.rid, nil, nil)
		}},
		{"guest link (MANAGE_ROOM)", func() map[string]int {
			m := f.only(201, 404, "owner")
			m["adminUser"], m["adminRole"], m["memberUser"] = 403, 403, 403
			return m
		}(), func(u *user) int {
			return u.do("POST", "/api/rooms/"+f.rid+"/invites", &v1.CreateRoomInviteRequest{}, nil)
		}},
		{"room order with the hidden room (MANAGE_ROOM ws)", func() map[string]int {
			m := f.only(200, 403, "owner", "adminUser", "adminRole")
			m["admin"] = 422
			return m
		}(), func(u *user) int {
			return u.do("PUT", "/api/workspaces/"+f.wid+"/rooms/order", &v1.SetRoomOrderRequest{
				Rooms: []*v1.SetRoomOrderRequest_RoomPosition{{RoomId: f.rid, Position: 0}},
			}, nil)
		}},
	}
	for _, c := range cases {
		for _, n := range f.names {
			want := c.want[n]
			got := c.call(f.actors[n])
			if got != want {
				t.Errorf("%s as %s: status %d, want %d", c.action, n, got, want)
			}
		}
	}

	// Search and mentions leave the room out for those who cannot see it.
	for _, n := range f.names {
		var sr v1.ListMessagesResponse
		f.actors[n].must(200, "GET", "/api/workspaces/"+f.wid+"/messages/search?q=restricted-needle", nil, &sr)
		found := slices.ContainsFunc(sr.GetMessages(), func(m *v1.Message) bool { return m.GetId() == secret.GetId() })
		if found != slices.Contains(allowed, n) {
			t.Errorf("search as %s: found=%v", n, found)
		}
	}
	for u, want := range map[*user]bool{f.admin: false, f.adminUser: true} {
		var mr v1.ListMessagesResponse
		u.must(200, "GET", "/api/me/mentions?workspace_id="+f.wid, nil, &mr)
		if got := slices.ContainsFunc(mr.GetMessages(), func(m *v1.Message) bool { return m.GetId() == secret.GetId() }); got != want {
			t.Errorf("mentions of %s: %v, want %v", u.id, got, want)
		}
	}
}

// ADR-0078 addendum 2026-10-14: restricted is an alias of is_private — any text / voice room
// takes it (public ⇄ private); MANAGE_ROOM in the room changes it; whoever makes a room private
// keeps it through a personal allow of their room bits, other admins lose it.
func TestRestrictedFlagManageRoom(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	admin, admin2, mem := register(t, code), register(t, code), register(t, code)
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	for _, a := range []*user{admin, admin2} {
		o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	}
	var pub v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "pub"}, &pub)
	on, off := true, false
	pid := pub.GetRoom().GetId()
	if st := mem.do("PATCH", "/api/rooms/"+pid, &v1.UpdateRoomRequest{Restricted: &on}, nil); st != 403 {
		t.Fatalf("a member without MANAGE_ROOM makes it private: %d, want 403", st)
	}
	var res v1.UpdateRoomResponse
	admin.must(200, "PATCH", "/api/rooms/"+pid, &v1.UpdateRoomRequest{Restricted: &on}, &res)
	if !res.GetRoom().GetRestricted() || !res.GetRoom().GetIsPrivate() {
		t.Fatal("restricted alias: the room is not private")
	}
	if bits, st := roomPerms(t, admin, pid); st != 200 || !perm.Bits(bits).Has(perm.ViewRoom|perm.ManageRoom) || perm.Bits(bits) == perm.All {
		t.Fatalf("the admin who made it private: %d bits %d, want 200 with VIEW_ROOM | MANAGE_ROOM, not all", st, bits)
	}
	// The owner created the room (the creator always sees it) — not checked here.
	for name, u := range map[string]*user{"another admin": admin2, "a member": mem} {
		if _, st := roomPerms(t, u, pid); st != 404 {
			t.Fatalf("%s sees the private room: %d", name, st)
		}
	}
	if st := admin2.do("PATCH", "/api/rooms/"+pid, &v1.UpdateRoomRequest{Restricted: &off}, nil); st != 404 {
		t.Fatalf("another admin opens it: %d, want 404", st)
	}
	admin.must(200, "PATCH", "/api/rooms/"+pid, &v1.UpdateRoomRequest{Restricted: &off}, &res)
	if res.GetRoom().GetIsPrivate() || res.GetRoom().GetRestricted() {
		t.Fatal("opened room still private")
	}
	for _, u := range []*user{admin2, o} {
		if bits, st := roomPerms(t, u, pid); st != 200 || perm.Bits(bits) != perm.All {
			t.Fatalf("after opening: %d bits %d, want 200 / all", st, bits)
		}
	}
}

// Role membership is no way in for oneself (ADR-0029, ADR-0026 addendum 2026-11-10): an admin
// who cannot see the room may not hand themselves a role that opens it; giving it to others is
// role management (CBF-173: the room invited the role, its holders are who role managers make
// them); the owner and an admin who sees it may do both.
func TestRestrictedRoleGrant(t *testing.T) {
	f := setupRestricted(t)
	adminID := builtinRole(t, f.o, f.wid, v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN).GetId()
	st, _ := setMemberRoles(f.admin, f.wid, f.admin.id, adminID, f.insiders)
	if st != 403 {
		t.Fatalf("admin grants insiders to themselves: %d, want 403", st)
	}
	var e v1.ApiError
	if err := protojson.Unmarshal(f.admin.lastBody, &e); err != nil || e.GetReason() != "OWNER_ONLY" {
		t.Fatalf("admin grants insiders to themselves: %s, want OWNER_ONLY", f.admin.lastBody)
	}
	if _, st := roomPerms(t, f.admin, f.rid); st != 404 {
		t.Fatalf("admin sees the room after a refused grant: %d", st)
	}
	if st, _ := setMemberRoles(f.admin, f.wid, f.member.id, f.insiders); st != 200 {
		t.Fatalf("admin who cannot see the room grants insiders to a member: %d, want 200", st)
	}
	if _, st := roomPerms(t, f.member, f.rid); st != 200 {
		t.Fatalf("member given insiders: %d, want 200", st)
	}
	if st, _ := setMemberRoles(f.admin, f.wid, f.member.id); st != 200 {
		t.Fatalf("admin takes insiders back: %d, want 200", st)
	}
	if st, _ := setMemberRoles(f.adminUser, f.wid, f.member.id, f.insiders); st != 200 {
		t.Fatalf("admin who sees the room grants insiders: %d, want 200", st)
	}
	if st, _ := setMemberRoles(f.o, f.wid, f.admin.id, adminID, f.insiders); st != 200 {
		t.Fatalf("owner grants insiders to an admin: %d, want 200", st)
	}
	if _, st := roomPerms(t, f.admin, f.rid); st != 200 {
		t.Fatalf("admin granted insiders by the owner: %d, want 200", st)
	}
}

// Role order and deletion are no way in either (ADR-0029): an admin holding an allowing and a
// (senior) denying role may not reorder them so the allow wins, nor delete the denying role.
func TestRestrictedRoleOrderDelete(t *testing.T) {
	f := setupRestricted(t)
	adminID := builtinRole(t, f.o, f.wid, v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN).GetId()
	blocked := newRole(t, f.o, f.wid, "blocked", 0).GetId()
	var g v1.GetRoomResponse
	f.o.must(200, "GET", "/api/rooms/"+f.rid, nil, &g)
	ovs := append(slices.Clone(g.GetRoom().GetPermissionOverrides()), roleOv(blocked, 0, perm.ViewRoom))
	f.o.must(200, "PUT", "/api/rooms/"+f.rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
	order := func(u *user, ids ...string) int {
		return u.do("PUT", "/api/workspaces/"+f.wid+"/roles/order", &v1.SetRoleOrderRequest{RoleIds: ids}, nil)
	}
	if st := order(f.o, blocked, f.insiders); st != 200 {
		t.Fatalf("owner orders roles: %d", st)
	}
	if st, _ := setMemberRoles(f.o, f.wid, f.admin.id, adminID, f.insiders, blocked); st != 200 {
		t.Fatalf("owner assigns insiders + blocked: %d", st)
	}
	if _, st := roomPerms(t, f.admin, f.rid); st != 404 {
		t.Fatalf("blocked admin sees the room: %d", st)
	}
	ownerOnly := func(what string, st int) {
		t.Helper()
		var e v1.ApiError
		if st != 403 || protojson.Unmarshal(f.admin.lastBody, &e) != nil || e.GetReason() != "OWNER_ONLY" {
			t.Fatalf("%s: %d %s, want 403 OWNER_ONLY", what, st, f.admin.lastBody)
		}
	}
	ownerOnly("admin puts insiders above blocked", order(f.admin, f.insiders, blocked))
	ownerOnly("admin deletes blocked", f.admin.do("DELETE", "/api/workspaces/"+f.wid+"/roles/"+blocked, nil, nil))
	if _, st := roomPerms(t, f.admin, f.rid); st != 404 {
		t.Fatalf("admin sees the room after refused changes: %d", st)
	}
	// An admin who sees the room may reorder; the owner may delete.
	if st := order(f.adminUser, f.insiders, blocked); st != 200 {
		t.Fatalf("admin who sees the room reorders: %d, want 200", st)
	}
	if st := f.o.do("DELETE", "/api/workspaces/"+f.wid+"/roles/"+blocked, nil, nil); st != 204 {
		t.Fatalf("owner deletes blocked: %d, want 204", st)
	}
	if _, st := roomPerms(t, f.admin, f.rid); st != 200 {
		t.Fatalf("admin after the owner deleted blocked: %d, want 200", st)
	}
}

// Live: setting the flag hides the room from an admin's gateway (ROOM_DELETE), clearing it
// brings it back (ROOM_CREATE); the admin's READY never carries it or its call.
func TestRestrictedRoomGateway(t *testing.T) {
	liveKitUp(t)
	f := setupRestricted(t)
	joinVoice(t, f.memberUser, f.wid, f.vid)
	g := dialGW(t)
	ready := g.identify(f.admin.token)
	for _, s := range ready.GetWorkspaces() {
		if s.GetWorkspace().GetId() != f.wid {
			continue
		}
		for _, r := range s.GetRooms() {
			if r.GetId() == f.rid || r.GetId() == f.vid {
				t.Fatalf("READY lists restricted room %s", r.GetName())
			}
		}
		for _, vs := range s.GetVoiceStates() {
			if vs.GetRoomId() == f.vid {
				t.Fatalf("READY leaks the restricted call: %v", vs)
			}
		}
	}
	off, on := false, true
	f.o.must(200, "PATCH", "/api/rooms/"+f.vid, &v1.UpdateRoomRequest{Restricted: &off}, nil)
	g.wait("ROOM_CREATE", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == f.vid })
	g.wait("the call's voice state", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == f.memberUser.id && s.GetRoomId() == f.vid
	})
	f.o.must(200, "PATCH", "/api/rooms/"+f.vid, &v1.UpdateRoomRequest{Restricted: &on}, nil)
	g.wait("ROOM_DELETE", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == f.vid })
	// A message in the restricted text room never reaches the admin.
	sendRetry(t, f.o, f.rid, "hidden")
	g.quiet("message from a restricted room", 500*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetRoomId() == f.rid
	})
	// Voice: the admin without access cannot join; one allowed personally can.
	if st := f.admin.do("POST", "/api/rooms/"+f.vid+"/join", nil, nil); st != 404 {
		t.Errorf("admin joins the restricted call: %d, want 404", st)
	}
	if st := f.adminUser.do("POST", "/api/rooms/"+f.vid+"/join", nil, nil); st != 200 {
		t.Errorf("allowed admin joins: %d, want 200", st)
	}
}
