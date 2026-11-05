package rtc

import (
	"slices"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/voice"
)

// The companion (ADR-0149 §3) subscribes and sends data, never publishes a source, whatever the
// device may publish; without VIEW_ROOM & CONNECT it gets nothing.
func TestCompanionGrant(t *testing.T) {
	all := perm.ViewRoom | perm.Connect | perm.Speak | perm.Stream | perm.Video | perm.MuteMembers | perm.Administrator
	for _, bits := range []perm.Bits{perm.ViewRoom | perm.Connect, all} {
		g := CompanionGrant(bits)
		if !g.CanSubscribe || !g.CanPublishData || g.CanPublish || g.CanPublishSources == nil || len(g.CanPublishSources) != 0 {
			t.Fatalf("bits %v: %+v", bits, g)
		}
	}
	for _, bits := range []perm.Bits{0, perm.ViewRoom, perm.Connect | perm.Speak | perm.Stream | perm.Video} {
		if g := CompanionGrant(bits); g.CanSubscribe || g.CanPublishData || g.CanPublish || len(g.CanPublishSources) != 0 {
			t.Fatalf("bits %v granted: %+v", bits, g)
		}
	}
}

// The companion's token: its own identity, subscribe + data, no publish and no sources (LiveKit
// reads an absent source list with canPublish=false as nothing to publish), not hidden.
func TestCompanionToken(t *testing.T) {
	u, s := uuid.New(), uuid.New()
	identity := voice.CompanionIdentity(u, s)
	all := perm.ViewRoom | perm.Connect | perm.Speak | perm.Stream | perm.Video
	tok, err := JoinToken("key", "secret", "room1", identity, "Ann", CompanionGrant(all), TokenTTL)
	if err != nil {
		t.Fatal(err)
	}
	var c lkClaims
	if _, err := jwt.ParseWithClaims(tok, &c, func(*jwt.Token) (any, error) { return []byte("secret"), nil }); err != nil {
		t.Fatal(err)
	}
	v := c.Video
	if c.Subject != identity || !v.RoomJoin || v.Room != "room1" || v.RoomAdmin || !*v.CanSubscribe || !*v.CanPublishData ||
		*v.CanPublish || len(v.CanPublishSources) != 0 {
		t.Fatalf("claims: %+v video %+v", c, v)
	}
	if ttl := time.Until(c.ExpiresAt.Time); ttl < 9*time.Minute || ttl > 10*time.Minute {
		t.Fatalf("ttl %v, want 10 min", ttl)
	}
	var raw jwt.MapClaims
	if _, err := jwt.ParseWithClaims(tok, &raw, func(*jwt.Token) (any, error) { return []byte("secret"), nil }); err != nil {
		t.Fatal(err)
	}
	video, _ := raw["video"].(map[string]any)
	for _, k := range []string{"hidden", "canPublishSources", "roomAdmin", "recorder"} {
		if _, ok := video[k]; ok {
			t.Errorf("companion token carries %q: %v", k, video)
		}
	}
}

// Removing a device removes its companion; companions and phone lines are removed as given.
func TestWithCompanions(t *testing.T) {
	u, s := uuid.New(), uuid.New()
	dev, comp := voice.Identity(u, s), voice.CompanionIdentity(u, s)
	if got := withCompanions([]string{dev}); !slices.Equal(got, []string{dev, comp}) {
		t.Fatalf("device: %v", got)
	}
	in := []string{comp, SIPIdentity(uuid.New())}
	if got := withCompanions(in); !slices.Equal(got, in) {
		t.Fatalf("non-devices: %v", got)
	}
	if got := withCompanions(nil); len(got) != 0 {
		t.Fatalf("nil: %v", got)
	}
}
