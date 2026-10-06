//go:build integration

// Temporary rooms (ADR-0044).
package app_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/voice"
)

func tempRoom(t *testing.T, u *user, wsID string, req *v1.CreateTempRoomRequest) *v1.TempRoomResponse {
	t.Helper()
	var r v1.TempRoomResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/rooms/temp", req, &r)
	return &r
}

func noGuests() *bool { f := false; return &f }

func sqlExec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(), q, args...); err != nil {
		t.Fatal(err)
	}
}

func apiErrOf(t *testing.T, c *client, want int, method, path string, in any) (v1.ErrorCode, string) {
	t.Helper()
	var st int
	switch m := in.(type) {
	case nil:
		st = c.do(method, path, nil, nil)
	case *v1.CreateTempRoomRequest:
		st = c.do(method, path, m, nil)
	case *v1.UpdateRoomRequest:
		st = c.do(method, path, m, nil)
	case *v1.CreateMessageRequest:
		st = c.do(method, path, m, nil)
	case *v1.JoinRoomInviteRequest:
		st = c.do(method, path, m, nil)
	default:
		t.Fatalf("unexpected body %T", in)
	}
	if st != want {
		t.Fatalf("%s %s: status %d, want %d (%s)", method, path, st, want, c.lastBody)
	}
	reason, code := errReason(c)
	return code, reason
}

func TestTempRooms(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	bob, carol, dave := register(t, code), register(t, code), register(t, code)
	base := "/api/workspaces/" + wid + "/rooms/temp"
	g := dialGW(t)
	g.identify(carol.token)

	// Public room by a member (member default has CREATE_TEMP_ROOMS), members-only link.
	pub := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Созвон", TtlSeconds: 3600, Guests: noGuests()})
	pr := pub.GetRoom()
	if pr.GetExpiresAt() == nil || pr.GetCreatedBy() != bob.id || pr.GetType() != v1.RoomType_ROOM_TYPE_VOICE ||
		pr.GetIsPrivate() || pub.GetEvent() != nil || !strings.HasPrefix(pub.GetInviteUrl(), "https://app.example.com/r/") ||
		!strings.HasSuffix(pub.GetInviteUrl(), pub.GetInviteCode()) {
		t.Fatalf("public temp room: %v", pub)
	}
	if d := time.Until(pr.GetExpiresAt().AsTime()); d < 59*time.Minute || d > time.Hour {
		t.Fatalf("expires_at in %v", d)
	}
	g.wait("ROOM_CREATE of the public temp room", func(e *v1.DispatchEvent) bool {
		return e.GetRoomCreate().GetRoom().GetId() == pr.GetId() && e.GetRoomCreate().GetRoom().GetExpiresAt() != nil
	})
	if _, ok := visibleRooms(t, carol, wid)[pr.GetId()]; !ok {
		t.Fatal("a public temp room is visible to every member")
	}
	var members, allowGuests bool
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT members_only, allow_guests FROM room_invites WHERE code = $1", pub.GetInviteCode()).
		Scan(&members, &allowGuests); err != nil || !members || allowGuests {
		t.Fatalf("guests=false makes a members-only link: %v %v %v", members, allowGuests, err)
	}

	// Validation; a guest link needs INVITE_GUESTS (members lack it, ADR-0043).
	for _, bad := range []*v1.CreateTempRoomRequest{
		{Name: "", TtlSeconds: 3600, Guests: noGuests()},
		{Name: "x", TtlSeconds: 899, Guests: noGuests()},
		{Name: "x", TtlSeconds: 604801, Guests: noGuests()},
		{Name: "x", TtlSeconds: 3600, Guests: noGuests(), MemberIds: []string{carol.id}}, // people for a private room only
		{Name: "x", TtlSeconds: 3600, Guests: noGuests(), Private: true, MemberIds: []string{uuid.NewString()}},
	} {
		if c, _ := apiErrOf(t, bob.client, 422, "POST", base, bad); c != v1.ErrorCode_ERROR_CODE_VALIDATION {
			t.Fatalf("%v: %v", bad, c)
		}
	}
	apiErrOf(t, bob.client, 403, "POST", base, &v1.CreateTempRoomRequest{Name: "x", TtlSeconds: 3600})
	host := newRole(t, o, wid, "host", perm.InviteGuests)
	if st, _ := setMemberRoles(o, wid, bob.id, host.GetId()); st != 200 {
		t.Fatalf("assign host: %d", st)
	}

	// Private room with a guest link, a chosen member and a meeting.
	priv := tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "Клиент", TtlSeconds: 7200, Private: true, MemberIds: []string{carol.id}, WithEvent: true})
	rp := priv.GetRoom()
	ev := priv.GetEvent()
	if !rp.GetIsPrivate() || ev == nil || ev.GetRoomId() != rp.GetId() || !ev.GetEndsAt().AsTime().Equal(rp.GetExpiresAt().AsTime()) ||
		ev.GetStartsAt().AsTime().Minute()%5 != 0 || ev.GetStartsAt().AsTime().Before(time.Now().Add(-time.Minute)) {
		t.Fatalf("private temp room: %v", priv)
	}
	for _, u := range []*user{bob, carol} {
		if _, st := roomPerms(t, u, rp.GetId()); st != 200 {
			t.Fatalf("%s must see the private room: %d", u.email, st)
		}
	}
	for _, u := range []*user{dave, o} { // ADR-0078: not even the owner
		if _, st := roomPerms(t, u, rp.GetId()); st != 404 {
			t.Fatalf("%s must not see the private room: %d", u.email, st)
		}
	}
	// A member joining by the link gets a personal allow (idempotently), a guest too.
	var j v1.JoinRoomInviteResponse
	dave.must(200, "POST", "/api/room-invites/"+priv.GetInviteCode()+"/join", &v1.JoinRoomInviteRequest{}, &j)
	if bits, st := roomPerms(t, dave, rp.GetId()); st != 200 || !perm.Bits(bits).Has(perm.ViewRoom|perm.Connect|perm.Speak) {
		t.Fatalf("dave after the link: %d %b", st, bits)
	}
	dave.must(200, "POST", "/api/room-invites/"+priv.GetInviteCode()+"/join", &v1.JoinRoomInviteRequest{}, &j)
	guest, _ := anonGuest(t, priv.GetInviteCode(), "Клиент Иван")
	if bits, st := roomPerms(t, guest, rp.GetId()); st != 200 || !perm.Bits(bits).Has(perm.ViewRoom|perm.Connect|perm.Speak|perm.SendMessages) {
		t.Fatalf("guest by the link: %d %b", st, bits)
	}
	apiErrOf(t, guest.client, 403, "POST", base, &v1.CreateTempRoomRequest{Name: "x", TtlSeconds: 3600, Guests: noGuests()})

	// Creator's rights vs a stranger (carol sees the room but does not manage it).
	up := "/api/rooms/" + rp.GetId()
	name := "Клиент 2"
	apiErrOf(t, carol.client, 403, "PATCH", up, &v1.UpdateRoomRequest{Name: &name})
	apiErrOf(t, carol.client, 403, "DELETE", up, nil)
	var ur v1.UpdateRoomResponse
	bob.must(200, "PATCH", up, &v1.UpdateRoomRequest{Name: &name}, &ur)
	newEnd := time.Now().Add(48 * time.Hour).Truncate(time.Second)
	bob.must(200, "PATCH", up, &v1.UpdateRoomRequest{ExpiresAt: timestamppb.New(newEnd)}, &ur)
	if !ur.GetRoom().GetExpiresAt().AsTime().Equal(newEnd) {
		t.Fatalf("extended: %v", ur.GetRoom().GetExpiresAt())
	}
	var linkEnd time.Time
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT expires_at FROM room_invites WHERE code = $1", priv.GetInviteCode()).Scan(&linkEnd); err != nil || !linkEnd.Equal(newEnd) {
		t.Fatalf("the link follows the room: %v %v", linkEnd, err)
	}
	apiErrOf(t, bob.client, 422, "PATCH", up, &v1.UpdateRoomRequest{ExpiresAt: timestamppb.New(time.Now().Add(8 * 24 * time.Hour))})
	apiErrOf(t, bob.client, 422, "PATCH", up, &v1.UpdateRoomRequest{ExpiresAt: timestamppb.New(time.Now().Add(-time.Minute))})
	apiErrOf(t, bob.client, 403, "PATCH", up, &v1.UpdateRoomRequest{MakePermanent: true})
	cat := ""
	apiErrOf(t, bob.client, 422, "PATCH", up, &v1.UpdateRoomRequest{CategoryId: &cat})
	// The creator's links: members-only ones without INVITE_GUESTS too.
	var il v1.ListRoomInvitesResponse
	bob.must(200, "GET", up+"/invites", nil, &il)
	if len(il.GetInvites()) != 1 {
		t.Fatalf("creator lists the room's link: %v", il.GetInvites())
	}
	// Access: private → public → private (MANAGE_ROOM or the creator; temporary rooms only).
	f, tr := false, true
	if st := bob.do("PATCH", "/api/rooms/"+pr.GetId(), &v1.UpdateRoomRequest{IsPrivate: &tr}, &ur); st != 200 {
		t.Fatalf("private: %d %s", st, bob.lastBody)
	}
	if _, st := roomPerms(t, dave, pr.GetId()); st != 404 || !ur.GetRoom().GetIsPrivate() {
		t.Fatalf("made private: %d", st)
	}
	bob.must(200, "PATCH", "/api/rooms/"+pr.GetId(), &v1.UpdateRoomRequest{IsPrivate: &f}, &ur)
	if _, st := roomPerms(t, dave, pr.GetId()); st != 200 || ur.GetRoom().GetIsPrivate() {
		t.Fatalf("made public again: %d", st)
	}
	// Never on a permanent room, even with created_by set.
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "perm"}, &cr)
	sqlExec(t, "UPDATE rooms SET created_by = $1 WHERE id = $2", bob.id, cr.GetRoom().GetId())
	apiErrOf(t, bob.client, 403, "PATCH", "/api/rooms/"+cr.GetRoom().GetId(), &v1.UpdateRoomRequest{Name: &name})
	apiErrOf(t, bob.client, 403, "DELETE", "/api/rooms/"+cr.GetRoom().GetId(), nil)
	apiErrOf(t, o.client, 422, "PATCH", "/api/rooms/"+cr.GetRoom().GetId(), &v1.UpdateRoomRequest{IsPrivate: &tr})

	// Limits: 5 live per creator, 20 per workspace.
	for i := range 3 {
		tempRoom(t, bob, wid, &v1.CreateTempRoomRequest{Name: "r" + string(rune('a'+i)), TtlSeconds: 900, Guests: noGuests()})
	}
	c, reason := apiErrOf(t, bob.client, 409, "POST", base, &v1.CreateTempRoomRequest{Name: "6th", TtlSeconds: 900, Guests: noGuests()})
	if c != v1.ErrorCode_ERROR_CODE_TEMP_ROOM_LIMIT || reason != "PER_USER" {
		t.Fatalf("per-user cap: %v %q", c, reason)
	}
	sqlExec(t, `INSERT INTO rooms (workspace_id, type, name, expires_at, created_by)
		SELECT $1, 'voice', 'filler', now() + interval '1 hour', $2 FROM generate_series(1, 15)`, wid, o.id)
	c, reason = apiErrOf(t, carol.client, 409, "POST", base, &v1.CreateTempRoomRequest{Name: "21st", TtlSeconds: 900, Guests: noGuests()})
	if c != v1.ErrorCode_ERROR_CODE_TEMP_ROOM_LIMIT || reason != "" {
		t.Fatalf("workspace cap: %v %q", c, reason)
	}
	sqlExec(t, "DELETE FROM rooms WHERE workspace_id = $1 AND name = 'filler'", wid)

	// Switched off in the workspace: the member role without the bit.
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	off := member.GetPermissions() &^ uint64(perm.CreateTempRooms)
	var rr v1.UpdateRoleResponse
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &off}, &rr)
	apiErrOf(t, carol.client, 403, "POST", base, &v1.CreateTempRoomRequest{Name: "x", TtlSeconds: 900, Guests: noGuests()})
	on := off | uint64(perm.CreateTempRooms)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &on}, &rr)

	// The creator's overrides stay within their own bits: no denies of bits they lack (a
	// MANAGE_ROOM deny would lock moderators out), no guest let in without INVITE_GUESTS, no
	// guest approval without it.
	cr2 := tempRoom(t, carol, wid, &v1.CreateTempRoomRequest{Name: "carol", TtlSeconds: 900, Guests: noGuests()}).GetRoom().GetId()
	roleOv := func(deny perm.Bits) *v1.RoomPermissionOverride {
		return &v1.RoomPermissionOverride{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: member.GetId(), Deny: uint64(deny)}
	}
	putPerms := func(ovs ...*v1.RoomPermissionOverride) int {
		return carol.do("PUT", "/api/rooms/"+cr2+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
	}
	if st := putPerms(roleOv(perm.ManageRoom)); st != 403 {
		t.Fatalf("creator denies MANAGE_ROOM: %d", st)
	}
	if st := putPerms(roleOv(perm.Stream)); st != 200 {
		t.Fatalf("creator denies a bit they hold: %d %s", st, carol.lastBody)
	}
	guestOv := &v1.RoomPermissionOverride{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: guest.id, Allow: uint64(perm.ViewRoom)}
	if st := putPerms(roleOv(perm.Stream), guestOv); st != 403 {
		t.Fatalf("creator lets a guest in without INVITE_GUESTS: %d", st)
	}
	approval := true
	apiErrOf(t, carol.client, 403, "PATCH", "/api/rooms/"+cr2, &v1.UpdateRoomRequest{GuestApproval: &approval})
	sqlExec(t, "DELETE FROM rooms WHERE id = $1", cr2)

	// Delete = archive: history readable, writes / voice / links refused, the meeting closed.
	send(t, carol, rp.GetId(), "первое", "")
	send(t, guest, rp.GetId(), "второе", "")
	sqlExec(t, "UPDATE events SET starts_at = now() - interval '10 minutes' WHERE id = $1", ev.GetId())
	bob.must(204, "DELETE", up, nil, nil)
	g.wait("ROOM_DELETE of the deleted temp room", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == rp.GetId() })
	if _, ok := visibleRooms(t, carol, wid)[rp.GetId()]; ok {
		t.Fatal("an archived room leaves the list")
	}
	var hist v1.ListMessagesResponse
	carol.must(200, "GET", up+"/messages", nil, &hist)
	if len(hist.GetMessages()) != 2 {
		t.Fatalf("archived history: %d messages", len(hist.GetMessages()))
	}
	if c, _ := apiErrOf(t, carol.client, 410, "POST", up+"/messages", &v1.CreateMessageRequest{Content: "x"}); c != v1.ErrorCode_ERROR_CODE_ROOM_ARCHIVED {
		t.Fatalf("write to an archived room: %v", c)
	}
	apiErrOf(t, carol.client, 410, "POST", up+"/join", nil)
	apiErrOf(t, bob.client, 410, "PATCH", up, &v1.UpdateRoomRequest{Name: &name})
	apiErrOf(t, carol.client, 404, "POST", "/api/room-invites/"+priv.GetInviteCode()+"/join", &v1.JoinRoomInviteRequest{})
	eve := register(t, code) // a member who never had access: the archive stays hidden
	apiErrOf(t, eve.client, 404, "GET", up+"/messages", nil)
	apiErrOf(t, eve.client, 404, "POST", up+"/messages", &v1.CreateMessageRequest{Content: "x"})
	var evEnd time.Time
	var cancelled *time.Time
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT ends_at, cancelled_at FROM events WHERE id = $1", ev.GetId()).Scan(&evEnd, &cancelled); err != nil ||
		cancelled != nil || time.Since(evEnd) > time.Minute || evEnd.After(time.Now()) {
		t.Fatalf("running meeting ends now: %v %v %v", evEnd, cancelled, err)
	}
	var revoked bool
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT revoked_at IS NOT NULL FROM room_invites WHERE code = $1", priv.GetInviteCode()).Scan(&revoked); err != nil || !revoked {
		t.Fatalf("links revoked: %v %v", revoked, err)
	}
	// The archive list: MANAGE_ROOM only, with the message count; rooms the caller sees only —
	// the owner does not see this private one (ADR-0078), carol does once she holds MANAGE_ROOM.
	var arch v1.ListRoomsResponse
	o.must(200, "GET", "/api/workspaces/"+wid+"/rooms?archived=1", nil, &arch)
	if len(arch.GetRooms()) != 0 {
		t.Fatalf("the owner's archive lists the private temp room: %v", arch.GetRooms())
	}
	rooms := newRole(t, o, wid, "rooms", perm.ManageRoom)
	if st, _ := setMemberRoles(o, wid, carol.id, rooms.GetId()); st != 200 {
		t.Fatalf("assign rooms: %d", st)
	}
	carol.must(200, "GET", "/api/workspaces/"+wid+"/rooms?archived=1", nil, &arch)
	if len(arch.GetRooms()) != 1 || arch.GetRooms()[0].GetId() != rp.GetId() || arch.GetRooms()[0].GetMessageCount() != 2 ||
		arch.GetRooms()[0].GetArchivedAt() == nil || arch.GetRooms()[0].GetCreatedBy() != bob.id {
		t.Fatalf("archive: %v", arch.GetRooms())
	}
	apiErrOf(t, bob.client, 403, "GET", "/api/workspaces/"+wid+"/rooms?archived=1", nil)

	// The sweeper archives an expired room (links revoked, LiveKit room closed, ROOM_DELETE).
	sqlExec(t, "UPDATE rooms SET expires_at = now() - interval '1 second' WHERE id = $1", pr.GetId())
	if _, err := testApp.Rooms.SweepTempRooms(context.Background()); err != nil {
		t.Fatal(err)
	}
	g.wait("ROOM_DELETE of the expired temp room", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == pr.GetId() })
	lk := voice.RoomName(uuid.MustParse(wid), uuid.MustParse(pr.GetId()))
	for i := 0; !lkRec.wasDeleted(lk); i++ {
		if i > 50 {
			t.Fatal("the LiveKit room of an expired temp room is deleted")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT revoked_at IS NOT NULL FROM room_invites WHERE code = $1", pub.GetInviteCode()).Scan(&revoked); err != nil || !revoked {
		t.Fatalf("expired room's links revoked: %v %v", revoked, err)
	}
	apiErrOf(t, carol.client, 410, "POST", "/api/rooms/"+pr.GetId()+"/messages", &v1.CreateMessageRequest{Content: "x"})

	// Retention: archived temp rooms older than TEMP_ROOM_RETENTION_DAYS go with their history.
	sqlExec(t, "UPDATE rooms SET archived_at = now() - interval '91 days' WHERE id = $1", rp.GetId())
	if _, err := testApp.Rooms.PurgeTempRooms(context.Background(), time.Now().Add(-90*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	var left int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM rooms WHERE id = ANY($1::uuid[])", []string{rp.GetId(), pr.GetId()}).Scan(&left); err != nil || left != 1 {
		t.Fatalf("purge removes only the old archive: %d %v", left, err)
	}
	apiErrOf(t, carol.client, 404, "GET", up+"/messages", nil)

	// Bots: CREATE_TEMP_ROOMS through their roles, members-only link, no meeting.
	b := createBot(t, o, wid, "tempbot")
	var br v1.TempRoomResponse
	b.must(201, "POST", base, &v1.CreateTempRoomRequest{Name: "bot", TtlSeconds: 900, Guests: noGuests()}, &br)
	if r, _ := errReason(b.client); r != "" {
		t.Fatal(r)
	}
	if st := b.do("POST", base, &v1.CreateTempRoomRequest{Name: "bot", TtlSeconds: 900}, nil); st != 403 {
		t.Fatalf("bot guest link: %d", st)
	}
	if r, _ := errReason(b.client); r != "BOT_NOT_ALLOWED" {
		t.Fatalf("bot guest link reason %q", r)
	}
	b.must(200, "PATCH", "/api/rooms/"+br.GetRoom().GetId(), &v1.UpdateRoomRequest{ExpiresAt: timestamppb.New(time.Now().Add(time.Hour))}, &ur)
	b.must(204, "DELETE", "/api/rooms/"+br.GetRoom().GetId(), nil, nil)
}

// Extending a temporary room moves its meeting that ended with it; a meeting edited to another
// time stays (#46).
func TestTempRoomExtendFollowsMeeting(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	end := func(id string) time.Time {
		t.Helper()
		var e time.Time
		if err := testDB.Pool.QueryRow(context.Background(), "SELECT ends_at FROM events WHERE id = $1", id).Scan(&e); err != nil {
			t.Fatal(err)
		}
		return e
	}
	follow := tempRoom(t, o, wid, &v1.CreateTempRoomRequest{Name: "follow", TtlSeconds: 3600, WithEvent: true})
	edited := tempRoom(t, o, wid, &v1.CreateTempRoomRequest{Name: "edited", TtlSeconds: 3600, WithEvent: true})
	manual := edited.GetEvent().GetEndsAt().AsTime().Add(-10 * time.Minute)
	sqlExec(t, "UPDATE events SET ends_at = $1 WHERE id = $2", manual, edited.GetEvent().GetId())

	newEnd := time.Now().Add(3 * time.Hour).Truncate(time.Second)
	var ur v1.UpdateRoomResponse
	o.must(200, "PATCH", "/api/rooms/"+follow.GetRoom().GetId(), &v1.UpdateRoomRequest{ExpiresAt: timestamppb.New(newEnd)}, &ur)
	o.must(200, "PATCH", "/api/rooms/"+edited.GetRoom().GetId(), &v1.UpdateRoomRequest{ExpiresAt: timestamppb.New(newEnd)}, &ur)

	if got := end(follow.GetEvent().GetId()); !got.Equal(newEnd) {
		t.Fatalf("meeting end %v, want %v", got, newEnd)
	}
	if got := end(edited.GetEvent().GetId()); !got.Equal(manual.Truncate(time.Microsecond)) {
		t.Fatalf("hand-edited meeting moved to %v, want %v", got, manual)
	}
}
