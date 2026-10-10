package billinghttp

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAllowLanding(t *testing.T) {
	origins := []string{"https://calab.io"}
	for _, c := range []struct{ origin, want string }{
		{"https://calab.io", "https://calab.io"},
		{"https://evil.example", ""},
		{"", ""},
	} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/billing/public/offers", nil)
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		allowLanding(w, r, origins)
		h := w.Header()
		if got := h.Get("Access-Control-Allow-Origin"); got != c.want {
			t.Errorf("origin %q: allow-origin %q, want %q", c.origin, got, c.want)
		}
		if h.Get("Vary") != "Origin" || h.Get("Access-Control-Allow-Credentials") != "" {
			t.Errorf("origin %q: vary %q credentials %q", c.origin, h.Get("Vary"), h.Get("Access-Control-Allow-Credentials"))
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	r.Header.Set("Origin", "https://calab.io")
	allowLanding(w, r, nil) // PUBLIC_LANDING_URLS empty: nothing opened
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Error("empty list must open nothing")
	}
}
