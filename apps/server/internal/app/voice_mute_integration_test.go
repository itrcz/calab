//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestVoiceMuteStored (ADR-0168, CBF-180): the user's own mic / sound choice is stored with the
// server's time, read back in Me.settings, kept by a `settings` replace (PTT and the rest are
// replaced, the choice is not), per user, refused for bots.
func TestVoiceMuteStored(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)

	var gm v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &gm)
	if vm := gm.GetMe().GetSettings().GetVoiceMute(); vm != nil {
		t.Fatalf("never chosen: %v", vm)
	}
	var first v1.VoiceMute
	bob.must(200, "PUT", "/api/me/voice-mute", &v1.VoiceMute{Muted: true}, &first)
	if !first.GetMuted() || first.GetDeafened() || first.GetUpdatedAt() == nil {
		t.Fatalf("stored: %v", &first)
	}
	var second v1.VoiceMute
	bob.must(200, "PUT", "/api/me/voice-mute", &v1.VoiceMute{Muted: false, Deafened: true}, &second)
	if second.GetMuted() || !second.GetDeafened() || second.GetUpdatedAt().AsTime().Before(first.GetUpdatedAt().AsTime()) {
		t.Fatalf("second write: %v after %v", &second, &first)
	}

	var mr v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_PUSH_TO_TALK}}, &mr)
	if vm := mr.GetMe().GetSettings().GetVoiceMute(); vm == nil || !vm.GetDeafened() || vm.GetMuted() {
		t.Fatalf("a settings replace changed voice_mute: %v", vm)
	}
	bob.must(200, "GET", "/api/me", nil, &gm)
	if vm := gm.GetMe().GetSettings().GetVoiceMute(); vm == nil || !vm.GetDeafened() {
		t.Fatalf("GET /api/me voice_mute: %v", vm)
	}
	var om v1.GetMeResponse
	o.must(200, "GET", "/api/me", nil, &om)
	if vm := om.GetMe().GetSettings().GetVoiceMute(); vm != nil {
		t.Fatalf("another user's voice_mute: %v", vm)
	}

	bt := createBot(t, o, ws.GetId(), "mutebot")
	bt.must(403, "PUT", "/api/me/voice-mute", &v1.VoiceMute{Muted: true}, nil)
}

// TestVoiceMuteAtJoin: /join answers with the stored choice, so the device publishes its mic in
// that state from the start; never chosen = unset.
func TestVoiceMuteAtJoin(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, _ := setupTeam(t)
	room := voiceRoom(t, o, ws.GetId(), "mute", 0)

	var j v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+room+"/join", nil, &j)
	if j.GetSelfMute() != nil {
		t.Fatalf("never chosen: %v", j.GetSelfMute())
	}
	bob.must(200, "PUT", "/api/me/voice-mute", &v1.VoiceMute{Muted: true}, nil)
	bob.must(200, "POST", "/api/rooms/"+room+"/join", nil, &j)
	if vm := j.GetSelfMute(); vm == nil || !vm.GetMuted() || vm.GetDeafened() || vm.GetUpdatedAt() == nil {
		t.Fatalf("join self_mute: %v", vm)
	}
}
