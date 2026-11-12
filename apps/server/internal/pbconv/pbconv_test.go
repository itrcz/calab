package pbconv

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestEventForGuest(t *testing.T) {
	ev := &v1.CalendarEvent{Id: "e", Title: "Демо", Description: "Повестка", RoomId: "r", RecordingId: "rec", CanEdit: true, GuestLinks: true,
		MyStatus: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED, Counts: &v1.CalendarEventCounts{Accepted: 1, Pending: 1},
		Attendees: []*v1.CalendarEventAttendee{{UserId: "u"}, {Email: "partner@outside.org"}}}
	g := EventForGuest(ev)
	if len(g.GetAttendees()) != 0 || g.GetRecordingId() != "" || g.GetCanEdit() || g.GetGuestLinks() ||
		g.GetMyStatus() != v1.AttendeeStatus_ATTENDEE_STATUS_UNSPECIFIED {
		t.Fatalf("guest view leaks: %v", g)
	}
	if g.GetTitle() != "Демо" || g.GetDescription() != "Повестка" || g.GetCounts().GetAccepted() != 1 || g.GetRoomId() != "r" {
		t.Fatalf("guest view lost the card: %v", g)
	}
	if len(ev.GetAttendees()) != 2 || ev.GetRecordingId() != "rec" {
		t.Fatal("the original changed")
	}
	if EventForGuest(nil) != nil {
		t.Fatal("nil")
	}
}

func TestSettingsDefaults(t *testing.T) {
	for name, c := range map[string]struct {
		raw   string
		noise bool
		mode  v1.MicMode
	}{
		"empty row":           {`{}`, false, v1.MicMode_MIC_MODE_VAD},
		"nil":                 {``, false, v1.MicMode_MIC_MODE_VAD},
		"explicit false":      {`{"noiseSuppression":false,"micMode":"MIC_MODE_PUSH_TO_TALK"}`, false, v1.MicMode_MIC_MODE_PUSH_TO_TALK},
		"legacy push to talk": {`{"pushToTalk":true}`, false, v1.MicMode_MIC_MODE_PUSH_TO_TALK},
		"corrupt":             {`not json`, false, v1.MicMode_MIC_MODE_VAD},
	} {
		s := Settings([]byte(c.raw))
		if s.GetNoiseSuppression() != c.noise || s.GetMicMode() != c.mode || s.GetPushToTalk() != (c.mode == v1.MicMode_MIC_MODE_PUSH_TO_TALK) || s.AudioBitrateKbps != nil { //nolint:staticcheck // legacy field
			t.Errorf("%s: %v", name, s)
		}
	}
	// Encode keeps false explicit, so it survives a round trip.
	b, err := EncodeSettings(&v1.UserSettings{NoiseSuppression: false})
	if err != nil {
		t.Fatal(err)
	}
	if s := Settings(b); s.GetNoiseSuppression() || s.GetMicMode() != v1.MicMode_MIC_MODE_VAD {
		t.Fatalf("round trip: %s -> %v", b, s)
	}
	br := uint32(48)
	b, _ = EncodeSettings(&v1.UserSettings{AudioBitrateKbps: &br})
	if Settings(b).GetAudioBitrateKbps() != 48 {
		t.Fatal("bitrate lost")
	}
}

// ADR-0168: never chosen = unset; the stored choice lives in its own columns, not in `settings`.
func TestVoiceMute(t *testing.T) {
	if VoiceMute(true, true, nil) != nil {
		t.Fatal("never chosen must be unset")
	}
	at := time.Unix(1_700_000_000, 0)
	vm := VoiceMute(true, false, &at)
	if !vm.GetMuted() || vm.GetDeafened() || !vm.GetUpdatedAt().AsTime().Equal(at) {
		t.Fatalf("stored choice: %v", vm)
	}
	raw, err := EncodeSettings(&v1.UserSettings{VoiceMute: vm})
	if err != nil {
		t.Fatal(err)
	}
	if Settings(raw).GetVoiceMute() != nil {
		t.Fatalf("voice_mute leaked into settings: %s", raw)
	}
}
