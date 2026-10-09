package stripe

import (
	"errors"
	"testing"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

func TestGetDispute(t *testing.T) {
	m := newMock(t)
	body := func(status string) []byte {
		return []byte(`{"id":"dp_FIXTURE0001","object":"dispute","amount":1500,"currency":"usd","created":1760000000,` +
			`"livemode":false,"payment_intent":"pi_FIXTURE0004","charge":"ch_FIXTURE0004","status":"` + status + `"}`)
	}
	for _, c := range []struct {
		stripe string
		want   provider.DisputeStatus
	}{
		{"needs_response", provider.DisputeOpen}, {"warning_under_review", provider.DisputeOpen}, {"won", provider.DisputeWon},
		{"lost", provider.DisputeLost}, {"warning_closed", provider.DisputeWithdrawn}, {"prevented", provider.DisputeWithdrawn},
	} {
		m.on("GET", "/v1/disputes/dp_FIXTURE0001", 200, body(c.stripe))
	}
	p := m.provider(t)
	for _, want := range []provider.DisputeStatus{provider.DisputeOpen, provider.DisputeOpen, provider.DisputeWon,
		provider.DisputeLost, provider.DisputeWithdrawn, provider.DisputeWithdrawn} {
		f, err := p.GetDispute(ctx, "dp_FIXTURE0001")
		if err != nil {
			t.Fatal(err)
		}
		if f.Status != want || f.Amount != usd(1500) || f.PaymentID != "pi_FIXTURE0004" || f.ProviderAccount != testAccount {
			t.Fatalf("%+v, want %s", f, want)
		}
	}
	if _, err := p.GetDispute(ctx, "dp_missing"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if _, err := p.GetDispute(ctx, ""); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("empty: %v", err)
	}
	m.on("GET", "/v1/disputes/dp_LIVE", 200, []byte(`{"id":"dp_LIVE","amount":1,"currency":"usd","livemode":true,"status":"won"}`))
	if _, err := p.GetDispute(ctx, "dp_LIVE"); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("live: %v", err)
	}
}
