//go:build integration

package app_test

import (
	"net/url"
	"slices"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// ADR-0078: a private temporary room is seen only by its creator, the people chosen for it and
// whoever entered by its link — not by admins, not by the owner, live or archived; a public
// temporary room stays as it was. Actors: the owner; an admin; a member with workspace-level
// MANAGE_ROOM / MUTE / MOVE (a «moderator» role); the creator; a chosen member; a member who
// joins by the link; a member who is neither.
func TestPrivateTempRoomHiddenFromAdmins(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	admin, mod, creator, chosen, linked, other := register(t, code), register(t, code), register(t, code), register(t, code), register(t, code), register(t, code)
	adminR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+admin.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	mods := newRole(t, o, wid, "mods", perm.ManageRoom|perm.MuteMembers|perm.MoveMembers|perm.ManageEvents|perm.ManageRecordings)
	if st, _ := setMemberRoles(o, wid, mod.id, mods.GetId()); st != 200 {
		t.Fatalf("assign mods: %d", st)
	}
	ga, gc := dialGW(t), dialGW(t)
	ga.identify(admin.token)
	gc.identify(chosen.token)

	// A public temporary room is unchanged: the admin and the owner see it with everything.
	pub := tempRoom(t, creator, wid, &v1.CreateTempRoomRequest{Name: "Общая", TtlSeconds: 3600, Guests: noGuests()}).GetRoom().GetId()
	for _, u := range []*user{o, admin} {
		if bits, st := roomPerms(t, u, pub); st != 200 || perm.Bits(bits) != perm.All {
			t.Fatalf("%s in a public temp room: %d %d", u.email, st, bits)
		}
	}

	res := tempRoom(t, creator, wid, &v1.CreateTempRoomRequest{Name: "Один на один", TtlSeconds: 3600, Guests: noGuests(),
		Private: true, MemberIds: []string{chosen.id}, WithEvent: true})
	rid, ev := res.GetRoom().GetId(), res.GetEvent()
	gc.wait("ROOM_CREATE to the chosen member", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == rid })
	ga.quiet("ROOM_CREATE of the private temp room to the admin", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetRoomCreate().GetRoom().GetId() == rid
	})
	linked.must(200, "POST", "/api/room-invites/"+res.GetInviteCode()+"/join", &v1.JoinRoomInviteRequest{}, nil)

	insiders := []*user{creator, chosen, linked}
	outsiders := []*user{o, admin, mod, other}
	member := perm.RoleDefaults[perm.RoleMember]
	for _, u := range insiders {
		bits, st := roomPerms(t, u, rid)
		if st != 200 || !perm.Bits(bits).Has(perm.ViewRoom|perm.Connect|perm.SendMessages) || perm.Bits(bits)&perm.Administrator != 0 {
			t.Fatalf("%s must see the private temp room: %d %d", u.email, st, bits)
		}
		if _, ok := visibleRooms(t, u, wid)[rid]; !ok {
			t.Fatalf("%s: the room is not listed", u.email)
		}
	}
	if bits, _ := roomPerms(t, creator, rid); perm.Bits(bits)&^member != 0 {
		t.Fatalf("creator bits %d: only the member's", bits)
	}
	needle := tag()
	secret := sendRetry(t, chosen, rid, "секрет "+needle)
	_, file, _ := upload(t, chosen, "/api/workspaces/"+wid+"/files", "тайна_"+needle+".txt", []byte("x"))
	chosen.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{file.GetId()}, Nonce: uniq("f")}, nil)
	from, to := time.Now().Add(-time.Hour), time.Now().Add(3*time.Hour)
	events := "/api/workspaces/" + wid + "/events?from=" + url.QueryEscape(from.Format(time.RFC3339)) + "&to=" + url.QueryEscape(to.Format(time.RFC3339))

	for _, u := range outsiders {
		if _, st := roomPerms(t, u, rid); st != 404 {
			t.Fatalf("%s sees the private temp room: %d", u.email, st)
		}
		if _, ok := visibleRooms(t, u, wid)[rid]; ok {
			t.Fatalf("%s: the room is listed", u.email)
		}
		u.must(404, "GET", "/api/rooms/"+rid+"/messages", nil, nil)
		u.must(404, "GET", "/api/rooms/"+rid+"/pins", nil, nil)
		u.must(404, "PUT", "/api/messages/"+secret.GetId()+"/reactions/"+url.PathEscape("👍"), nil, nil)
		u.must(404, "POST", "/api/rooms/"+rid+"/join", nil, nil)
		u.must(404, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "x", Nonce: uniq("n")}, nil)
		u.must(404, "GET", "/api/rooms/"+rid+"/invites", nil, nil)
		u.must(404, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
		u.must(404, "DELETE", "/api/rooms/"+rid, nil, nil)
		// Moderation inside the room.
		u.must(404, "POST", "/api/rooms/"+rid+"/voice/"+chosen.id+"/disconnect", nil, nil)
		u.must(404, "POST", "/api/rooms/"+rid+"/voice/"+chosen.id+"/mute", nil, nil)
		// Search: messages and files.
		if got := hits(t, u, q(needle)+"&scope="+wid, v1.SearchType_SEARCH_TYPE_MESSAGES); len(got) != 0 {
			t.Fatalf("%s finds the room's messages: %v", u.email, got)
		}
		if got := hits(t, u, q(needle)+"&scope="+wid, v1.SearchType_SEARCH_TYPE_FILES); len(got) != 0 {
			t.Fatalf("%s finds the room's files: %v", u.email, got)
		}
		var sr v1.ListMessagesResponse
		u.must(200, "GET", "/api/workspaces/"+wid+"/messages/search?q="+needle, nil, &sr)
		if len(sr.GetMessages()) != 0 {
			t.Fatalf("%s: messages/search finds %d", u.email, len(sr.GetMessages()))
		}
		// The room's meeting (the creator organizes it alone).
		var cal v1.ListCalendarEventsResponse
		u.must(200, "GET", events, nil, &cal)
		if slices.ContainsFunc(cal.GetEvents(), func(e *v1.CalendarEvent) bool { return e.GetId() == ev.GetId() }) {
			t.Fatalf("%s sees the room's meeting", u.email)
		}
	}
	// Moving someone into the room from a public one needs MOVE_MEMBERS there too.
	for _, u := range []*user{o, admin, mod} {
		if st := u.do("POST", "/api/rooms/"+pub+"/voice/"+other.id+"/move", &v1.MoveMemberRequest{TargetRoomId: rid}, nil); st != 403 {
			t.Fatalf("%s moves into the private temp room: %d", u.email, st)
		}
	}
	if hits(t, chosen, q(needle)+"&scope="+wid, v1.SearchType_SEARCH_TYPE_MESSAGES)[secret.GetId()] == nil {
		t.Fatal("the chosen member finds the room's message")
	}
	var cal v1.ListCalendarEventsResponse
	creator.must(200, "GET", events, nil, &cal)
	if !slices.ContainsFunc(cal.GetEvents(), func(e *v1.CalendarEvent) bool { return e.GetId() == ev.GetId() }) {
		t.Fatal("the creator sees the meeting")
	}
	// The chosen member passes the permission check of a join (LiveKit itself may be absent here).
	if st := chosen.do("POST", "/api/rooms/"+rid+"/join", nil, nil); st == 403 || st == 404 {
		t.Fatalf("the chosen member joins: %d", st)
	}
	// READY of an admin who connects now leaves it out.
	for _, s := range dialGW(t).identify(o.token).GetWorkspaces() {
		if slices.ContainsFunc(s.GetRooms(), func(r *v1.Room) bool { return r.GetId() == rid }) {
			t.Fatal("the owner's READY lists the private temp room")
		}
		if _, ok := s.GetPermissions()[rid]; ok {
			t.Fatal("the owner's READY carries bits of the private temp room")
		}
	}

	// A chosen admin counts as a member: no ADMINISTRATOR in the room.
	var g v1.GetRoomResponse
	creator.must(200, "GET", "/api/rooms/"+rid, nil, &g)
	ovs := append(slices.Clone(g.GetRoom().GetPermissionOverrides()), userOv(admin.id, perm.ViewRoom|perm.Connect, 0))
	creator.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
	ga.wait("ROOM_CREATE once the admin is chosen", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == rid })
	if bits, st := roomPerms(t, admin, rid); st != 200 || perm.Bits(bits) != member {
		t.Fatalf("chosen admin: %d bits %d, want the member's %d", st, bits, member)
	}
	admin.must(403, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{Name: ptrTo("x")}, nil)
	creator.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: g.GetRoom().GetPermissionOverrides()}, nil)
	ga.wait("ROOM_DELETE once the admin is off the list", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == rid })

	// Public and back: the admin gets ROOM_CREATE, then ROOM_DELETE.
	f, tr := false, true
	creator.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{IsPrivate: &f}, nil)
	ga.wait("ROOM_CREATE when the room goes public", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == rid })
	if bits, st := roomPerms(t, admin, rid); st != 200 || perm.Bits(bits) != perm.All {
		t.Fatalf("admin in the room made public: %d %d", st, bits)
	}
	creator.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{IsPrivate: &tr}, nil)
	ga.wait("ROOM_DELETE when the room goes private", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == rid })
	if _, st := roomPerms(t, admin, rid); st != 404 {
		t.Fatalf("admin after private again: %d", st)
	}
	for _, u := range insiders {
		if _, st := roomPerms(t, u, rid); st != 200 {
			t.Fatalf("%s after private again: %d", u.email, st)
		}
	}

	// Archived: history for the insiders only; the archive list leaves it out for admins.
	creator.must(204, "DELETE", "/api/rooms/"+rid, nil, nil)
	chosen.must(200, "GET", "/api/rooms/"+rid+"/messages", nil, nil)
	if st, _ := setMemberRoles(o, wid, chosen.id, mods.GetId()); st != 200 {
		t.Fatalf("assign mods to the chosen member: %d", st)
	}
	archived := func(u *user) bool {
		var arch v1.ListRoomsResponse
		u.must(200, "GET", "/api/workspaces/"+wid+"/rooms?archived=1", nil, &arch)
		return slices.ContainsFunc(arch.GetRooms(), func(r *v1.Room) bool { return r.GetId() == rid })
	}
	for _, u := range []*user{o, admin, mod} {
		u.must(404, "GET", "/api/rooms/"+rid+"/messages", nil, nil)
		if archived(u) {
			t.Fatalf("%s lists the archived private temp room", u.email)
		}
	}
	if !archived(chosen) {
		t.Fatal("a chosen member with MANAGE_ROOM lists the archived room")
	}
}

func ptrTo[T any](v T) *T { return &v }
