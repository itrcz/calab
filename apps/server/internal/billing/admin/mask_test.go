package admin

import "testing"

// Saved-card subscription ids are charge credentials: admin views mask them (ADR-0083 phase 2).
func TestRefMask(t *testing.T) {
	m := refMask{"4d401374-410d-42b2-8820-e28783ec9d7f": true}
	for in, want := range map[string]string{
		"4d401374-410d-42b2-8820-e28783ec9d7f":             "…9d7f",
		"4d401374-410d-42b2-8820-e28783ec9d7f:charge:9002": "…9d7f:charge:9002",
		"4d401374-410d-42b2-8820-e28783ec9d7f:9003":        "…9d7f:9003",
		"5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10":             "5f0c1a7e-2b4d-4c8e-9a61-0d3e7b2c9f10",
		"pi_3UOw9ABdW3G6DsDX0VXrxGmR":                      "pi_3UOw9ABdW3G6DsDX0VXrxGmR",
		"":                                                 "",
	} {
		if got := m.apply(in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}
