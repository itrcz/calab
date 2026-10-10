package main

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/calaba/calaba/server/internal/billing/providers/tochkapay/tochkapaytest"
)

func TestTochkapaySmoke(t *testing.T) {
	bank := tochkapaytest.New(t)
	var out bytes.Buffer
	if err := tochkapaySmoke(context.Background(), bank.Config(), &out); err != nil {
		t.Fatalf("%v\n%s", err, out.String())
	}
	got := out.String()
	for _, want := range []string{"binding result: accepted", "charge 1.00 RUB: succeeded", "charge again (read, not sent): succeeded <nil>", "refund: succeeded"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in\n%s", want, got)
		}
	}
	if bank.Charges != 1 {
		t.Fatalf("charges %d", bank.Charges)
	}
	live := bank.Config()
	live.Live = true
	if err := tochkapaySmoke(context.Background(), live, &out); err == nil {
		t.Fatal("smoke on a live config")
	}
}

func TestTochkapayPubkey(t *testing.T) {
	bank := tochkapaytest.New(t)
	t.Setenv("TOCHKA_PAY_SIGNING_KEY", bank.SigningKeyPEM())
	var out bytes.Buffer
	if err := tochkapayCmd(context.Background(), []string{"pubkey"}, &out); err != nil {
		t.Fatal(err)
	}
	if s := strings.TrimSpace(out.String()); s == "" || strings.Contains(s, "PRIVATE") || strings.Contains(s, "\n") {
		t.Fatalf("pubkey %q", s)
	}
	if err := tochkapayCmd(context.Background(), []string{"nope"}, &out); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("usage: %v", err)
	}
}
