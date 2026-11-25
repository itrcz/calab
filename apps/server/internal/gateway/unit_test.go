package gateway

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// HELLO advertises RECORDING_SPEECH only while the hub takes the reports (RECORDING_SPEAKER_NAMES,
// ADR-0169): clients send it only then.
func TestHelloCapabilities(t *testing.T) {
	h := &Hub{}
	if c := h.capabilities(); c != 0 {
		t.Fatalf("no recorder: capabilities %d", c)
	}
	h.RecordingSpeech = func(context.Context, uuid.UUID, *v1.RecordingSpeech, time.Time) {}
	if c := h.capabilities(); c != uint64(v1.ServerCapability_SERVER_CAPABILITY_RECORDING_SPEECH) {
		t.Fatalf("with the recorder: capabilities %d", c)
	}
}

// 4010 carries the revocation reason for clients (gateway.proto); junk stays out.
func TestRevokedCloseReason(t *testing.T) {
	for in, want := range map[string]string{
		"":                                     "session revoked",
		"REUSE":                                "session revoked: REUSE",
		"LOGOUT_ALL":                           "session revoked: LOGOUT_ALL",
		"1":                                    "session revoked",
		"reuse\n<x>":                           "session revoked",
		"A_VERY_LONG_REASON_THAT_DOES_NOT_FIT": "session revoked",
	} {
		if got := revokedCloseReason(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestEntryRoundTripAndSince(t *testing.T) {
	var es []entry
	for i := uint64(5); i <= 9; i++ {
		e := entry{id: uuid.New(), seq: i, frame: []byte{byte(i), ':', 0}}
		d, err := decodeEntry(e.encode())
		if err != nil || d.id != e.id || d.seq != e.seq || !bytes.Equal(d.frame, e.frame) {
			t.Fatalf("round trip: %+v %v", d, err)
		}
		es = append(es, d)
	}
	if out, ok := since(es, 6, 9); !ok || len(out) != 3 || out[0].seq != 7 {
		t.Fatalf("since 6: %v %v", ok, out)
	}
	if out, ok := since(es, 9, 9); !ok || len(out) != 0 {
		t.Fatal("up to date client")
	}
	if _, ok := since(es, 4, 9); !ok {
		t.Fatal("seq just before the first buffered entry is resumable")
	}
	if _, ok := since(es, 2, 9); ok {
		t.Fatal("trimmed history must not be resumable")
	}
	if _, ok := since(es, 10, 9); ok {
		t.Fatal("seq from the future must not be resumable")
	}
	if _, ok := since(nil, 3, 3); !ok {
		t.Fatal("no events since last seq: resumable")
	}
}

func TestAggregateStatus(t *testing.T) {
	on, idle, dnd, inv := v1.PresenceStatus_PRESENCE_STATUS_ONLINE, v1.PresenceStatus_PRESENCE_STATUS_IDLE,
		v1.PresenceStatus_PRESENCE_STATUS_DND, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE
	off := v1.PresenceStatus_PRESENCE_STATUS_OFFLINE
	for _, c := range []struct {
		in   []v1.PresenceStatus
		want v1.PresenceStatus
	}{
		{nil, off}, {[]v1.PresenceStatus{inv}, off},
		{[]v1.PresenceStatus{idle, inv}, off}, // AFK on one device does not reveal a manual invisible
		{[]v1.PresenceStatus{on, inv}, off},
		{[]v1.PresenceStatus{idle, dnd}, dnd}, // nor override a manual dnd
		{[]v1.PresenceStatus{idle, on}, on}, {[]v1.PresenceStatus{on, dnd, idle, inv}, dnd}, {[]v1.PresenceStatus{idle}, idle},
	} {
		if got := AggregateStatus(c.in); got != c.want {
			t.Errorf("%v: got %v want %v", c.in, got, c.want)
		}
	}
}

func TestManualAggregate(t *testing.T) {
	on, idle, dnd, inv := v1.PresenceStatus_PRESENCE_STATUS_ONLINE, v1.PresenceStatus_PRESENCE_STATUS_IDLE,
		v1.PresenceStatus_PRESENCE_STATUS_DND, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE
	off := v1.PresenceStatus_PRESENCE_STATUS_OFFLINE
	now := time.UnixMilli(1_000_000)
	later := now.Add(time.Hour)
	for _, c := range []struct {
		sessions []v1.PresenceStatus
		m        manualStatus
		want     v1.PresenceStatus
		until    bool
	}{
		{nil, manualStatus{dnd, later}, off, false},                      // no live session
		{[]v1.PresenceStatus{on}, manualStatus{idle, later}, idle, true}, // manual idle beats online
		{[]v1.PresenceStatus{idle}, manualStatus{dnd, time.Time{}}, dnd, false},
		{[]v1.PresenceStatus{on}, manualStatus{inv, later}, off, false},  // invisible: no until
		{[]v1.PresenceStatus{idle}, manualStatus{dnd, now}, idle, false}, // ended: sessions decide
		{[]v1.PresenceStatus{on}, manualStatus{}, on, false},
	} {
		st, until := Aggregate(c.sessions, c.m, now)
		if st != c.want || until.IsZero() == c.until {
			t.Errorf("%v %+v: got %v %v", c.sessions, c.m, st, until)
		}
	}
	for _, m := range []manualStatus{{dnd, later}, {inv, time.Time{}}} {
		if got := decodeManual(m.encode()); got.status != m.status || !got.until.Equal(m.until) {
			t.Errorf("round trip %+v: %+v", m, got)
		}
	}
	if decodeManual("1:0").status != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED || decodeManual("x").status != 0 {
		t.Error("online / garbage must decode as none")
	}
}

func TestCodec(t *testing.T) {
	f := frame(&v1.GatewayFrame{Seq: 3, Payload: &v1.GatewayFrame_Dispatch{Dispatch: &v1.DispatchEvent{
		Event: &v1.DispatchEvent_TypingStart{TypingStart: &v1.TypingStart{RoomId: "r", UserId: "u"}}}}})
	if f.GetOp() != v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH {
		t.Fatal("opcode not derived")
	}
	for _, c := range []codec{{}, {json: true}} {
		typ, b, err := c.encode(f)
		if err != nil {
			t.Fatal(err)
		}
		if c.json != (typ == websocket.MessageText) {
			t.Fatal("wrong message type")
		}
		g, err := c.decode(typ, b)
		if err != nil || g.GetSeq() != 3 || g.GetDispatch().GetTypingStart().GetRoomId() != "r" {
			t.Fatalf("decode: %v %v", g, err)
		}
	}
	_, bb, _ := codec{}.encode(f)
	typ, js, err := codec{json: true}.transcode(bb)
	if err != nil || typ != websocket.MessageText || !bytes.Contains(js, []byte(`"GATEWAY_OPCODE_DISPATCH"`)) {
		t.Fatalf("transcode: %s %v", js, err)
	}
}

func TestVisibilityTransitions(t *testing.T) {
	wid, rid, alice, bob := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room := &v1.Room{Id: rid.String()}
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember]},
		"guest":  {ID: "guest", Position: perm.PosGuest, Permissions: perm.RoleDefaults[perm.RoleGuest]},
	}}
	st.setMember(alice, perm.RoleMember, []string{"member"})
	st.setMember(bob, perm.RoleGuest, []string{"guest"})
	st.setRoom(rid, room)
	if !st.canView(rid, alice) || st.canView(rid, bob) {
		t.Fatal("defaults: member sees, guest does not")
	}
	private := []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: uint64(perm.ViewRoom)},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.String(), Allow: uint64(perm.ViewRoom)},
	}
	st.setRoom(rid, withPermissions(room, private))
	if st.canView(rid, alice) || !st.canView(rid, bob) {
		t.Fatal("private room: alice hidden, bob allowed")
	}
	// Guests see only members sharing a room with them (M7).
	carol := uuid.New()
	st.setMember(carol, perm.RoleMember, []string{"member"})
	if st.hiddenFrom(alice, bob) || !st.hiddenFrom(bob, alice) || !st.hiddenFrom(bob, carol) || st.hiddenFrom(bob, bob) {
		t.Fatal("guest visibility")
	}
	other := uuid.New()
	guestIn := []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.String(), Allow: uint64(perm.ViewRoom)},
	}
	st.setRoom(other, &v1.Room{Id: other.String(), PermissionOverrides: guestIn})
	// A room open to every member does not open the directory to its guest (owner report
	// 02.10): carol can view it, but is not one of its people.
	if !st.hiddenFrom(bob, carol) {
		t.Fatal("guest sees a member who merely can view the guest's public room")
	}
	// Its people: invited by name, its creator, whoever is in its call, its authors.
	st.setRoom(other, &v1.Room{Id: other.String(), PermissionOverrides: append(guestIn,
		&v1.RoomPermissionOverride{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: carol.String(), Allow: uint64(perm.Speak)})})
	if st.hiddenFrom(bob, carol) {
		t.Fatal("guest must see a member invited into its room")
	}
	st.setRoom(other, &v1.Room{Id: other.String(), PermissionOverrides: guestIn, CreatedBy: carol.String()})
	if st.hiddenFrom(bob, carol) {
		t.Fatal("guest must see the creator of its room")
	}
	st.setRoom(other, &v1.Room{Id: other.String(), PermissionOverrides: guestIn})
	if !st.setVoice(carol, other) || st.setVoice(carol, other) || st.hiddenFrom(bob, carol) {
		t.Fatal("guest must see a member in its call")
	}
	if !st.setVoice(carol, uuid.New()) || !st.hiddenFrom(bob, carol) || !st.setVoice(carol, uuid.Nil) {
		t.Fatal("a member who left the guest's call is hidden again")
	}
	if ev := (&v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{Message: &v1.Message{
		RoomId: other.String(), AuthorId: carol.String()}}}}); !changesVisibility(st, ev) {
		t.Fatal("a new author is a visibility change")
	}
	st.addAuthor(other, carol)
	if st.hiddenFrom(bob, carol) {
		t.Fatal("guest must see an author of its room")
	}
	// B2: the cached set is invalidated by role and override changes.
	st.setMember(carol, perm.RoleGuest, []string{"guest"})
	st.delRoom(other)
	if !st.hiddenFrom(bob, carol) {
		t.Fatal("stale guest cache after a room deletion")
	}
	st.setRoom(other, &v1.Room{Id: other.String(), PermissionOverrides: append(guestIn,
		&v1.RoomPermissionOverride{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: carol.String(), Allow: uint64(perm.ViewRoom)})})
	if st.hiddenFrom(bob, carol) {
		t.Fatal("two guests of one room see each other")
	}
	st.setMember(carol, perm.RoleMember, []string{"member"})
	st.setRoom(other, &v1.Room{Id: other.String()})
	if !st.hiddenFrom(bob, carol) {
		t.Fatal("stale guest cache after an override change")
	}
	// ADR-0026: a custom role allowed into the private room; its permissions / deletion
	// change what its holders see.
	st.setRoleDef(&v1.Role{Id: "mod", Position: 2})
	st.setRoom(rid, withPermissions(room, append(private, &v1.RoomPermissionOverride{
		TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "mod", Allow: uint64(perm.ViewRoom),
	})))
	if st.canView(rid, alice) {
		t.Fatal("alice without the role")
	}
	st.setMember(alice, perm.RoleMember, []string{"member", "mod"})
	if !st.canView(rid, alice) {
		t.Fatal("alice with the allowed role")
	}
	st.delRoleDef("mod")
	if st.canView(rid, alice) || len(st.roleIDs[alice]) != 1 {
		t.Fatal("deleted role still counts")
	}
	st.setRoleDef(&v1.Role{Id: "member", Position: perm.PosMember, Permissions: uint64(perm.RoleDefaults[perm.RoleMember] &^ perm.ViewRoom)})
	if st.canView(other, carol) {
		t.Fatal("member role without VIEW_ROOM: rebuilt holders must lose the room")
	}
	st.setRoleDef(&v1.Role{Id: "member", Position: perm.PosMember, Permissions: uint64(perm.RoleDefaults[perm.RoleMember])})
	st.setRoom(rid, withPermissions(room, private))
	renamed := proto.Clone(st.rooms[rid]).(*v1.Room)
	renamed.Name = "renamed"
	if !st.sameVisibility(rid, renamed) {
		t.Fatal("rename must not trigger guest recomputation")
	}
	if ev := (&v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: renamed}}}); changesVisibility(st, ev) {
		t.Fatal("rename classified as a visibility change")
	}
	moved := proto.Clone(renamed).(*v1.Room)
	moved.CategoryId = uuid.NewString()
	if st.sameVisibility(rid, moved) || st.sameVisibility(rid, room) || st.sameVisibility(uuid.New(), renamed) {
		t.Fatal("category / override change or unknown room must count as a visibility change")
	}
	upd := &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: room}}}
	if ev := transition(true, true, upd, room, wid, rid); ev != upd {
		t.Fatal("still visible: pass through")
	}
	if ev := transition(false, true, upd, room, wid, rid); ev.GetRoomCreate() == nil {
		t.Fatal("gained: ROOM_CREATE")
	}
	if ev := transition(true, false, upd, room, wid, rid); ev.GetRoomDelete().GetRoomId() != rid.String() {
		t.Fatal("lost: ROOM_DELETE")
	}
	if transition(false, false, upd, room, wid, rid) != nil {
		t.Fatal("never visible: nothing")
	}
	vs := &v1.VoiceState{UserId: "u", RoomId: rid.String(), Muted: true}
	if got := sanitizeVoice(vs, func(uuid.UUID) bool { return false }); got.GetRoomId() != "" || got.GetMuted() {
		t.Fatal("hidden room leaked in voice state")
	}
	if got := sanitizeVoice(vs, func(uuid.UUID) bool { return true }); got != vs {
		t.Fatal("visible voice state changed")
	}
}

func TestOriginAllowed(t *testing.T) {
	allowed := []string{"https://app.example.com", "https://app.example.ru"}
	for origin, want := range map[string]bool{
		"":                         true,
		"null":                     true,
		"file://":                  true,
		"http://localhost:5173":    true,
		"http://127.0.0.1:3000":    true,
		"https://app.example.com":  true,
		"https://APP.example.ru":   true,
		"https://evil.example.com": false,
		"http://app.example.com":   false,
		"https://localhost":        false,
		"http://localhost.evil.io": false,
		"::bad::":                  false,
	} {
		if got := OriginAllowed(origin, false, allowed); got != want {
			t.Errorf("%q: got %v want %v", origin, got, want)
		}
	}
	for origin, want := range map[string]bool{"null": false, "file://": false, "https://app.example.com": true, "": true} {
		if got := OriginAllowed(origin, true, allowed); got != want {
			t.Errorf("%q with cookie: got %v want %v", origin, got, want)
		}
	}
}

// Every DispatchEvent variant must be classified explicitly (gateway/identity.go eventScope):
// a new oneof field (e.g. new board events) fails here until someone decides its scope.
func TestEventScopeClassified(t *testing.T) {
	fields := (&v1.DispatchEvent{}).ProtoReflect().Descriptor().Oneofs().ByName("event").Fields()
	seen := map[protoreflect.Name]bool{}
	for i := 0; i < fields.Len(); i++ {
		f := fields.Get(i)
		seen[f.Name()] = true
		if _, ok := eventScope[f.Name()]; !ok {
			t.Errorf("DispatchEvent.%s (%d) is not classified in eventScope", f.Name(), f.Number())
		}
	}
	for name := range eventScope {
		if !seen[name] {
			t.Errorf("eventScope lists %q, which is not a DispatchEvent variant", name)
		}
	}
	// The explicit list keeps the 2.0 wire classification of fields 1..86 (2..85 minus the
	// unscoped variants); later fields are classified only by the list.
	for i := 0; i < fields.Len(); i++ {
		n := fields.Get(i).Number()
		if n > 86 {
			continue
		}
		old := n >= 2 && n <= 85 && n != 22 && n != 31 && n != 39 && n != 46 && n != 47 && (n < 57 || n > 59) && (n < 72 || n > 74) && n != 82
		if eventScope[fields.Get(i).Name()] != old {
			t.Errorf("DispatchEvent field %d changed scope classification", n)
		}
	}
	if knownScopedEvent(&v1.DispatchEvent{}) {
		t.Error("an absent variant must deny")
	}
}

func TestValidTabID(t *testing.T) {
	long := strings.Repeat("a", maxTabIDLen)
	for in, want := range map[string]string{
		"":                      "",
		"tab-1_X":               "tab-1_X",
		long:                    long,
		long + "a":              "",
		"a|b":                   "", // the member separator of gw:tabs
		"a b":                   "",
		"таб":                   "",
		"0f8c7d2e-1b2a-4c3d-9e": "0f8c7d2e-1b2a-4c3d-9e",
	} {
		if got := validTabID(in); got != want {
			t.Errorf("validTabID(%q) = %q, want %q", in, got, want)
		}
	}
	if c, why := killClose(true); c != 4011 || why == "" {
		t.Errorf("evicted close: %d %q", c, why)
	}
	if c, why := killClose(false); c != 4000 || why != "replaced by a new session" {
		t.Errorf("replaced close: %d %q (bots rely on the reason, docs/19)", c, why)
	}
}
