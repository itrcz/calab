//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// POST /api/rooms/{id}/voice/companion (ADR-0149 §3): a token for the device's companion only
// while this session holds a seat in the room; it never creates or changes the seat.
func TestVoiceCompanionEndpoint(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	path := "/api/rooms/" + rid + "/voice/companion"

	o.must(409, "POST", path, nil, nil) // no seat yet
	var j v1.JoinVoiceResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j) // pending
	var c v1.VoiceCompanionResponse
	o.must(200, "POST", path, nil, &c)
	if c.GetIdentity() != j.GetIdentity()+":web" || c.GetToken() == "" || c.GetUrl() != j.GetUrl() {
		t.Fatalf("companion %v for device %q", &c, j.GetIdentity())
	}
	bob.must(409, "POST", path, nil, nil) // another user's seat is not bob's

	// Another room of the workspace: the seat is in the first one.
	other := voiceRoom(t, o, ws.GetId(), "other", 0)
	o.must(409, "POST", "/api/rooms/"+other+"/voice/companion", nil, nil)

	// A text room has no voice.
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "text"}, &cr)
	o.must(422, "POST", "/api/rooms/"+cr.GetRoom().GetId()+"/voice/companion", nil, nil)

	// After the leave the seat is gone, and so is the companion's token.
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/leave", nil, nil)
	o.must(409, "POST", path, nil, nil)
}
