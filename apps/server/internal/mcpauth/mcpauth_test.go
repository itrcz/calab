package mcpauth

import "testing"

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
