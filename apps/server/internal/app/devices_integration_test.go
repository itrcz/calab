//go:build integration

package app_test

import (
	"fmt"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// secondDevice logs u in once more: a new auth session (device) of the same user.
func secondDevice(t *testing.T, u *user) *user {
	t.Helper()
	seq++
	c := &client{t: t, ip: fmt.Sprintf("10.9.%d.%d", seq/250, seq%250+1)} // own rate-limit bucket
	var l v1.LoginResponse
	c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: u.email, Password: "password123", DeviceName: "second"}, &l)
	c.token = l.GetTokens().GetAccessToken()
	return &user{client: c, id: u.id, refresh: l.GetTokens().GetRefreshToken(), session: l.GetTokens().GetSessionId(), email: u.email}
}

func voiceDisconnected(sessionID, roomID string) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool {
		d := e.GetVoiceDisconnected()
		return d != nil && d.GetSessionId() == sessionID && d.GetRoomId() == roomID &&
			d.GetReason() == v1.VoiceDisconnectReason_VOICE_DISCONNECT_REASON_OTHER_DEVICE
	}
}

// One device in voice at a time (owner 29.09, docs/05 «Несколько устройств»): a /join from
// the user's second device takes the first one out of voice — VOICE_DISCONNECTED{OTHER_DEVICE}
// to the user's devices, one VOICE_STATE_UPDATE for the others (the user is where the new
// device is); the first device's late LiveKit connect is refused; a repeated /join of the
// same device takes nobody out.
func TestVoiceOtherDeviceTakesOver(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	other := voiceRoom(t, o, wid, "other", 0)
	bob2 := secondDevice(t, bob)
	g1, g2, og := dialGW(t), dialGW(t), dialGW(t)
	g1.identify(bob.token)
	g2.identify(bob2.token)
	og.identify(o.token)
	bobIn := func(roomID string, pending bool) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return e.GetVoiceStateUpdate() != nil && s.GetUserId() == bob.id && s.GetRoomId() == roomID && s.GetPending() == pending
		}
	}

	// Device 1 in the room, connected.
	id1 := joinVoice(t, bob, wid, rid)
	og.wait("bob connected in the room", bobIn(rid, false))

	// Device 2 joins another room: device 1 is told and taken out; bob is in the other room.
	bob2.must(200, "POST", "/api/rooms/"+other+"/join", nil, nil)
	ev := g1.wait("VOICE_DISCONNECTED on device 1", voiceDisconnected(bob.session, rid))
	if ev.GetVoiceDisconnected().GetWorkspaceId() != wid {
		t.Fatalf("VOICE_DISCONNECTED: %v", ev)
	}
	g2.wait("VOICE_DISCONNECTED reaches the user channel", voiceDisconnected(bob.session, rid))
	og.wait("bob pending in the other room", bobIn(other, true))
	og.quiet("bob back in the old room", 300*time.Millisecond, bobIn(rid, false))

	// Device 1's LiveKit connection arriving late (or a stale token) is refused.
	webhook(t, whEvent("participant_joined", "ws_"+wid+"_room_"+rid, id1, nil), "secret")
	og.quiet("device 1 admitted again", 500*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetVoiceStateUpdate().GetState().GetUserId() == bob.id && e.GetVoiceStateUpdate().GetState().GetRoomId() == rid
	})

	// The same device again (reconnect): nobody is taken out.
	bob2.must(200, "POST", "/api/rooms/"+other+"/join", nil, nil)
	g2.quiet("VOICE_DISCONNECTED on a repeated join", 500*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetVoiceDisconnected() != nil })

	// Device 1 joins again itself: device 2 goes, device 1 is admitted.
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, nil)
	g2.wait("VOICE_DISCONNECTED on device 2", voiceDisconnected(bob2.session, other))
	webhook(t, whEvent("participant_joined", "ws_"+wid+"_room_"+rid, id1, nil), "secret")
	og.wait("bob connected in the room again", bobIn(rid, false))
}

// A one-to-one call (ADR-0034): the second device joining the call takes the first one out of
// the call's voice session, the call itself stays ACTIVE.
func TestCallOtherDeviceKeepsCall(t *testing.T) {
	liveKitUp(t)
	a, b, _, _ := callTeam(t)
	dm := openDM(t, a.user, b.id, 201).GetRoom().GetId()
	a2 := secondDevice(t, a.user)
	call := startCall(t, a.user, dm)
	callAction(t, b.user, 200, call.GetId(), "accept")
	a.g.wait("CALL_STATE active", callStateIs(call.GetId(), v1.CallState_CALL_STATE_ACTIVE))
	var j1 v1.JoinVoiceResponse
	a.must(200, "POST", "/api/rooms/"+dm+"/join", nil, &j1)
	webhook(t, whEvent("participant_joined", "dm:"+dm, j1.GetIdentity(), nil), "secret")
	b.g.wait("alice connected", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return e.GetVoiceStateUpdate() != nil && s.GetUserId() == a.id && s.GetRoomId() == dm && !s.GetPending()
	})

	a2.must(200, "POST", "/api/rooms/"+dm+"/join", nil, nil)
	ev := a.g.wait("VOICE_DISCONNECTED on device 1", voiceDisconnected(a.session, dm))
	if ev.GetVoiceDisconnected().GetWorkspaceId() != "" {
		t.Fatalf("a call's VOICE_DISCONNECTED carries a workspace: %v", ev)
	}
	// The call goes on: no end, alice still in its session (device 2), device 2 may use it.
	b.g.quiet("the call ended", time.Second, func(e *v1.DispatchEvent) bool {
		st := e.GetCallState().GetCall().GetState()
		s := e.GetVoiceStateUpdate().GetState()
		return (e.GetCallState() != nil && st != v1.CallState_CALL_STATE_ACTIVE) || (e.GetVoiceStateUpdate() != nil && s.GetUserId() == a.id && s.GetRoomId() == "")
	})
	a2.must(200, "POST", "/api/rooms/"+dm+"/stream/request", &v1.RequestStreamRequest{}, nil)
	end := callAction(t, a2, 200, call.GetId(), "hangup")
	if end.GetState() != v1.CallState_CALL_STATE_ENDED {
		t.Fatalf("hangup from device 2: %v", end)
	}
}

// A phone accepts a DM call while the same user's desktop is in a workspace room.
// The desktop yields only its room connection; its late leave cannot end the phone call.
func TestPhoneCallAnswerTakesOverDesktopRoom(t *testing.T) {
	liveKitUp(t)
	caller, desktop, _, wid := callTeam(t)
	phone := secondDevice(t, desktop.user)
	room := voiceRoom(t, owner(t), wid, "desktop room", 0)
	desktopIdentity := joinVoice(t, desktop.user, wid, room)
	dm := openDM(t, caller.user, desktop.id, 201).GetRoom().GetId()
	incoming := startCall(t, caller.user, dm)
	callAction(t, phone, 200, incoming.GetId(), "accept")
	var joined v1.JoinVoiceResponse
	phone.must(200, "POST", "/api/rooms/"+dm+"/join", nil, &joined)
	desktop.g.wait("desktop room yielded to phone", voiceDisconnected(desktop.session, room))
	webhook(t, whEvent("participant_joined", "dm:"+dm, joined.GetIdentity(), nil), "secret")
	caller.g.wait("phone connected", func(e *v1.DispatchEvent) bool {
		state := e.GetVoiceStateUpdate().GetState()
		return state.GetUserId() == phone.id && state.GetRoomId() == dm && !state.GetPending()
	})
	desktop.must(204, "POST", "/api/rooms/"+room+"/voice/leave", nil, nil)
	webhook(t, whEvent("participant_left", "ws_"+wid+"_room_"+room, desktopIdentity, nil), "secret")
	caller.g.quiet("desktop leave ended phone call", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetCallState() != nil && e.GetCallState().GetCall().GetId() == incoming.GetId() && e.GetCallState().GetCall().GetState() != v1.CallState_CALL_STATE_ACTIVE
	})
	phone.must(200, "POST", "/api/rooms/"+dm+"/stream/request", &v1.RequestStreamRequest{}, nil)
	callAction(t, phone, 200, incoming.GetId(), "hangup")
}
