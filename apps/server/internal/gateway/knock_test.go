package gateway

import (
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Who a knock reaches (ADR-0040 §3 amendment): the link's author, and INVITE_GUESTS in the room
// only while in its voice; never a guest, a plain member or a decider elsewhere.
func TestKnockAudience(t *testing.T) {
	rid, other := uuid.New(), uuid.New()
	author, admin, member, guest := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	st := &wsState{rooms: map[uuid.UUID]*v1.Room{}, roleDefs: perm.Roles{
		"admin":  {ID: "admin", Position: perm.PosAdmin, Permissions: perm.RoleDefaults[perm.RoleAdmin]},
		"member": {ID: "member", Position: perm.PosMember, Permissions: perm.RoleDefaults[perm.RoleMember]},
		"guest":  {ID: "guest", Position: perm.PosGuest, Permissions: perm.RoleDefaults[perm.RoleGuest]},
	}}
	st.setMember(author, perm.RoleMember, []string{"member"})
	st.setMember(admin, perm.RoleAdmin, []string{"admin"})
	st.setMember(member, perm.RoleMember, []string{"member"})
	st.setMember(guest, perm.RoleGuest, []string{"guest"})
	st.setRoom(rid, &v1.Room{Id: rid.String()})
	st.setRoom(other, &v1.Room{Id: other.String()})
	if !st.bits(rid, admin).Has(perm.InviteGuests) || st.bits(rid, member).Has(perm.InviteGuests) {
		t.Fatal("fixture: the administrator decides, the member does not")
	}

	if !knockAudience(st, rid, author, author) {
		t.Error("the link's author, wherever they are")
	}
	if knockAudience(st, rid, author, admin) {
		t.Error("a decider outside the room's voice")
	}
	st.setVoice(admin, other)
	if knockAudience(st, rid, author, admin) {
		t.Error("a decider in another room's voice")
	}
	st.setVoice(admin, rid)
	if !knockAudience(st, rid, author, admin) {
		t.Error("a decider in the room's voice")
	}
	st.setVoice(member, rid)
	if knockAudience(st, rid, author, member) {
		t.Error("a member in the voice without INVITE_GUESTS")
	}
	st.setVoice(guest, rid)
	if knockAudience(st, rid, guest, guest) {
		t.Error("a guest, even as the link's author")
	}
	if knockAudience(st, rid, uuid.Nil, author) {
		t.Error("no author: the author's seat is nobody's")
	}
}

// READY lists only the knocks the user is asked to decide: the links they authored and the room
// they are in the voice of.
func TestNarrowKnocks(t *testing.T) {
	me, other := uuid.New(), uuid.New()
	rid, elsewhere := uuid.New(), uuid.New()
	knock := func(room, author uuid.UUID) *v1.RoomAdmission {
		return &v1.RoomAdmission{RoomId: room.String(), InviteCreatedBy: author.String(), User: &v1.User{Id: uuid.NewString()}}
	}
	snap := &v1.WorkspaceSnapshot{
		VoiceStates: []*v1.VoiceState{{UserId: other.String(), RoomId: rid.String()}},
		Admissions:  []*v1.RoomAdmission{knock(rid, other), knock(elsewhere, me), knock(elsewhere, other)},
	}
	narrowKnocks(me, []*v1.WorkspaceSnapshot{snap})
	if len(snap.Admissions) != 1 || snap.Admissions[0].GetRoomId() != elsewhere.String() {
		t.Fatalf("outside any voice: only my link's knock, got %v", snap.Admissions)
	}
	snap.Admissions = []*v1.RoomAdmission{knock(rid, other), knock(elsewhere, me), knock(elsewhere, other)}
	snap.VoiceStates = append(snap.VoiceStates, &v1.VoiceState{UserId: me.String(), RoomId: rid.String()})
	narrowKnocks(me, []*v1.WorkspaceSnapshot{snap})
	if len(snap.Admissions) != 2 || snap.Admissions[0].GetRoomId() != rid.String() || snap.Admissions[1].GetInviteCreatedBy() != me.String() {
		t.Fatalf("in the voice of rid: its knock and my link's, got %v", snap.Admissions)
	}
	empty := &v1.WorkspaceSnapshot{}
	narrowKnocks(me, []*v1.WorkspaceSnapshot{empty})
	if len(empty.Admissions) != 0 {
		t.Fatal("nothing to narrow")
	}
}
