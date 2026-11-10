//go:build integration

package app_test

import (
	"slices"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestRolesV2 (ADR-0048): every check moved off MANAGE_WORKSPACE works with its own bit and
// not with MANAGE_WORKSPACE alone; closed rooms and boards are 404 for everyone without an
// override on them (administrators included) except the owner; the one who closes keeps access;
// the owner opens again. The migration of existing roles: internal/db TestRolesV2Migration.
func TestRolesV2(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	var inv v1.CreateInviteResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{MaxUses: 100}, &inv)
	code := inv.GetInvite().GetCode()
	base := "/api/workspaces/" + wid

	// One person per bit, plus "ws" with MANAGE_WORKSPACE alone and "roomMgr" with MANAGE_ROOM
	// (the other half of allow_recording). The first role created stays the highest custom one.
	bits := map[string]perm.Bits{
		"members": perm.ManageMembers, "ws": perm.ManageWorkspace, "boards": perm.CreateBoards,
		"bots": perm.ManageBots, "integr": perm.ManageIntegrations, "journals": perm.ViewJournals,
		"events": perm.ManageEvents, "rec": perm.ManageRecordings | perm.ManageRoom, "roomMgr": perm.ManageRoom,
		"wsRoom": perm.ManageWorkspace | perm.ManageRoom,
	}
	order := []string{"members", "ws", "boards", "bots", "integr", "journals", "events", "rec", "roomMgr", "wsRoom"}
	u := map[string]*user{}
	for _, n := range order {
		u[n] = register(t, code)
		r := newRole(t, o, wid, n, bits[n])
		if st, _ := setMemberRoles(o, wid, u[n].id, r.GetId()); st != 200 {
			t.Fatalf("assign %s: %d", n, st)
		}
	}
	plain := register(t, code)
	var vr v1.CreateRoomResponse
	o.must(201, "POST", base+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "voice"}, &vr)
	voice := vr.GetRoom().GetId()
	pub := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Public", Key: "PUB"}, 201)
	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	ev := createEvent(t, o, wid, &v1.CreateCalendarEventRequest{Title: "Sync", StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: voice})
	off := false
	bad := "abc"

	moved := []struct {
		what      string
		who, deny string // who succeeds with the bit, who is refused (MANAGE_WORKSPACE alone or its pair)
		ok        int
		call      func(c *user) int
	}{
		{"create a board (CREATE_BOARDS)", "boards", "ws", 201, func(c *user) int {
			return c.do("POST", base+"/boards", &v1.CreateBoardRequest{Name: uniq("b")}, nil)
		}},
		{"list bans (MANAGE_MEMBERS)", "members", "ws", 200, func(c *user) int { return c.do("GET", base+"/bans", nil, nil) }},
		{"ban (MANAGE_MEMBERS)", "members", "ws", 201, func(c *user) int {
			return c.do("POST", base+"/bans", &v1.CreateBanRequest{UserId: register(t, code).id}, nil)
		}},
		{"kick (MANAGE_MEMBERS)", "members", "ws", 204, func(c *user) int {
			return c.do("DELETE", base+"/members/"+register(t, code).id, nil, nil)
		}},
		{"built-in role (MANAGE_MEMBERS)", "members", "ws", 200, func(c *user) int {
			g := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
			return c.do("PATCH", base+"/members/"+register(t, code).id, &v1.UpdateMemberRequest{Role: &g}, nil)
		}},
		{"badge library (MANAGE_MEMBERS; an unknown badge is 404)", "members", "ws", 404, func(c *user) int {
			return c.do("DELETE", base+"/badges/01890000-0000-7000-8000-00000000abcd", nil, nil)
		}},
		{"list bots (MANAGE_BOTS)", "bots", "ws", 200, func(c *user) int { return c.do("GET", base+"/bots", nil, nil) }},
		{"telephony settings (MANAGE_INTEGRATIONS)", "integr", "ws", 200, func(c *user) int { return c.do("GET", base+"/sip", nil, nil) }},
		{"GPTunneL pairing (MANAGE_INTEGRATIONS; a bad code is 422)", "integr", "ws", 422, func(c *user) int {
			return c.do("POST", base+"/integrations/gptunnel", &v1.PairGptunnelRequest{Code: bad}, nil)
		}},
		{"call journal (VIEW_JOURNALS)", "journals", "ws", 200, func(c *user) int { return c.do("GET", base+"/calls", nil, nil) }},
		{"board activity (VIEW_JOURNALS)", "journals", "ws", 200, func(c *user) int {
			return c.do("GET", "/api/boards/"+pub.GetId()+"/activity", nil, nil)
		}},
		{"another's meeting (MANAGE_EVENTS)", "events", "ws", 200, func(c *user) int {
			title := uniq("t")
			return c.do("PATCH", "/api/events/"+ev.GetId(), &v1.UpdateCalendarEventRequest{Title: &title}, nil)
		}},
		{"allow_recording (MANAGE_RECORDINGS + MANAGE_ROOM)", "rec", "wsRoom", 200, func(c *user) int {
			return c.do("PATCH", "/api/rooms/"+voice, &v1.UpdateRoomRequest{AllowRecording: &off}, nil)
		}},
		{"allow_recording without MANAGE_RECORDINGS", "rec", "roomMgr", 200, func(c *user) int {
			return c.do("PATCH", "/api/rooms/"+voice, &v1.UpdateRoomRequest{AllowRecording: &off}, nil)
		}},
	}
	for _, c := range moved {
		if got := c.call(u[c.who]); got != c.ok {
			t.Errorf("%s as %s: %d, want %d (%s)", c.what, c.who, got, c.ok, u[c.who].lastBody)
		}
		if got := c.call(u[c.deny]); got != 403 {
			t.Errorf("%s as %s: %d, want 403", c.what, c.deny, got)
		}
		if got := c.call(plain); got != 403 && got != 404 {
			t.Errorf("%s as a plain member: %d, want 403", c.what, got)
		}
	}
	// MANAGE_BOTS creates and deletes bots; MANAGE_WORKSPACE alone does not.
	bt := createBot(t, u["bots"], wid, "v2bot")
	u["ws"].must(403, "POST", base+"/bots", &v1.CreateBotRequest{DisplayName: "x", Username: "x_v2_nobot"}, nil)
	u["ws"].must(403, "DELETE", base+"/bots/"+bt.id, nil, nil)
	u["bots"].must(204, "DELETE", base+"/bots/"+bt.id, nil, nil)
}

// TestRolesV2ClosedBoard: a private board (ADR-0048, ADR-0058 addendum 2026-10-14: restricted is
// an alias of is_private) is 404 for an administrator, the workspace owner and workspace
// MANAGE_BOARD / VIEW_JOURNALS without an override on it, in lists, tasks, links, search and the
// activity; the creator, a role override, a personal override and a bot with an override see
// it; guests never; the creator opens it again.
func TestRolesV2ClosedBoard(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	base := "/api/workspaces/" + wid
	adminR, guestR := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN, v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	admin, adminOv, pm, seller, pmo, guest, plain := register(t, code), register(t, code), register(t, code), register(t, code), register(t, code), register(t, code), register(t, code)
	sales := newRole(t, o, wid, "sales", 0)
	pmRole := newRole(t, o, wid, "pm", perm.CreateBoards)
	pmoRole := newRole(t, o, wid, "pmo", perm.ViewBoard|perm.ManageBoard|perm.EditTasks|perm.ViewJournals|perm.ManageWorkspace)
	for who, role := range map[*user]string{seller: sales.GetId(), pm: pmRole.GetId(), pmo: pmoRole.GetId()} {
		if st, _ := setMemberRoles(o, wid, who.id, role); st != 200 {
			t.Fatalf("assign: %d", st)
		}
	}
	for _, a := range []*user{admin, adminOv} {
		o.must(200, "PATCH", base+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	}
	o.must(200, "PATCH", base+"/members/"+guest.id, &v1.UpdateMemberRequest{Role: &guestR}, nil)
	bt := createBot(t, o, wid, "closedbot")
	btOut := createBot(t, o, wid, "outbot")

	// restricted is an alias of is_private: both must agree.
	open := createBoard(t, pm, wid, &v1.CreateBoardRequest{Name: "Open", Key: "OPN"}, 201)
	on, off := true, false
	pm.must(422, "PATCH", "/api/boards/"+open.GetId(), &v1.UpdateBoardRequest{Restricted: &on, IsPrivate: &off}, nil)
	var ob v1.BoardResponse
	pm.must(200, "PATCH", "/api/boards/"+open.GetId(), &v1.UpdateBoardRequest{Restricted: &on}, &ob)
	if !ob.GetBoard().GetIsPrivate() || !ob.GetBoard().GetRestricted() {
		t.Fatalf("restricted on makes the board private: %v", ob.GetBoard())
	}

	b := createBoard(t, pm, wid, &v1.CreateBoardRequest{Name: "Deals", Key: "DLS", IsPrivate: true}, 201)
	bid := b.GetId()
	setBoardPerms(pm, bid, 200, append(cloneBoardOverrides(t, pm, bid),
		roleOv(sales.GetId(), perm.ViewBoard|perm.CreateTasks, 0),
		userOv(adminOv.id, perm.ViewBoard, 0), userOv(bt.id, perm.ViewBoard, 0), userOv(guest.id, perm.ViewBoard, 0))...)
	task := createTask(t, pm, bid, &v1.CreateTaskRequest{Title: "closed-needle"}, 201)
	// Admins do not see a private board (ADR-0058 addendum 2026-10-14); pmo's workspace board
	// bits never open one either.
	admin.must(404, "GET", "/api/boards/"+bid, nil, nil)

	var br v1.BoardResponse
	pm.must(200, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Restricted: &on}, &br)
	if !br.GetBoard().GetRestricted() || br.GetBoard().GetPermissions()&uint64(perm.ManageBoard) == 0 {
		t.Fatalf("the creator after closing: %v", br.GetBoard())
	}

	type actor struct {
		name string
		c    musty
		do   func(m, p string) int
		sees bool
	}
	userActor := func(n string, x *user, sees bool) actor {
		return actor{n, x, func(m, p string) int { return x.do(m, p, nil, nil) }, sees}
	}
	actors := []actor{
		userActor("owner", o, false), userActor("creator", pm, true), userActor("role override", seller, true),
		userActor("admin with override", adminOv, true), userActor("admin", admin, false),
		userActor("workspace MANAGE_BOARD/VIEW_JOURNALS", pmo, false), userActor("guest with override", guest, false),
		userActor("member", plain, false),
		{"bot with override", bt, func(m, p string) int { return bt.do(m, p, nil, nil) }, true},
		{"bot", btOut, func(m, p string) int { return btOut.do(m, p, nil, nil) }, false},
	}
	for _, a := range actors {
		want := 404
		if a.sees {
			want = 200
		}
		for _, p := range []string{"/api/boards/" + bid, "/api/tasks/" + task.GetId(), "/api/t/" + task.GetKey(), "/api/boards/" + bid + "/tasks"} {
			if got := a.do("GET", p); got != want && (a.name != "guest with override" || got != 403) {
				t.Errorf("%s GET %s: %d, want %d", a.name, p, got, want)
			}
		}
		if a.name == "guest with override" {
			continue // guests have no board list or search (403)
		}
		var lr v1.ListBoardsResponse
		a.c.must(200, "GET", base+"/boards", nil, &lr)
		listed := slices.ContainsFunc(lr.GetBoards(), func(x *v1.Board) bool { return x.GetId() == bid })
		if listed != a.sees {
			t.Errorf("%s: listed=%v", a.name, listed)
		}
		var sr v1.SearchTasksResponse
		a.c.must(200, "GET", base+"/tasks/search?q=closed-needle", nil, &sr)
		found := slices.ContainsFunc(sr.GetTasks(), func(x *v1.Task) bool { return x.GetId() == task.GetId() })
		if found != a.sees {
			t.Errorf("%s: search found=%v", a.name, found)
		}
	}
	// The activity export: VIEW_JOURNALS of an administrator does not reach a closed board.
	admin.must(404, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	pmo.must(404, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	pm.must(200, "GET", "/api/boards/"+bid+"/activity", nil, nil)
	// The board invited the sales role: an admin who cannot see it hands the role to others
	// (ADR-0026 addendum 2026-11-10, CBF-173), but not to themselves nor to a bot.
	adminRole := builtinRole(t, o, wid, adminR).GetId()
	if st, _ := setMemberRoles(admin, wid, plain.id, sales.GetId()); st != 200 {
		t.Fatalf("admin grants the sales role to a member: %d, want 200", st)
	}
	plain.must(200, "GET", "/api/boards/"+bid, nil, nil)
	if st, _ := setMemberRoles(admin, wid, admin.id, adminRole, sales.GetId()); st != 403 {
		t.Fatalf("admin grants the sales role to themselves: %d, want 403", st)
	}
	if st, _ := setMemberRoles(admin, wid, btOut.id, sales.GetId()); st != 403 {
		t.Fatalf("admin grants the sales role to a bot: %d, want 403", st)
	}
	if st, _ := setMemberRoles(admin, wid, plain.id); st != 200 {
		t.Fatalf("admin takes the sales role back: %d", st)
	}
	// The same for a role that opens it partly: create-only there (ADR-0115) lists the board and
	// lets its holders create and see their cards. A role without an override on it is fine.
	free, clerks := newRole(t, o, wid, "free", 0), newRole(t, o, wid, "clerks", 0)
	setBoardPerms(pm, bid, 200, append(cloneBoardOverrides(t, pm, bid), roleOv(clerks.GetId(), perm.CreateTasks, 0))...)
	if st, _ := setMemberRoles(admin, wid, plain.id, free.GetId()); st != 200 {
		t.Fatalf("admin grants a role the board does not name: %d, want 200", st)
	}
	if st, _ := setMemberRoles(admin, wid, admin.id, adminRole, clerks.GetId()); st != 403 {
		t.Fatalf("admin grants themselves a create-only role: %d, want 403", st)
	}
	if st, _ := setMemberRoles(adminOv, wid, plain.id, clerks.GetId()); st != 200 {
		t.Fatalf("admin who sees the board grants a create-only role: %d, want 200", st)
	}
	if st, _ := setMemberRoles(o, wid, plain.id); st != 200 {
		t.Fatalf("reset: %d", st)
	}
	// Nor change the flag or the access of a board they do not see.
	admin.must(404, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Restricted: &off}, nil)
	// An admin let in by an override has member bits there, not MANAGE_BOARD.
	adminOv.must(403, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Restricted: &off}, nil)

	// The owner does not see it either; the creator opens it: administrators see it again.
	o.must(404, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Restricted: &off}, nil)
	pm.must(200, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{IsPrivate: &off}, nil)
	admin.must(200, "GET", "/api/boards/"+bid, nil, nil)
	admin.must(200, "GET", "/api/boards/"+bid+"/activity", nil, nil)

	// An administrator who makes a board private keeps it through a personal override.
	admin.must(200, "PATCH", "/api/boards/"+bid, &v1.UpdateBoardRequest{Restricted: &on}, &br)
	if br.GetBoard().GetPermissions()&uint64(perm.ManageBoard) == 0 || perm.Bits(br.GetBoard().GetPermissions()) == perm.All {
		t.Fatalf("the admin who closed it: %d", br.GetBoard().GetPermissions())
	}
	adminOv.must(200, "GET", "/api/boards/"+bid, nil, nil)
	pmo.must(404, "GET", "/api/boards/"+bid, nil, nil)

	// An archived closed board stays readable to those let in: the role guard covers it too.
	blind := register(t, code)
	o.must(200, "PATCH", base+"/members/"+blind.id, &v1.UpdateMemberRequest{Role: &adminR}, nil)
	pm.must(204, "DELETE", "/api/boards/"+bid, nil, nil)
	if st, _ := setMemberRoles(blind, wid, blind.id, adminRole, sales.GetId()); st != 403 {
		t.Fatalf("admin grants themselves the sales role of an archived closed board: %d, want 403", st)
	}
}

// TestRolesV2ClosedRoom: the ADR-0048 rule for closed rooms, every private room since the
// ADR-0078 addendum 2026-10-14 — VIEW_ROOM of the roles lets nobody in (a private room whose
// member deny was dropped stays closed), workspace MANAGE_ROOM / MANAGE_WORKSPACE /
// MANAGE_RECORDINGS give nothing, an override does; the owner (its creator) sees it as a member.
func TestRolesV2ClosedRoom(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	mem, boss, insider := register(t, code), register(t, code), register(t, code)
	bossRole := newRole(t, o, wid, "boss", perm.ManageWorkspace|perm.ManageRoom|perm.ManageRecordings|perm.ViewJournals)
	if st, _ := setMemberRoles(o, wid, boss.id, bossRole.GetId()); st != 200 {
		t.Fatalf("assign boss: %d", st)
	}
	rid := textRoom(t, o, wid, "closed", true)
	// Only the insider's personal allow; the member role's deny of the private room removed.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{userOv(insider.id, perm.ViewRoom, 0)}}, nil)
	on := true
	o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{Restricted: &on}, nil)
	for name, x := range map[string]*user{"member": mem, "boss": boss} {
		if _, st := roomPerms(t, x, rid); st != 404 {
			t.Errorf("%s in a closed room without an override: %d, want 404", name, st)
		}
		if _, listed := visibleRooms(t, x, wid)[rid]; listed {
			t.Errorf("%s: the closed room is listed", name)
		}
	}
	if bits, st := roomPerms(t, insider, rid); st != 200 || perm.Bits(bits) != perm.RoleDefaults[perm.RoleMember] {
		t.Errorf("insider: %d bits %d", st, bits)
	}
	if bits, st := roomPerms(t, o, rid); st != 200 || perm.Bits(bits) != perm.RoleDefaults[perm.RoleMember]|perm.RoomOnly {
		t.Errorf("owner (the creator, no bypass): %d bits %d", st, bits)
	}

	// The creator of a private temporary room closes it: keeps it (VIEW_ROOM by override) and
	// still manages it as its creator, without being handed MANAGE_ROOM; opens it again.
	tr := tempRoom(t, mem, wid, &v1.CreateTempRoomRequest{Name: "client", TtlSeconds: 3600, Private: true, Guests: noGuests()})
	tid := tr.GetRoom().GetId()
	mem.must(200, "PATCH", "/api/rooms/"+tid, &v1.UpdateRoomRequest{Restricted: &on}, nil)
	if bits, st := roomPerms(t, mem, tid); st != 200 || perm.Bits(bits).Has(perm.ManageRoom) {
		t.Errorf("temp creator after closing: %d bits %d, want 200 without MANAGE_ROOM", st, bits)
	}
	if _, st := roomPerms(t, boss, tid); st != 404 {
		t.Errorf("boss sees the closed temporary room: %d", st)
	}
	off := false
	mem.must(200, "PATCH", "/api/rooms/"+tid, &v1.UpdateRoomRequest{Restricted: &off}, nil)
}

// cloneBoardOverrides returns the board's current overrides (to extend them).
func cloneBoardOverrides(t *testing.T, u musty, boardID string) []*v1.RoomPermissionOverride {
	t.Helper()
	var r v1.BoardPermissionsResponse
	u.must(200, "GET", "/api/boards/"+boardID+"/permissions", nil, &r)
	return r.GetOverrides()
}
