//go:build integration

package app_test

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Manual status with an end (docs/05 «Presence»): per user, shared by all devices, in READY,
// invisible shown as offline, and returned to ONLINE by the sweeper when the time is up.
func TestManualPresenceUntil(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	og := dialGW(t)
	og.identify(o.token)
	email := mustEmail(t, bob)
	login := func(ip string) string {
		c := &client{t: t, ip: ip}
		var l v1.LoginResponse
		c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, &l)
		return l.GetTokens().GetAccessToken()
	}
	d1, d2 := dialGW(t), dialGW(t)
	d1.identify(bob.token)
	d2.identify(login("10.63.0.1"))
	set := func(st v1.PresenceStatus, until *timestamppb.Timestamp) {
		d1.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_PRESENCE_UPDATE,
			Payload: &v1.GatewayFrame_SetPresence{SetPresence: &v1.SetPresence{Status: st, Until: until}}})
	}
	others := func(st v1.PresenceStatus) *v1.Presence {
		t.Helper()
		return og.wait("presence "+st.String(), func(e *v1.DispatchEvent) bool {
			p := e.GetPresenceUpdate().GetPresence()
			return p.GetUserId() == bob.id && p.GetStatus() == st
		}).GetPresenceUpdate().GetPresence()
	}
	mine := func(st v1.PresenceStatus) *v1.Presence {
		t.Helper()
		return d2.wait("own presence "+st.String(), func(e *v1.DispatchEvent) bool {
			return e.GetUserUpdate().GetPresence().GetStatus() == st
		}).GetUserUpdate().GetPresence()
	}
	bobIn := func(r *v1.Ready) *v1.Presence {
		for _, w := range r.GetWorkspaces() {
			for _, p := range w.GetPresences() {
				if p.GetUserId() == bob.id {
					return p
				}
			}
		}
		t.Fatal("bob missing from READY presences")
		return nil
	}

	// DND for an hour: others see DND with until, the other device and a new READY too.
	end := time.Now().Add(time.Hour).Truncate(time.Millisecond)
	set(v1.PresenceStatus_PRESENCE_STATUS_DND, timestamppb.New(end))
	if p := others(v1.PresenceStatus_PRESENCE_STATUS_DND); !p.GetUntil().AsTime().Equal(end) {
		t.Fatalf("until to others: %v", p.GetUntil())
	}
	if p := mine(v1.PresenceStatus_PRESENCE_STATUS_DND); !p.GetUntil().AsTime().Equal(end) {
		t.Fatalf("until to own device: %v", p.GetUntil())
	}
	d3 := dialGW(t)
	if p := d3.identify(login("10.63.0.2")).GetPresence(); p.GetStatus() != v1.PresenceStatus_PRESENCE_STATUS_DND || !p.GetUntil().AsTime().Equal(end) {
		t.Fatalf("READY.presence: %v", p)
	}
	og = dialGW(t) // replaces the owner's previous connection (same device)
	if p := bobIn(og.identify(o.token)); p.GetStatus() != v1.PresenceStatus_PRESENCE_STATUS_DND || !p.GetUntil().AsTime().Equal(end) {
		t.Fatalf("READY presences: %v", p)
	}

	// Invisible: offline to others, with no until or last_seen; the owner still sees it.
	set(v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE, timestamppb.New(end))
	if p := others(v1.PresenceStatus_PRESENCE_STATUS_OFFLINE); p.GetUntil() != nil || p.GetLastSeen() != nil {
		t.Fatalf("invisible leaks: %v", p)
	}
	mine(v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE)
	og = dialGW(t)
	if p := bobIn(og.identify(o.token)); p.GetStatus() != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE || p.GetUntil() != nil {
		t.Fatalf("invisible in READY: %v", p)
	}

	// Two seconds of DND: the sweeper (every 15 s) brings bob back online on every device.
	set(v1.PresenceStatus_PRESENCE_STATUS_DND, timestamppb.New(time.Now().Add(2*time.Second)))
	others(v1.PresenceStatus_PRESENCE_STATUS_DND)
	mine(v1.PresenceStatus_PRESENCE_STATUS_DND)
	deadline := time.Now().Add(40 * time.Second)
	var back *v1.Presence
	for back == nil && time.Now().Before(deadline) {
		f, err := og.read(time.Until(deadline))
		if err != nil {
			t.Fatalf("waiting for the sweeper: %v", err)
		}
		if p := f.GetDispatch().GetPresenceUpdate().GetPresence(); p.GetUserId() == bob.id {
			if p.GetStatus() != v1.PresenceStatus_PRESENCE_STATUS_ONLINE {
				t.Fatalf("unexpected presence %v", p)
			}
			back = p
		}
	}
	if back == nil || back.GetUntil() != nil {
		t.Fatalf("not back online: %v", back)
	}
	if p := mine(v1.PresenceStatus_PRESENCE_STATUS_ONLINE); p.GetUntil() != nil {
		t.Fatalf("own presence after expiry: %v", p)
	}
	var st *int16
	var until *time.Time
	if err := testDB.Pool.QueryRow(ctx0, "SELECT presence_status, presence_until FROM users WHERE id = $1", bob.id).Scan(&st, &until); err != nil || st != nil || until != nil {
		t.Fatalf("db not cleared: %v %v %v", st, until, err)
	}

	// «Forever» (zero until) and back to online by hand.
	set(v1.PresenceStatus_PRESENCE_STATUS_IDLE, &timestamppb.Timestamp{})
	if p := others(v1.PresenceStatus_PRESENCE_STATUS_IDLE); p.GetUntil() != nil {
		t.Fatalf("forever has until: %v", p)
	}
	set(v1.PresenceStatus_PRESENCE_STATUS_ONLINE, &timestamppb.Timestamp{})
	others(v1.PresenceStatus_PRESENCE_STATUS_ONLINE)
}

// Temporary custom status (issue #17): the sweeper clears it when the time is up and tells
// everyone — PRESENCE_UPDATE with the empty status to members, USER_UPDATE {me} to the owner.
func TestCustomStatusExpiry(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	og, bg := dialGW(t), dialGW(t)
	og.identify(o.token)
	bg.identify(bob.token)
	bob.must(200, "PATCH", "/api/me/status", &v1.UpdateStatusRequest{Text: "на обеде", Emoji: "🍔", ExpiresInSeconds: 1}, nil)
	og.wait("PRESENCE_UPDATE with status", func(e *v1.DispatchEvent) bool {
		p := e.GetPresenceUpdate().GetPresence()
		return p.GetUserId() == bob.id && p.GetStatusText() == "на обеде"
	})
	bg.wait("USER_UPDATE me with status", func(e *v1.DispatchEvent) bool {
		return e.GetUserUpdate().GetMe().GetUser().GetStatusText() == "на обеде"
	})

	// The sweeper runs every 15 s: within 40 s the status is gone for the other member...
	deadline := time.Now().Add(40 * time.Second)
	var cleared *v1.Presence
	for cleared == nil && time.Now().Before(deadline) {
		f, err := og.read(time.Until(deadline))
		if err != nil {
			t.Fatalf("waiting for the sweeper: %v", err)
		}
		if p := f.GetDispatch().GetPresenceUpdate().GetPresence(); p.GetUserId() == bob.id && p.GetStatusText() == "" {
			cleared = p
		}
	}
	if cleared == nil || cleared.GetStatusEmoji() != "" || cleared.GetStatusExpiresAt() != nil {
		t.Fatalf("status not cleared for members: %v", cleared)
	}
	// ...for the owner's devices...
	bg.wait("USER_UPDATE me without status", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetMe().GetUser()
		return u != nil && u.GetStatusText() == "" && u.GetStatusEmoji() == "" && u.GetStatusExpiresAt() == nil
	})
	// ...and in the API and the row.
	var gm v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &gm)
	if u := gm.GetMe().GetUser(); u.GetStatusText() != "" || u.GetStatusEmoji() != "" || u.GetStatusExpiresAt() != nil {
		t.Fatalf("GET /api/me after expiry: %v", u)
	}
	var text, emoji string
	var exp *time.Time
	if err := testDB.Pool.QueryRow(ctx0, "SELECT status_text, status_emoji, status_expires_at FROM users WHERE id = $1", bob.id).Scan(&text, &emoji, &exp); err != nil || text != "" || emoji != "" || exp != nil {
		t.Fatalf("db not cleared: %q %q %v %v", text, emoji, exp, err)
	}
}

// Bug 07.10 «В сети» shows away: a manual status chosen on a device that was AFK ends that
// session's automatic idle, so clearing the manual status later shows ONLINE, not IDLE.
func TestManualPresenceEndsSessionAfk(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	og, bg := dialGW(t), dialGW(t)
	og.identify(o.token)
	bg.identify(bob.token)
	set := func(st v1.PresenceStatus, until *timestamppb.Timestamp) {
		bg.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_PRESENCE_UPDATE,
			Payload: &v1.GatewayFrame_SetPresence{SetPresence: &v1.SetPresence{Status: st, Until: until}}})
	}
	others := func(st v1.PresenceStatus) {
		t.Helper()
		og.wait("presence "+st.String(), func(e *v1.DispatchEvent) bool {
			p := e.GetPresenceUpdate().GetPresence()
			return p.GetUserId() == bob.id && p.GetStatus() == st
		})
	}
	set(v1.PresenceStatus_PRESENCE_STATUS_IDLE, nil) // AFK on this device
	others(v1.PresenceStatus_PRESENCE_STATUS_IDLE)
	set(v1.PresenceStatus_PRESENCE_STATUS_DND, &timestamppb.Timestamp{})
	others(v1.PresenceStatus_PRESENCE_STATUS_DND)
	set(v1.PresenceStatus_PRESENCE_STATUS_ONLINE, &timestamppb.Timestamp{}) // «В сети»
	others(v1.PresenceStatus_PRESENCE_STATUS_ONLINE)
}
