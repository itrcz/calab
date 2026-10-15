//go:build integration

// Mailbox password recovery through a bot (ADR-0100): the two Bot API routes, the checks
// behind them, the limits and the public one-time redemption. The mail hosting is a fake
// admin API (mailHostFake, alive for the whole run; TestMain points MAILHOST_ADMIN_URL at
// it); the per-test allowlist names each test's own bot.
package app_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/redisx"
)

// mailHostFake is the admin API of "our mail hosting": it answers the reset call with a
// fixed password and records the addresses it was asked for.
type mailHostFake struct {
	mu       sync.Mutex
	srv      *httptest.Server
	password string
	status   int // 0 = answer with the password
	seen     []string
	auths    []string
}

func newMailHostFake() *mailHostFake {
	f := &mailHostFake{password: "correct horse battery staple"}
	mux := http.NewServeMux()
	mux.HandleFunc("/admin/api/mailboxes/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.auths = append(f.auths, r.Header.Get("Authorization"))
		addr := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/admin/api/mailboxes/"), "/password/reset")
		if r.Method != http.MethodPost || addr == "" || !strings.HasSuffix(r.URL.Path, "/password/reset") {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":"not_found"}`))
			return
		}
		f.seen = append(f.seen, addr)
		if f.status != 0 {
			w.WriteHeader(f.status)
			_, _ = fmt.Fprintf(w, `{"error":%q}`, map[int]string{404: "mailbox_not_found", 429: "rate_limited", 500: "internal"}[f.status])
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"password":"` + f.password + `"}`))
	})
	f.srv = httptest.NewServer(mux)
	return f
}

// url is the admin API's base; the package-level var starts it before TestMain builds the
// config.
func (f *mailHostFake) url() string { return f.srv.URL }

func (f *mailHostFake) reset(status int) {
	f.mu.Lock()
	f.status, f.seen, f.auths = status, nil, nil
	f.mu.Unlock()
}

func (f *mailHostFake) addresses() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.seen...)
}

func (f *mailHostFake) lastAuth() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.auths) == 0 {
		return ""
	}
	return f.auths[len(f.auths)-1]
}

var mailHostFakeSrv = newMailHostFake()

// postJSON is client.do for the plain-JSON mailbox routes (they are not in the proto
// contract, ADR-0100 §2). c == nil: no Authorization header (the public redeem route).
func postJSON(t *testing.T, c *client, path string, in, out any) int {
	t.Helper()
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, srv.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if c != nil && c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if c != nil {
		c.lastBody = raw
	}
	if out != nil && resp.StatusCode < 300 {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("POST %s: decode %s: %v", path, raw, err)
		}
	}
	return resp.StatusCode
}

// allowBot points the reset allowlist at this bot's username for the test.
func allowBot(t *testing.T, b *bot) {
	t.Helper()
	testApp.Mailbox.ResetBots = []string{b.username}
	t.Cleanup(func() { testApp.Mailbox.ResetBots = nil })
}

// clearResetLimit empties one reset bucket (keys as in internal/mailbox Routes).
func clearResetLimit(t *testing.T, key string) {
	t.Helper()
	_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key(key)).Build()).Error()
}

func execSQL(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(), query, args...); err != nil {
		t.Fatal(err)
	}
}

type hostingCheckOut struct {
	Hosted   bool   `json:"hosted"`
	Domain   string `json:"domain"`
	Verified bool   `json:"verified"`
}

type passwordResetOut struct {
	Token     string `json:"token"`
	RedeemURL string `json:"redeemUrl"`
	ExpiresAt string `json:"expiresAt"`
}

type redeemOut struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func TestMailboxPasswordReset(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	b := createBot(t, o, ws.GetId(), "Tunka")
	allowBot(t, b)
	target := register(t, code)
	targetKey := "rl:mailbox-reset:" + target.id
	botKey := "rl:mailbox-reset-bot:" + b.id
	mailHostFakeSrv.reset(0)

	t.Run("happy path", func(t *testing.T) {
		clearResetLimit(t, targetKey)
		clearResetLimit(t, botKey)
		var check hostingCheckOut
		if st := postJSON(t, b.client, "/api/mailbox/hosting-check", map[string]string{"userId": target.id}, &check); st != 200 {
			t.Fatalf("hosting-check: %d %s", st, b.lastBody)
		}
		if !check.Hosted || check.Domain != "example.com" || !check.Verified {
			t.Fatalf("hosting-check: %+v", check)
		}
		mailHostFakeSrv.reset(0)
		var reset passwordResetOut
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, &reset); st != 200 {
			t.Fatalf("password-reset: %d %s", st, b.lastBody)
		}
		if len(reset.Token) < 20 || reset.RedeemURL != "https://app.example.com/mail-reset/"+reset.Token {
			t.Fatalf("reset answer: %+v", reset)
		}
		exp, err := time.Parse(time.RFC3339, reset.ExpiresAt)
		if err != nil || time.Until(exp) < 9*time.Minute || time.Until(exp) > 11*time.Minute {
			t.Fatalf("expiresAt: %q (%v)", reset.ExpiresAt, err)
		}
		if got := mailHostFakeSrv.addresses(); len(got) != 1 || got[0] != target.email {
			t.Fatalf("the hosting saw %v, want [%s]", got, target.email)
		}
		if mailHostFakeSrv.lastAuth() != "Bearer it-hosting-token" {
			t.Fatalf("hosting auth: %q", mailHostFakeSrv.lastAuth())
		}
		// The token opens the mailbox exactly once, without any session.
		var out redeemOut
		if st := postJSON(t, nil, "/api/mailbox/password/redeem", map[string]string{"token": reset.Token}, &out); st != 200 {
			t.Fatalf("redeem: %d", st)
		}
		if out.Email != target.email || out.Password != "correct horse battery staple" {
			t.Fatalf("redeem: %+v", out)
		}
		if st := postJSON(t, nil, "/api/mailbox/password/redeem", map[string]string{"token": reset.Token}, &out); st != 410 {
			t.Fatalf("second redeem: %d, want 410", st)
		}
	})

	t.Run("unverified email", func(t *testing.T) {
		clearResetLimit(t, targetKey)
		execSQL(t, "UPDATE users SET email_verified_at = NULL WHERE id = $1", target.id)
		t.Cleanup(func() { execSQL(t, "UPDATE users SET email_verified_at = now() WHERE id = $1", target.id) })
		var check hostingCheckOut
		postJSON(t, b.client, "/api/mailbox/hosting-check", map[string]string{"userId": target.id}, &check)
		if !check.Hosted || check.Verified {
			t.Fatalf("hosting-check of an unverified address: %+v", check)
		}
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 403 {
			t.Fatalf("password-reset unverified: %d %s, want 403", st, b.lastBody)
		}
		if !strings.Contains(string(b.lastBody), "EMAIL_NOT_VERIFIED") {
			t.Fatalf("error body: %s", b.lastBody)
		}
	})

	t.Run("foreign domain", func(t *testing.T) {
		clearResetLimit(t, targetKey)
		execSQL(t, "UPDATE users SET email = 'boris@gmail.com' WHERE id = $1", target.id)
		t.Cleanup(func() { execSQL(t, "UPDATE users SET email = $1 WHERE id = $2", target.email, target.id) })
		var check hostingCheckOut
		postJSON(t, b.client, "/api/mailbox/hosting-check", map[string]string{"userId": target.id}, &check)
		if check.Hosted || check.Domain != "gmail.com" {
			t.Fatalf("hosting-check: %+v", check)
		}
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 422 {
			t.Fatalf("password-reset foreign: %d %s, want 422", st, b.lastBody)
		}
		if !strings.Contains(string(b.lastBody), "DOMAIN_NOT_HOSTED") {
			t.Fatalf("error body: %s", b.lastBody)
		}
	})

	t.Run("guest target", func(t *testing.T) {
		clearResetLimit(t, targetKey)
		execSQL(t, "UPDATE users SET is_guest = true WHERE id = $1", target.id)
		t.Cleanup(func() { execSQL(t, "UPDATE users SET is_guest = false WHERE id = $1", target.id) })
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 403 {
			t.Fatalf("guest target: %d, want 403", st)
		}
	})

	t.Run("no such user", func(t *testing.T) {
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": "01890000-0000-7000-8000-00000000abcd"}, nil); st != 404 {
			t.Fatalf("unknown target: %d, want 404", st)
		}
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": "not-a-uuid"}, nil); st != 422 {
			t.Fatalf("bad userId: %d, want 422", st)
		}
	})

	t.Run("outside allowlist", func(t *testing.T) {
		clearResetLimit(t, botKey)
		mailHostFakeSrv.reset(0)
		other := createBot(t, o, ws.GetId(), "Stranger")
		if st := postJSON(t, other.client, "/api/mailbox/hosting-check", map[string]string{"userId": target.id}, nil); st != 403 {
			t.Fatalf("hosting-check stranger: %d, want 403", st)
		}
		if st := postJSON(t, other.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 403 {
			t.Fatalf("password-reset stranger: %d, want 403", st)
		}
		if got := mailHostFakeSrv.addresses(); len(got) != 0 {
			t.Fatalf("the hosting was called: %v", got)
		}
	})

	t.Run("people get no mailbox data", func(t *testing.T) {
		if st := postJSON(t, o.client, "/api/mailbox/hosting-check", map[string]string{"userId": target.id}, nil); st != 403 {
			t.Fatalf("person hosting-check: %d, want 403", st)
		}
		if st := postJSON(t, o.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 403 {
			t.Fatalf("person password-reset: %d, want 403", st)
		}
	})

	t.Run("no shared workspace", func(t *testing.T) {
		clearResetLimit(t, botKey)
		ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
		foreign := register(t, invite(t, o, ws2.GetId()))
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": foreign.id}, nil); st != 403 {
			t.Fatalf("no shared workspace: %d %s, want 403", st, b.lastBody)
		}
	})

	t.Run("hosting failures", func(t *testing.T) {
		clearResetLimit(t, targetKey)
		clearResetLimit(t, botKey)
		mailHostFakeSrv.reset(404)
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 404 {
			t.Fatalf("mailbox not found: %d, want 404", st)
		}
		mailHostFakeSrv.reset(500)
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 503 {
			t.Fatalf("hosting 500: %d, want 503", st)
		}
		mailHostFakeSrv.reset(0)
	})

	t.Run("rate limits", func(t *testing.T) {
		clearResetLimit(t, targetKey)
		clearResetLimit(t, botKey)
		for i := range 3 {
			if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 200 {
				t.Fatalf("reset %d of the target: %d %s", i+1, st, b.lastBody)
			}
		}
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 429 {
			t.Fatalf("4th reset of the target: %d, want 429", st)
		}
		// The bot's own bucket (3 spent above): resets of fresh targets reach 10, the 11th is 429.
		for i := range 7 {
			fresh := register(t, code)
			if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": fresh.id}, nil); st != 200 {
				t.Fatalf("bot-bucket reset %d: %d %s", i+4, st, b.lastBody)
			}
		}
		clearResetLimit(t, targetKey)
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 429 {
			t.Fatalf("11th reset of the bot: %d, want 429", st)
		}
	})

	t.Run("feature off", func(t *testing.T) {
		testApp.Mailbox.Enabled = false
		t.Cleanup(func() { testApp.Mailbox.Enabled = true })
		if st := postJSON(t, b.client, "/api/mailbox/hosting-check", map[string]string{"userId": target.id}, nil); st != 404 {
			t.Fatalf("hosting-check off: %d, want 404", st)
		}
		if st := postJSON(t, b.client, "/api/mailbox/password-reset", map[string]string{"userId": target.id}, nil); st != 404 {
			t.Fatalf("password-reset off: %d, want 404", st)
		}
		if st := postJSON(t, nil, "/api/mailbox/password/redeem", map[string]string{"token": "whatever"}, nil); st != 404 {
			t.Fatalf("redeem off: %d, want 404", st)
		}
	})
}

// The redemption route needs no session and answers 410 for a used, unknown or expired
// token; an over-long token never reaches Redis.
func TestMailboxRedeemValidation(t *testing.T) {
	var out redeemOut
	if st := postJSON(t, nil, "/api/mailbox/password/redeem", map[string]string{"token": ""}, &out); st != 422 {
		t.Fatalf("empty token: %d, want 422", st)
	}
	if st := postJSON(t, nil, "/api/mailbox/password/redeem", map[string]string{"token": strings.Repeat("x", 129)}, &out); st != 422 {
		t.Fatalf("long token: %d, want 422", st)
	}
	if st := postJSON(t, nil, "/api/mailbox/password/redeem", map[string]string{"token": "unknown-token"}, &out); st != 410 {
		t.Fatalf("unknown token: %d, want 410", st)
	}
}
