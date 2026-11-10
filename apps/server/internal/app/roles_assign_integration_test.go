//go:build integration

package app_test

import (
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// CBF-173: «админ не может назначить роль — нет прав». Since the ADR-0078 addendum every
// private room is closed to admins, and the role guard (ADR-0029) refused every role invited to
// any private room the admin was not in. A room that invited a role lets in its holders: the
// admin hands such a role to others (ADR-0026 addendum 2026-11-10), not to themselves.
func TestAdminAssignsRoleOfPrivateRoom(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	adm, a := register(t, code), register(t, code)
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+adm.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	adminRole := builtinRole(t, o, wid, adminR).GetId()
	plain, team := newRole(t, o, wid, "plain", 0), newRole(t, o, wid, "team", 0)
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{
		Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "secret", IsPrivate: true, RoleIds: []string{team.GetId()},
	}, &cr)
	rid := cr.GetRoom().GetId()
	if _, st := roomPerms(t, adm, rid); st != 404 {
		t.Fatalf("the admin sees the private room: %d", st)
	}
	if st, _ := setMemberRoles(adm, wid, a.id, plain.GetId(), team.GetId()); st != 200 {
		t.Fatalf("admin assigns a role invited to a private room: %d %s, want 200", st, adm.lastBody)
	}
	if _, st := roomPerms(t, a, rid); st != 200 {
		t.Fatalf("the member given the role: %d, want 200", st)
	}
	st, _ := setMemberRoles(adm, wid, adm.id, adminRole, team.GetId())
	var e v1.ApiError
	if st != 403 || protojson.Unmarshal(adm.lastBody, &e) != nil || e.GetReason() != "OWNER_ONLY" {
		t.Fatalf("admin gives themselves the role: %d %s, want 403 OWNER_ONLY", st, adm.lastBody)
	}
	if _, st := roomPerms(t, adm, rid); st != 404 {
		t.Fatalf("the admin sees the room after a refused grant: %d", st)
	}
	if st, _ := setMemberRoles(adm, wid, a.id, plain.GetId()); st != 200 {
		t.Fatalf("admin takes the role back: %d", st)
	}
	// Nor by the back door of an invitation (CBF-174): a link with the role, made by the admin,
	// gives it to others — not to the admin coming back by it after leaving.
	var cr2 v1.CreateInviteResponse
	adm.must(201, "POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{MaxUses: 5, RoleIds: []string{team.GetId()}}, &cr2)
	adm.must(204, "DELETE", "/api/workspaces/"+wid+"/members/"+adm.id, nil, nil)
	adm.must(200, "POST", "/api/invites/"+cr2.GetInvite().GetCode()+"/join", nil, nil)
	if ids := memberRoleIDs(t, o, wid, adm.id); len(ids) != 1 {
		t.Fatalf("admin rejoined by their own link: roles %v, want the member role only", ids)
	}
	if _, st := roomPerms(t, adm, rid); st != 404 {
		t.Fatalf("the admin sees the private room after rejoining by their own link: %d", st)
	}
}
