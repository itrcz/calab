//go:build integration

package app_test

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func wsAdmissions(r *v1.Ready, wid string) []*v1.RoomAdmission {
	for _, w := range r.GetWorkspaces() {
		if w.GetWorkspace().GetId() == wid {
			return w.GetAdmissions()
		}
	}
	return nil
}

// Who a knock reaches (ADR-0040 §3, amendment 2026-10-06; gateway/knock.go): the author of the
// link and the deciders in the room's voice — on the gateway and in READY. An administrator
// (INVITE_GUESTS everywhere) outside the room's voice gets nothing until he joins it; a plain
// member never; the decision still reaches every decider so a held row clears.
func TestGuestAdmissionKnockAudience(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid, wid := room.GetId(), ws.GetId()
	setGuestApproval(t, o, rid, true)
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+bob.id, &v1.UpdateMemberRequest{Role: &admin}, nil)
	dave := register(t, invite(t, o, wid))
	og, bg, dg := dialGW(t), dialGW(t), dialGW(t)
	defer func() { _ = og.ws.CloseNow(); _ = bg.ws.CloseNow(); _ = dg.ws.CloseNow() }()
	og.identify(o.token)
	bg.identify(bob.token)
	dg.identify(dave.token)
	knockOf := func(id string) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			return e.GetRoomAdmissionRequest().GetAdmission().GetUser().GetId() == id
		}
	}
	anyKnock := func(e *v1.DispatchEvent) bool { return e.GetRoomAdmissionRequest() != nil }

	// The owner authors the link: the first knock reaches the owner alone.
	inv := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	g1, _ := anonGuest(t, inv.GetCode(), "Гость 1")
	og.wait("ROOM_ADMISSION_REQUEST for the link's author", knockOf(g1.id))
	bg.quiet("knock for an administrator outside the room's voice", 300*time.Millisecond, anyKnock)
	dg.quiet("knock for a plain member", 300*time.Millisecond, anyKnock)
	if n := len(wsAdmissions(dialGW(t).identify(bob.token), wid)); n != 0 {
		t.Fatalf("READY of an administrator outside the voice lists %d knocks, want 0", n)
	}
	if n := len(wsAdmissions(dialGW(t).identify(o.token), wid)); n != 1 {
		t.Fatalf("READY of the author lists %d knocks, want 1", n)
	}
}

// The second half of the rule needs a voice (dev LiveKit): a decider in the room's voice gets the
// knock on the gateway and in READY; the decision reaches him too.
func TestGuestAdmissionKnockAudienceInVoice(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid, wid := room.GetId(), ws.GetId()
	setGuestApproval(t, o, rid, true)
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+bob.id, &v1.UpdateMemberRequest{Role: &admin}, nil)
	dave := register(t, invite(t, o, wid))
	og, bg, dg := dialGW(t), dialGW(t), dialGW(t)
	defer func() { _ = og.ws.CloseNow(); _ = bg.ws.CloseNow(); _ = dg.ws.CloseNow() }()
	og.identify(o.token)
	bg.identify(bob.token)
	dg.identify(dave.token)
	knockOf := func(id string) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			return e.GetRoomAdmissionRequest().GetAdmission().GetUser().GetId() == id
		}
	}
	anyKnock := func(e *v1.DispatchEvent) bool { return e.GetRoomAdmissionRequest() != nil }
	inv := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	g1, _ := anonGuest(t, inv.GetCode(), "Гость 1")
	og.wait("ROOM_ADMISSION_REQUEST for the link's author", knockOf(g1.id))
	bg.quiet("knock for an administrator outside the room's voice", 300*time.Millisecond, anyKnock)

	// The administrator joins the room's voice: the next knock reaches him, and READY lists both.
	joinVoice(t, bob, wid, rid)
	bg.wait("own VOICE_STATE_UPDATE", func(e *v1.DispatchEvent) bool {
		return e.GetVoiceStateUpdate().GetState().GetUserId() == bob.id && e.GetVoiceStateUpdate().GetState().GetRoomId() == rid
	})
	inv2 := roomLink(t, o, rid, &v1.CreateRoomInviteRequest{})
	g2, _ := anonGuest(t, inv2.GetCode(), "Гость 2")
	bg.wait("ROOM_ADMISSION_REQUEST for a decider in the room's voice", knockOf(g2.id))
	og.wait("ROOM_ADMISSION_REQUEST for the author", knockOf(g2.id))
	dg.quiet("knock for a plain member", 300*time.Millisecond, anyKnock)
	bg = dialGW(t) // replaces the administrator's session: READY again, in the voice
	if n := len(wsAdmissions(bg.identify(bob.token), wid)); n != 2 {
		t.Fatalf("READY of a decider in the voice lists %d knocks, want 2", n)
	}
	if n := len(wsAdmissions(dialGW(t).identify(dave.token), wid)); n != 0 {
		t.Fatalf("READY of a plain member lists %d knocks, want 0", n)
	}

	// The owner admits the first guest: the decision reaches the administrator (his row clears).
	o.must(200, "POST", "/api/rooms/"+rid+"/admissions/"+g1.id, &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED}, nil)
	decided(bg, rid, g1.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED)
}
