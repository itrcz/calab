//go:build integration

package app_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rtc"
)

// Custom workspace roles (ADR-0026).

func listRoles(t *testing.T, u *user, wsID string) []*v1.Role {
	t.Helper()
	var resp v1.ListRolesResponse
	u.must(200, "GET", "/api/workspaces/"+wsID+"/roles", nil, &resp)
	return resp.GetRoles()
}

func builtinRole(t *testing.T, u *user, wsID string, b v1.WorkspaceRole) *v1.Role {
	t.Helper()
	for _, r := range listRoles(t, u, wsID) {
		if r.GetBuiltin() == b {
			return r
		}
	}
	t.Fatalf("no built-in role %v", b)
	return nil
}

func newRole(t *testing.T, u *user, wsID, name string, bits perm.Bits) *v1.Role {
	t.Helper()
	var resp v1.CreateRoleResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/roles", &v1.CreateRoleRequest{Name: name, Permissions: uint64(bits), Color: 0x3366ff}, &resp)
	return resp.GetRole()
}

func setMemberRoles(u *user, wsID, target string, ids ...string) (int, *v1.WorkspaceMember) {
	var resp v1.SetMemberRolesResponse
	st := u.do("PUT", "/api/workspaces/"+wsID+"/members/"+target+"/roles", &v1.SetMemberRolesRequest{RoleIds: ids}, &resp)
	return st, resp.GetMember()
}

func roleOv(id string, allow, deny perm.Bits) *v1.RoomPermissionOverride {
	return &v1.RoomPermissionOverride{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: id, Allow: uint64(allow), Deny: uint64(deny)}
}

func TestRolesCRUD(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	bob := register(t, invite(t, o, wid))
	base := "/api/workspaces/" + wid + "/roles"

	// Built-ins, highest first, with the legacy permission sets.
	rs := listRoles(t, bob, wid)
	if len(rs) != 4 || rs[0].GetBuiltin() != v1.WorkspaceRole_WORKSPACE_ROLE_OWNER || rs[3].GetBuiltin() != v1.WorkspaceRole_WORKSPACE_ROLE_GUEST ||
		rs[2].GetPermissions() != uint64(perm.RoleDefaults[perm.RoleMember]) || rs[3].GetPermissions() != uint64(perm.RoleDefaults[perm.RoleGuest]) ||
		rs[1].GetPosition() != perm.PosAdmin || rs[2].GetName() != "member" {
		t.Fatalf("built-in roles: %v", rs)
	}
	// Members hold MEMBER, the owner OWNER + MEMBER.
	var ml v1.ListMembersResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &ml)
	for _, m := range ml.GetMembers() {
		want := []string{rs[2].GetId()}
		if m.GetUser().GetId() == o.id {
			want = []string{rs[0].GetId(), rs[2].GetId()}
		}
		if !slices.Equal(m.GetRoleIds(), want) {
			t.Fatalf("role ids of %s: %v, want %v", m.GetUser().GetId(), m.GetRoleIds(), want)
		}
	}

	// Members without MANAGE_ROLES cannot create.
	bob.must(403, "POST", base, &v1.CreateRoleRequest{Name: "x"}, nil)
	// Validation.
	for name, req := range map[string]*v1.CreateRoleRequest{
		"empty name":    {Name: "  "},
		"long name":     {Name: strings.Repeat("я", 33)},
		"control char":  {Name: "a\nb"},
		"color":         {Name: "c", Color: 0x1000000},
		"administrator": {Name: "a", Permissions: uint64(perm.Administrator)},
		"unknown bit":   {Name: "u", Permissions: 1 << 41},
	} {
		if st := o.do("POST", base, req, nil); st != 422 {
			t.Errorf("%s: status %d, want 422", name, st)
		}
	}
	mod := newRole(t, o, wid, "Moderators", perm.MuteMembers|perm.MoveMembers)
	if mod.GetPosition() != perm.PosCustom || mod.GetBuiltin() != v1.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED || mod.GetColor() != 0x3366ff {
		t.Fatalf("created: %v", mod)
	}
	dj := newRole(t, o, wid, "DJ", perm.Stream)
	rs = listRoles(t, o, wid)
	if dj.GetPosition() != perm.PosCustom || rs[2].GetId() != mod.GetId() || rs[2].GetPosition() != perm.PosCustom+1 {
		t.Fatalf("new role goes to the bottom, the others move up: %v", rs)
	}

	// Update: rename / color / permissions; built-in restrictions.
	name, color, bits := "Mods", uint32(0xff0000), uint64(perm.MuteMembers)
	var upd v1.UpdateRoleResponse
	o.must(200, "PATCH", base+"/"+mod.GetId(), &v1.UpdateRoleRequest{Name: &name, Color: &color, Permissions: &bits}, &upd)
	if upd.GetRole().GetName() != "Mods" || upd.GetRole().GetColor() != color || upd.GetRole().GetPermissions() != bits {
		t.Fatalf("update: %v", upd.GetRole())
	}
	member, guest, admin := rs[len(rs)-2], rs[len(rs)-1], rs[1]
	o.must(422, "PATCH", base+"/"+member.GetId(), &v1.UpdateRoleRequest{Name: &name}, nil)
	all := uint64(perm.ViewRoom)
	o.must(422, "PATCH", base+"/"+admin.GetId(), &v1.UpdateRoleRequest{Permissions: &all}, nil)
	o.must(200, "PATCH", base+"/"+admin.GetId(), &v1.UpdateRoleRequest{Color: &color}, nil)
	tooMuch := uint64(perm.ViewRoom | perm.MuteMembers)
	o.must(422, "PATCH", base+"/"+guest.GetId(), &v1.UpdateRoleRequest{Permissions: &tooMuch}, nil)
	guestBits := uint64(perm.Connect | perm.Speak | perm.SendMessages)
	o.must(200, "PATCH", base+"/"+guest.GetId(), &v1.UpdateRoleRequest{Permissions: &guestBits}, nil)
	noStream := uint64(perm.RoleDefaults[perm.RoleMember] &^ perm.Stream)
	o.must(200, "PATCH", base+"/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &noStream}, nil)
	o.must(404, "PATCH", base+"/01890000-0000-7000-8000-000000000000", &v1.UpdateRoleRequest{Color: &color}, nil)

	// Order: custom roles, highest first.
	o.must(422, "PUT", base+"/order", &v1.SetRoleOrderRequest{RoleIds: []string{dj.GetId()}}, nil)
	o.must(422, "PUT", base+"/order", &v1.SetRoleOrderRequest{RoleIds: []string{dj.GetId(), dj.GetId()}}, nil)
	var ord v1.SetRoleOrderResponse
	o.must(200, "PUT", base+"/order", &v1.SetRoleOrderRequest{RoleIds: []string{dj.GetId(), mod.GetId()}}, &ord)
	if ord.GetRoles()[2].GetId() != dj.GetId() || ord.GetRoles()[2].GetPosition() != perm.PosCustom+1 || ord.GetRoles()[3].GetId() != mod.GetId() {
		t.Fatalf("order: %v", ord.GetRoles())
	}

	// Delete: built-ins cannot go; a custom role takes its overrides with it.
	o.must(422, "DELETE", base+"/"+member.GetId(), nil, nil)
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "t"}, &cr)
	o.must(200, "PUT", "/api/rooms/"+cr.GetRoom().GetId()+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		roleOv(dj.GetId(), perm.ManageMessages, 0), roleOv("member", 0, perm.AttachFiles),
	}}, nil)
	if st, _ := setMemberRoles(o, wid, bob.id, dj.GetId()); st != 200 {
		t.Fatalf("assign: %d", st)
	}
	o.must(204, "DELETE", base+"/"+dj.GetId(), nil, nil)
	o.must(404, "DELETE", base+"/"+dj.GetId(), nil, nil)
	var room v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+cr.GetRoom().GetId(), nil, &room)
	if ovs := room.GetRoom().GetPermissionOverrides(); len(ovs) != 1 || ovs[0].GetTargetId() != member.GetId() {
		t.Fatalf("overrides after delete (legacy name stored as the member role id): %v", ovs)
	}
	var bm v1.ListMembersResponse
	bob.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &bm)
	for _, m := range bm.GetMembers() {
		if m.GetUser().GetId() == bob.id && !slices.Equal(m.GetRoleIds(), []string{member.GetId()}) {
			t.Fatalf("holder falls back to MEMBER: %v", m.GetRoleIds())
		}
	}

	// At most 50 roles, built-ins included (4 + mod = 5 now).
	for i := range perm.PosAdmin {
		st := o.do("POST", base, &v1.CreateRoleRequest{Name: fmt.Sprintf("r%d", i)}, nil)
		if st == 409 {
			if n := len(listRoles(t, o, wid)); n != 50 || i != 45 {
				t.Fatalf("limit at %d roles (i=%d)", n, i)
			}
			break
		}
		if st != 201 {
			t.Fatalf("create %d: %d", i, st)
		}
	}
}

func TestRolesHierarchy(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	bob, carol, dave := register(t, code), register(t, code), register(t, code)
	base := "/api/workspaces/" + wid + "/roles"
	admin := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN)
	ownerRole := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_OWNER)
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)

	mod := newRole(t, o, wid, "mod", perm.ManageRoles|perm.MuteMembers)
	helper := newRole(t, o, wid, "helper", perm.MuteMembers) // new roles go to the bottom: below mod
	// Members cannot assign roles.
	if st, _ := setMemberRoles(bob, wid, carol.id, helper.GetId()); st != 403 {
		t.Fatalf("member assigns: %d", st)
	}
	if st, m := setMemberRoles(o, wid, bob.id, mod.GetId()); st != 200 || !slices.Contains(m.GetRoleIds(), mod.GetId()) || !slices.Contains(m.GetRoleIds(), member.GetId()) {
		t.Fatalf("owner assigns mod: %d %v", st, m)
	}
	// bob (top = mod) creates below himself, only with bits he holds, never the manager bits.
	bob.must(403, "POST", base, &v1.CreateRoleRequest{Name: "w", Permissions: uint64(perm.ManageWorkspace)}, nil)
	bob.must(403, "POST", base, &v1.CreateRoleRequest{Name: "r", Permissions: uint64(perm.ManageRoles)}, nil)
	bob.must(403, "POST", base, &v1.CreateRoleRequest{Name: "m", Permissions: uint64(perm.MoveMembers)}, nil)
	fresh := newRole(t, bob, wid, "fresh", perm.MuteMembers)
	// Nothing at or above his highest role.
	newName, all := "x", uint64(perm.ManageMessages)
	bob.must(403, "PATCH", base+"/"+mod.GetId(), &v1.UpdateRoleRequest{Name: &newName}, nil)
	bob.must(403, "DELETE", base+"/"+mod.GetId(), nil, nil)
	bob.must(403, "PATCH", base+"/"+fresh.GetId(), &v1.UpdateRoleRequest{Permissions: &all}, nil) // bits he lacks
	bob.must(200, "PATCH", base+"/"+fresh.GetId(), &v1.UpdateRoleRequest{Name: &newName}, nil)
	// Assigning: below him, and never admin / owner.
	if st, _ := setMemberRoles(bob, wid, carol.id, helper.GetId()); st != 200 {
		t.Fatalf("bob assigns helper: %d", st)
	}
	for name, ids := range map[string][]string{"mod": {mod.GetId()}, "admin": {admin.GetId()}, "owner": {ownerRole.GetId()}} {
		if st, _ := setMemberRoles(bob, wid, carol.id, ids...); st != 403 {
			t.Errorf("bob assigns %s: %d", name, st)
		}
	}
	if st, _ := setMemberRoles(bob, wid, o.id, helper.GetId()); st != 403 {
		t.Fatalf("bob edits the owner: %d", st)
	}
	// Reorder: fresh (below) may move, not above mod.
	rs := listRoles(t, o, wid)
	var customs []string
	for _, r := range rs {
		if r.GetBuiltin() == v1.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED {
			customs = append(customs, r.GetId())
		}
	}
	if !slices.Equal(customs, []string{mod.GetId(), helper.GetId(), fresh.GetId()}) {
		t.Fatalf("custom order %v", customs)
	}
	bob.must(200, "PUT", base+"/order", &v1.SetRoleOrderRequest{RoleIds: []string{mod.GetId(), fresh.GetId(), helper.GetId()}}, nil)
	bob.must(403, "PUT", base+"/order", &v1.SetRoleOrderRequest{RoleIds: []string{fresh.GetId(), mod.GetId(), helper.GetId()}}, nil)
	bob.must(204, "DELETE", base+"/"+fresh.GetId(), nil, nil)

	// Admin: only the owner grants it; an admin manages everything below admin but not admins.
	if st, m := setMemberRoles(o, wid, dave.id, admin.GetId()); st != 200 || m.GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN {
		t.Fatalf("owner makes dave admin: %d %v", st, m)
	}
	if st, _ := setMemberRoles(dave, wid, carol.id, admin.GetId()); st != 403 {
		t.Fatalf("admin grants admin: %d", st)
	}
	if st, _ := setMemberRoles(dave, wid, bob.id, member.GetId(), mod.GetId(), helper.GetId()); st != 200 {
		t.Fatalf("admin assigns customs: %d", st)
	}
	dave.must(201, "POST", base, &v1.CreateRoleRequest{Name: "mgr", Permissions: uint64(perm.ManageRoles | perm.ManageWorkspace)}, nil)
	dave.must(403, "PATCH", base+"/"+admin.GetId(), &v1.UpdateRoleRequest{Color: new(uint32)}, nil)
	// The owner cannot lose or give ownership here; the base role cannot be swapped.
	if st, _ := setMemberRoles(o, wid, o.id); st != 403 {
		t.Fatalf("owner drops OWNER: %d", st)
	}
	if st, _ := setMemberRoles(o, wid, carol.id, ownerRole.GetId()); st != 403 {
		t.Fatalf("grant OWNER: %d", st)
	}
	// Revoking admin: legacy role back to member, custom roles kept.
	if st, m := setMemberRoles(o, wid, dave.id, helper.GetId()); st != 200 || m.GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER ||
		!slices.Equal(m.GetRoleIds(), []string{helper.GetId(), member.GetId()}) {
		t.Fatalf("revoke admin: %d %v", st, m)
	}
	// Legacy PATCH role keeps the custom roles.
	adm := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	var um v1.UpdateMemberResponse
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+dave.id, &v1.UpdateMemberRequest{Role: &adm}, &um)
	if ids := um.GetMember().GetRoleIds(); !slices.Equal(ids, []string{admin.GetId(), helper.GetId(), member.GetId()}) {
		t.Fatalf("legacy PATCH role: %v", ids)
	}
}

// TestRoleRoomMatrix: two custom roles with conflicting overrides on a private room, the
// member / guest built-ins and a user override (docs/04 «Роли»).
func TestRoleRoomMatrix(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	a, b, ab, none, g := register(t, code), register(t, code), register(t, code), register(t, code), register(t, code)
	guestRole := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+g.id, &v1.UpdateMemberRequest{Role: &guestRole}, nil)
	high := newRole(t, o, wid, "high", perm.MuteMembers)
	low := newRole(t, o, wid, "low", 0) // new roles go to the bottom: below high
	for u, ids := range map[*user][]string{a: {low.GetId()}, b: {high.GetId()}, ab: {low.GetId(), high.GetId()}, g: {low.GetId()}} {
		if st, _ := setMemberRoles(o, wid, u.id, ids...); st != 200 {
			t.Fatalf("assign: %d", st)
		}
	}
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "p", IsPrivate: true}, &cr)
	rid := cr.GetRoom().GetId()
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	if ovs := cr.GetRoom().GetPermissionOverrides(); len(ovs) != 1 || ovs[0].GetTargetId() != member.GetId() {
		t.Fatalf("private room override targets the member role id: %v", ovs)
	}
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		roleOv(member.GetId(), 0, perm.ViewRoom),
		roleOv(low.GetId(), perm.ViewRoom|perm.MentionEveryone, perm.Stream),
		roleOv(high.GetId(), perm.ViewRoom|perm.Stream, perm.MentionEveryone),
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: ab.id, Deny: uint64(perm.Speak)},
	}}, nil)
	// Validation of role targets.
	for name, ov := range map[string]*v1.RoomPermissionOverride{
		"foreign role":  roleOv(builtinRole(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId(), v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER).GetId(), 0, 1),
		"MANAGE_ROLES":  roleOv(low.GetId(), perm.ManageRoles, 0),
		"unknown name":  roleOv("moderator", 0, 1),
		"duplicate ids": roleOv("member", 0, 1), // "member" = member.GetId(), listed twice below
	} {
		ovs := []*v1.RoomPermissionOverride{ov}
		if name == "duplicate ids" {
			ovs = append(ovs, roleOv(member.GetId(), 0, 1))
		}
		if st := o.do("PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil); st != 422 {
			t.Errorf("%s: %d, want 422", name, st)
		}
	}
	m := perm.RoleDefaults[perm.RoleMember]
	for _, c := range []struct {
		who  string
		u    *user
		bits perm.Bits
	}{
		{"low only: allowed in, no stream, @everyone", a, m&^perm.Stream | perm.MentionEveryone},
		{"high only: allowed in", b, m | perm.MuteMembers},
		{"low + high: high wins the conflicts", ab, (m | perm.MuteMembers) &^ perm.Speak},
		{"no custom role: private", none, 0},
		{"guest with low", g, perm.Connect | perm.Speak | perm.ViewRoom | perm.MentionEveryone},
		{"owner", o, perm.All},
	} {
		bits, st := roomPerms(t, c.u, rid)
		if perm.Bits(bits) != c.bits || (c.bits == 0) != (st == 404) {
			t.Errorf("%s: %d (status %d), want %d", c.who, bits, st, c.bits)
		}
	}
	// Changing the member role's permissions reaches everyone (workspace-level OR).
	noVideo := uint64(m &^ perm.Video)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &noVideo}, nil)
	if bits, _ := roomPerms(t, b, rid); perm.Bits(bits).Has(perm.Video) {
		t.Fatal("member role edit not applied")
	}
}

func TestRolesGatewayAndGrants(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	quiet := newRole(t, o, wid, "quiet", 0)
	// A private text room only "quiet" sees; in the voice room "quiet" cannot speak.
	var pr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "q", IsPrivate: true}, &pr)
	pid := pr.GetRoom().GetId()
	o.must(200, "PUT", "/api/rooms/"+pid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		roleOv(member.GetId(), 0, perm.ViewRoom), roleOv(quiet.GetId(), perm.ViewRoom, 0),
	}}, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		roleOv(quiet.GetId(), 0, perm.Speak),
	}}, nil)

	bg := dialGW(t)
	ready := bg.identify(bob.token)
	var snap *v1.WorkspaceSnapshot
	for _, s := range ready.GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid {
			snap = s
		}
	}
	if len(snap.GetRoles()) != 5 || snap.GetRoles()[0].GetBuiltin() != v1.WorkspaceRole_WORKSPACE_ROLE_OWNER {
		t.Fatalf("READY roles: %v", snap.GetRoles())
	}
	for _, m := range snap.GetMembers() {
		if m.GetUser().GetId() == bob.id && !slices.Equal(m.GetRoleIds(), []string{member.GetId()}) {
			t.Fatalf("READY role ids: %v", m.GetRoleIds())
		}
	}
	if _, ok := snap.GetPermissions()[pid]; ok {
		t.Fatal("private room in READY")
	}

	// Bob in voice (LiveKit grant recorded at join).
	var j v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	roomName := "ws_" + wid + "_room_" + rid
	webhook(t, whEvent("participant_joined", roomName, j.GetIdentity(), nil), "secret")
	bg.wait("bob in voice", func(e *v1.DispatchEvent) bool { return e.GetVoiceStateUpdate().GetState().GetRoomId() == rid })
	grant := func(what string, want func(rtc.Permission) bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if p, ok := lkRec.lastPerm(j.GetIdentity()); ok && want(p) {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		p, _ := lkRec.lastPerm(j.GetIdentity())
		t.Fatalf("LiveKit grant %s: %+v", what, p)
	}
	mic := func(p rtc.Permission) bool { return p.CanSubscribe && hasSource(p, rtc.SourceMicrophone) }
	grant("microphone at first", mic)

	// Editing the member role (ROLE_UPDATE): no SPEAK for anyone → no microphone.
	noSpeak := uint64(perm.RoleDefaults[perm.RoleMember] &^ perm.Speak)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &noSpeak}, nil)
	bg.wait("ROLE_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetRoleUpdate().GetRole().GetId() == member.GetId() })
	grant("no microphone after the role edit", func(p rtc.Permission) bool { return p.CanSubscribe && !hasSource(p, rtc.SourceMicrophone) })
	full := uint64(perm.RoleDefaults[perm.RoleMember])
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &full}, nil)
	grant("microphone back", mic)

	// Assigning the role: MEMBER_UPDATE with role ids, the private room appears, the grant
	// loses the microphone (the role's override in the voice room).
	if st, _ := setMemberRoles(o, wid, bob.id, quiet.GetId()); st != 200 {
		t.Fatalf("assign: %d", st)
	}
	bg.wait("WORKSPACE_MEMBER_UPDATE", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && slices.Contains(m.GetRoleIds(), quiet.GetId())
	})
	bg.wait("ROOM_CREATE for the gained room", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == pid })
	grant("no microphone with the role", func(p rtc.Permission) bool { return p.CanSubscribe && !hasSource(p, rtc.SourceMicrophone) })

	// Deleting the role: ROLE_DELETE, the room is gone again, overrides updated, microphone back.
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/roles/"+quiet.GetId(), nil, nil)
	bg.wait("ROLE_DELETE", func(e *v1.DispatchEvent) bool { return e.GetRoleDelete().GetRoleId() == quiet.GetId() })
	bg.wait("ROOM_DELETE for the lost room", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == pid })
	bg.wait("ROOM_PERMISSIONS_UPDATE of the voice room", func(e *v1.DispatchEvent) bool {
		u := e.GetRoomPermissionsUpdate()
		return u.GetRoomId() == rid && len(u.GetPermissions()) == 0
	})
	grant("microphone back after the delete", mic)
	webhook(t, whEvent("participant_left", roomName, j.GetIdentity(), nil), "secret")
}

// Invite rights (ADR-0043) apply at once, without a re-login: assigning a role, editing its
// bits and a room override reach the affected user's gateway (WORKSPACE_MEMBER_UPDATE with the
// new role ids, ROLE_UPDATE with the new bits, ROOM_PERMISSIONS_UPDATE) and the next request is
// judged by them. Members-only room links admit members of the workspace only.
func TestInviteRightsApplyLive(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	bg := dialGW(t)
	bg.identify(bob.token)
	wsInvite := func() int {
		return bob.do("POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{MaxUses: 1}, nil)
	}
	if st := wsInvite(); st != 403 {
		t.Fatalf("member invites without INVITE_MEMBERS: %d", st)
	}

	// Assigning a role with INVITE_MEMBERS: bob's session gets his new role ids, the right works.
	hr := newRole(t, o, wid, "hr", perm.InviteMembers)
	if st, _ := setMemberRoles(o, wid, bob.id, hr.GetId()); st != 200 {
		t.Fatalf("assign: %d", st)
	}
	bg.wait("WORKSPACE_MEMBER_UPDATE with the role", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && slices.Contains(m.GetRoleIds(), hr.GetId())
	})
	if st := wsInvite(); st != 201 {
		t.Fatalf("invite after the role was assigned: %d", st)
	}

	// Editing the role's bits: ROLE_UPDATE carries them, the right is gone at once.
	none := uint64(0)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+hr.GetId(), &v1.UpdateRoleRequest{Permissions: &none}, nil)
	bg.wait("ROLE_UPDATE without INVITE_MEMBERS", func(e *v1.DispatchEvent) bool {
		r := e.GetRoleUpdate().GetRole()
		return r.GetId() == hr.GetId() && r.GetPermissions() == 0
	})
	if st := wsInvite(); st != 403 {
		t.Fatalf("invite after the role lost the bit: %d", st)
	}

	// A room override: INVITE_GUESTS in one room only; MANAGE_ROOM alone does not give it.
	vid := voiceRoom(t, o, wid, "v2", 0)
	guestLink := func(room string, membersOnly bool) int {
		return bob.do("POST", "/api/rooms/"+room+"/invites", &v1.CreateRoomInviteRequest{MembersOnly: membersOnly}, nil)
	}
	setOv := func(room string, ovs ...*v1.RoomPermissionOverride) {
		o.must(200, "PUT", "/api/rooms/"+room+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
		bg.wait("ROOM_PERMISSIONS_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetRoomPermissionsUpdate().GetRoomId() == room })
	}
	setOv(vid, userOv(bob.id, perm.ManageRoom, 0))
	if st := guestLink(vid, false); st != 403 {
		t.Fatalf("guest link with MANAGE_ROOM only: %d", st)
	}
	setOv(vid, userOv(bob.id, perm.InviteGuests, 0))
	if st := guestLink(vid, false); st != 201 {
		t.Fatalf("guest link with the room override: %d", st)
	}
	var list v1.ListRoomInvitesResponse
	bob.must(200, "GET", "/api/rooms/"+vid+"/invites", nil, &list)
	if len(list.GetInvites()) != 1 {
		t.Fatalf("links: %v", list.GetInvites())
	}

	// Members-only links: a private room bob sees with INVITE_MEMBERS there (no INVITE_GUESTS).
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	pid := voiceRoom(t, o, wid, "private", 0)
	setOv(pid, roleOv(member.GetId(), 0, perm.ViewRoom), userOv(bob.id, perm.ViewRoom|perm.Connect|perm.Speak|perm.InviteMembers, 0))
	if st := guestLink(pid, false); st != 403 {
		t.Fatalf("guest link with INVITE_MEMBERS only: %d", st)
	}
	yes := true
	if st := bob.do("POST", "/api/rooms/"+pid+"/invites", &v1.CreateRoomInviteRequest{MembersOnly: true, AllowGuests: &yes}, nil); st != 422 {
		t.Fatalf("members-only link that admits guests: %d", st)
	}
	var mo v1.CreateRoomInviteResponse
	bob.must(201, "POST", "/api/rooms/"+pid+"/invites", &v1.CreateRoomInviteRequest{MembersOnly: true}, &mo)
	if inv := mo.GetInvite(); !inv.GetMembersOnly() || inv.GetAllowGuests() {
		t.Fatalf("members-only link: %v", inv)
	}
	// bob lists only members-only links there; the owner's guest link stays hidden, and bob
	// cannot change or revoke it.
	var og v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+pid+"/invites", &v1.CreateRoomInviteRequest{}, &og)
	bob.must(200, "GET", "/api/rooms/"+pid+"/invites", nil, &list)
	if len(list.GetInvites()) != 1 || list.GetInvites()[0].GetId() != mo.GetInvite().GetId() {
		t.Fatalf("bob's links: %v", list.GetInvites())
	}
	bob.must(404, "DELETE", "/api/rooms/"+pid+"/invites/"+og.GetInvite().GetId(), nil, nil)
	bob.must(403, "PATCH", "/api/rooms/"+pid+"/invites/"+og.GetInvite().GetId(), &v1.UpdateRoomInviteRequest{RequireApproval: &yes}, nil)

	// A member without access comes in by it; an outsider is refused (and not made a guest).
	code := mo.GetInvite().GetCode()
	carol := register(t, invite(t, o, wid))
	if _, st := roomPerms(t, carol, pid); st != 404 {
		t.Fatalf("carol sees the private room before: %d", st)
	}
	carol.must(200, "POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{}, nil)
	if bits, st := roomPerms(t, carol, pid); st != 200 || !perm.Bits(bits).Has(perm.ViewRoom) {
		t.Fatalf("carol after the members-only link: %d %d", st, bits)
	}
	outsider := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	if st := outsider.do("POST", "/api/room-invites/"+code+"/join", &v1.JoinRoomInviteRequest{}, nil); st != 403 {
		t.Fatalf("outsider by a members-only link: %d", st)
	}
	if r, _ := errReason(outsider.client); r != "INVITE_MEMBERS_ONLY" {
		t.Fatalf("reason %q", r)
	}
	var ms v1.ListMembersResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &ms)
	for _, m := range ms.GetMembers() {
		if m.GetUser().GetId() == outsider.id {
			t.Fatal("the outsider became a member")
		}
	}
	bob.must(204, "DELETE", "/api/rooms/"+pid+"/invites/"+mo.GetInvite().GetId(), nil, nil)
}
