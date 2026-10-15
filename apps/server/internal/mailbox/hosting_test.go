package mailbox

// The hosting client's contract (ADR-0100 §2): one POST with the Bearer admin token, the
// answer's password, distinguishable failures. Plain unit tests against httptest.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHostingResetPassword(t *testing.T) {
	var gotPath, gotAuth, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotMethod = r.URL.Path, r.Header.Get("Authorization"), r.Method
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"password":"correct horse battery staple"}`))
	}))
	defer srv.Close()
	h := NewHosting(srv.URL+"/", "tok-1")
	h.CallTimeout = 2 * time.Second
	pw, err := h.ResetPassword(context.Background(), "Boris@Calab.io")
	if err != nil {
		t.Fatal(err)
	}
	if pw != "correct horse battery staple" {
		t.Fatalf("password %q", pw)
	}
	if gotPath != "/admin/api/mailboxes/Boris@Calab.io/password/reset" || gotMethod != http.MethodPost {
		t.Fatalf("call %s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer tok-1" {
		t.Fatalf("auth %q", gotAuth)
	}
}

func TestHostingErrors(t *testing.T) {
	for name, tc := range map[string]struct {
		status     int
		body       string
		retryAfter string
		wantCode   string
		wantStatus int
		wantRetry  time.Duration
		notHosting bool
		cancel     bool
	}{
		"mailbox not found": {status: 404, body: `{"error":"mailbox_not_found","message":"no such mailbox"}`, wantStatus: 404, wantCode: CodeMailboxNotFound},
		"own words":         {status: 404, body: `nope`, wantStatus: 404, wantCode: CodeHTTP},
		"too many":          {status: 429, body: `{"error":"rate_limited"}`, retryAfter: "17", wantStatus: 429, wantCode: "rate_limited", wantRetry: 17 * time.Second},
		"bad token":         {status: 401, body: `{"error":"unauthorized"}`, wantStatus: 401, wantCode: "unauthorized"},
		"server error":      {status: 500, body: `oops`, wantStatus: 500, wantCode: CodeHTTP},
		"bad answer":        {status: 200, body: `{"password":"short"}`, wantStatus: 200, wantCode: CodeBadAnswer},
		"no password":       {status: 200, body: `{}`, wantStatus: 200, wantCode: CodeBadAnswer},
		"garbage json":      {status: 200, body: `not json`, wantStatus: 200, wantCode: CodeBadAnswer},
		"network":           {notHosting: true, wantCode: CodeNetwork},
		"timeout":           {status: 0, cancel: true, wantCode: CodeNetwork},
	} {
		t.Run(name, func(t *testing.T) {
			hang := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tc.cancel {
					<-hang
					return
				}
				if tc.retryAfter != "" {
					w.Header().Set("Retry-After", tc.retryAfter)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			defer close(hang)
			h := NewHosting(srv.URL, "t")
			h.CallTimeout = 100 * time.Millisecond
			if tc.notHosting {
				h.base = "http://127.0.0.1:1" // nothing listens there
			}
			_, err := h.ResetPassword(context.Background(), "a@calab.io")
			e, ok := AsHostingError(err)
			if !ok {
				t.Fatalf("not a HostingError: %v", err)
			}
			if e.Status != tc.wantStatus || e.Code != tc.wantCode || e.RetryAfter != tc.wantRetry {
				t.Fatalf("got %d %q retry=%v, want %d %q retry=%v", e.Status, e.Code, e.RetryAfter, tc.wantStatus, tc.wantCode, tc.wantRetry)
			}
		})
	}
}

// The address leaves only in the path of the reset call, escaped.
func TestHostingAddressEscape(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.EscapedPath()
		_, _ = w.Write([]byte(`{"password":"abcdefghijklmnop"}`))
	}))
	defer srv.Close()
	h := NewHosting(srv.URL, "t")
	if _, err := h.ResetPassword(context.Background(), "a b/../../x@calab.io"); err != nil {
		t.Fatal(err)
	}
	if path == "/admin/api/mailboxes/a b/../../x@calab.io/password/reset" {
		t.Fatal("address not escaped")
	}
}
