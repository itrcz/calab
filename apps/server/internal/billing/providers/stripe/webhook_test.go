package stripe

import (
	"errors"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/stripe/stripe-go/v86/webhook"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

func signed(body []byte, secret string, at time.Time) http.Header {
	sp := webhook.GenerateTestSignedPayload(&webhook.UnsignedPayload{Payload: body, Secret: secret, Timestamp: at})
	h := http.Header{}
	h.Set(SignatureHeader, sp.Header)
	return h
}

func TestParseWebhookKinds(t *testing.T) {
	p := newMock(t).provider(t)
	const pi, cs = "pi_FIXTURE0003", "cs_test_FIXTURE0001"
	cases := []struct {
		file, kind, object, payment, metaKind string
	}{
		{"checkout_completed", string(provider.EventCheckoutCompleted), cs, "pi_FIXTURE0004", provider.MetadataKindCheckout},
		{"checkout_async_succeeded", string(provider.EventCheckoutCompleted), cs, "pi_FIXTURE0004", provider.MetadataKindCheckout},
		{"checkout_async_failed", string(provider.EventPaymentFailed), cs, "pi_FIXTURE0004", provider.MetadataKindCheckout},
		{"checkout_expired", string(provider.EventCheckoutExpired), cs, "", provider.MetadataKindCheckout},
		{"payment_succeeded", string(provider.EventPaymentSucceeded), pi, pi, provider.MetadataKindAutoTopup},
		{"payment_processing", string(provider.EventPaymentProcessing), pi, pi, provider.MetadataKindAutoTopup},
		{"payment_failed", string(provider.EventPaymentFailed), pi, pi, provider.MetadataKindAutoTopup},
		{"payment_canceled", string(provider.EventPaymentFailed), pi, pi, provider.MetadataKindAutoTopup},
		{"charge_refunded", string(provider.EventRefundUpdated), "ch_FIXTURE0002", pi, provider.MetadataKindAutoTopup},
		{"refund_created", string(provider.EventRefundUpdated), "re_FIXTURE0001", pi, ""},
		{"refund_updated", string(provider.EventRefundUpdated), "re_FIXTURE0001", pi, ""},
		{"refund_failed", string(provider.EventRefundUpdated), "re_FIXTURE0001", pi, ""},
		{"dispute_created", string(provider.EventDisputeOpened), "dp_FIXTURE0001", pi, ""},
		{"dispute_funds_withdrawn", string(provider.EventDisputeOpened), "dp_FIXTURE0001", pi, ""},
		{"dispute_closed", string(provider.EventDisputeClosed), "dp_FIXTURE0001", pi, ""},
		{"dispute_funds_reinstated", string(provider.EventDisputeClosed), "dp_FIXTURE0001", pi, ""},
		{"method_attached", string(provider.EventMethodSaved), "pm_FIXTURE0003", "", ""},
		{"method_detached", string(provider.EventMethodDetached), "pm_FIXTURE0003", "", ""},
		{"setup_succeeded", string(provider.EventMethodSaved), "pm_FIXTURE0003", "", ""},
		{"unknown_type", string(provider.EventIgnored), "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			body := fixture(t, filepath.Join("events", c.file+".json"))
			ev, err := p.ParseWebhook(ctx, signed(body, "whsec_fixture", time.Now()), body)
			if err != nil {
				t.Fatal(err)
			}
			if string(ev.Kind) != c.kind || ev.ObjectID != c.object || ev.PaymentID != c.payment || ev.Metadata.Kind != c.metaKind {
				t.Fatalf("%+v", ev)
			}
			if ev.Provider != provider.Stripe || ev.ProviderAccount != testAccount || ev.Livemode || ev.EventID != "evt_FIXTURE_"+c.file ||
				ev.Type == "" || ev.Created.IsZero() {
				t.Fatalf("envelope %+v", ev)
			}
			if c.metaKind != "" && ev.Metadata.AccountID != fixAccount {
				t.Fatalf("metadata %+v", ev.Metadata)
			}
		})
	}
}

func TestParseWebhookSignature(t *testing.T) {
	body := fixture(t, filepath.Join("events", "payment_succeeded.json"))
	p := newMock(t).provider(t, func(c *Config) { c.WebhookSecrets = []string{"whsec_old", "whsec_new"} })
	now := time.Now()

	for _, secret := range []string{"whsec_old", "whsec_new"} { // rotation: both verify
		if _, err := p.ParseWebhook(ctx, signed(body, secret, now), body); err != nil {
			t.Fatalf("%s: %v", secret, err)
		}
	}
	bad := map[string]http.Header{
		"wrong secret": signed(body, "whsec_other", now),
		"too old":      signed(body, "whsec_new", now.Add(-10*time.Minute)),
		"no header":    {},
		"malformed":    {SignatureHeader: []string{"garbage"}},
	}
	for name, h := range bad {
		_, err := p.ParseWebhook(ctx, h, body)
		if !errors.Is(err, provider.ErrBadSignature) {
			t.Fatalf("%s: %v", name, err)
		}
	}
	tampered := append([]byte(nil), body...)
	tampered[len(tampered)-3] = ' '
	if _, err := p.ParseWebhook(ctx, signed(body, "whsec_new", now), tampered); !errors.Is(err, provider.ErrBadSignature) {
		t.Fatalf("tampered: %v", err)
	}
	none := newMock(t).provider(t, func(c *Config) { c.WebhookSecrets = nil })
	if _, err := none.ParseWebhook(ctx, signed(body, "whsec_new", now), body); !errors.Is(err, provider.ErrBadSignature) {
		t.Fatalf("no secrets: %v", err)
	}
}

func TestParseWebhookRefusals(t *testing.T) {
	p := newMock(t).provider(t)
	now := time.Now()
	old := fixture(t, filepath.Join("events", "old_version.json"))
	if _, err := p.ParseWebhook(ctx, signed(old, "whsec_fixture", now), old); !errors.Is(err, ErrAPIVersionMismatch) || errors.Is(err, provider.ErrBadSignature) {
		t.Fatalf("old version: %v", err)
	}
	live := fixture(t, filepath.Join("events", "livemode.json"))
	if _, err := p.ParseWebhook(ctx, signed(live, "whsec_fixture", now), live); !errors.Is(err, provider.ErrLivemodeForbidden) {
		t.Fatalf("livemode: %v", err)
	}
	allowed := newMock(t).provider(t, func(c *Config) { c.LivemodeAllowed = true })
	ev, err := allowed.ParseWebhook(ctx, signed(live, "whsec_fixture", now), live)
	if err != nil || !ev.Livemode {
		t.Fatalf("live allowed: %v %+v", err, ev)
	}
	conn := fixture(t, filepath.Join("events", "connect_account.json"))
	ev, err = p.ParseWebhook(ctx, signed(conn, "whsec_fixture", now), conn)
	if err != nil || ev.ProviderAccount != "acct_FIXTURECONNECT" {
		t.Fatalf("connect: %v %+v", err, ev)
	}
}

func TestParseWebhookResolvesAccount(t *testing.T) {
	m := newMock(t)
	m.on("GET", "/v1/account", 200, []byte(`{"id":"acct_FIXTURE0007","object":"account"}`))
	p := m.provider(t, func(c *Config) { c.Account = "" })
	body := fixture(t, filepath.Join("events", "payment_succeeded.json"))
	for range 2 {
		ev, err := p.ParseWebhook(ctx, signed(body, "whsec_fixture", time.Now()), body)
		if err != nil || ev.ProviderAccount != "acct_FIXTURE0007" {
			t.Fatalf("%v %+v", err, ev)
		}
	}
	if n := len(m.requests("GET", "/v1/account")); n != 1 {
		t.Fatalf("%d lookups", n)
	}
}
