package mcpauth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestShortAddress (CBF-183): /mcp is a second resource of the same server, at the same origin.
func TestShortAddress(t *testing.T) {
	s := New(Config{Origins: []string{"https://app.example.com", "https://alt.example.com"}})
	req := func(path string) *http.Request {
		return httptest.NewRequestWithContext(t.Context(), http.MethodGet, "https://alt.example.com"+path, nil)
	}
	for res, want := range map[string]bool{
		"https://alt.example.com/api/mcp": true,
		"https://alt.example.com/mcp":     true,
		"https://app.example.com/mcp":     false, // another origin's
		"https://alt.example.com/mcp/x":   false,
		"https://alt.example.com/":        false,
	} {
		if got := s.validResource(req("/api/mcp/oauth/token"), res); got != want {
			t.Errorf("validResource(%q) = %v", res, got)
		}
	}
	for path, want := range map[string]string{
		"/mcp":     "https://alt.example.com/.well-known/oauth-protected-resource/mcp",
		"/api/mcp": "https://alt.example.com/.well-known/oauth-protected-resource/api/mcp",
	} {
		if got := s.ResourceMetadataURL(req(path)); got != want {
			t.Errorf("ResourceMetadataURL(%s) = %s", path, got)
		}
	}
	for path, want := range map[string]string{
		"/.well-known/oauth-protected-resource/mcp":     "https://alt.example.com/mcp",
		"/.well-known/oauth-protected-resource/api/mcp": "https://alt.example.com/api/mcp",
		"/.well-known/oauth-protected-resource":         "https://alt.example.com/api/mcp",
	} {
		w := httptest.NewRecorder()
		s.resourceMetadata(w, req(path))
		var m map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil || m["resource"] != want {
			t.Errorf("metadata %s: %v", path, m)
		}
	}
}

func TestRedirects(t *testing.T) {
	s := New(Config{RedirectURIs: []string{"https://claude.ai/api/mcp/auth_callback"}})
	for raw, want := range map[string]bool{
		"http://127.0.0.1:33418/callback":             true,
		"http://localhost/cb":                         true,
		"http://[::1]:1/cb":                           true,
		"https://claude.ai/api/mcp/auth_callback":     true,
		"https://claude.ai/api/mcp/other":             false,
		"https://claude.ai:444/api/mcp/auth_callback": false,
		"http://claude.ai/cb":                         false,
		"http://127.0.0.1.evil.example/cb":            false,
		"http://user@127.0.0.1/cb":                    false,
		"http://127.0.0.1/cb#x":                       false,
		"cursor://cb":                                 false,
		"":                                            false,
	} {
		if _, ok := s.redirectKind(raw); ok != want {
			t.Errorf("redirectKind(%q) = %v, want %v", raw, ok, want)
		}
	}
	reg := []string{"http://127.0.0.1:33418/callback", "https://claude.ai/api/mcp/auth_callback"}
	for raw, want := range map[string]bool{
		"http://127.0.0.1:33418/callback":              true,
		"http://127.0.0.1:5000/callback":               true, // loopback: any port (RFC 8252 §7.3)
		"http://127.0.0.1:5000/other":                  false,
		"http://localhost:33418/callback":              false, // another loopback host
		"https://claude.ai/api/mcp/auth_callback":      true,
		"https://claude.ai:8443/api/mcp/auth_callback": false,
	} {
		if got := redirectMatches(reg, raw); got != want {
			t.Errorf("redirectMatches(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestIPKeyAndDisplayName(t *testing.T) {
	if k := ipKey("2001:db8:1:2:aaaa::1"); k != ipKey("2001:db8:1:2:bbbb::9") || k != "2001:db8:1:2::/64" {
		t.Fatalf("IPv6 /64: %q", k)
	}
	if k := ipKey("192.0.2.7"); k != "192.0.2.7" {
		t.Fatalf("IPv4: %q", k)
	}
	if k := ipKey("::ffff:192.0.2.7"); k != "192.0.2.7" {
		t.Fatalf("mapped IPv4: %q", k)
	}
	if n := displayName("  Claude\u202e edoC \u200b\n\tCode\x00 "); n != "Claude edoC Code" {
		t.Fatalf("displayName: %q", n)
	}
}
