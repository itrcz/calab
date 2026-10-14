package stripe

import (
	"errors"
	"testing"

	"github.com/calaba/calaba/server/internal/billing/provider"
)

// One-click top-up: confirmed on-session with return_url (no off_session); a 3-D Secure card
// answers requires_action with Stripe's hosted page; a failed authentication is a failure.
func TestChargeOnSession(t *testing.T) {
	m := newMock(t)
	m.on("POST", "/v1/payment_intents", 200, patch(t, fixture(t, "pi_offsession_succeeded.json"), func(pi map[string]any) {
		pi["status"], pi["amount_received"], pi["latest_charge"] = "requires_action", 0, nil
		pi["metadata"].(map[string]any)["kind"] = provider.MetadataKindSavedMethod
		pi["next_action"] = map[string]any{"type": "redirect_to_url", "redirect_to_url": map[string]any{
			"url": "https://hooks.stripe.com/3d_secure_2/hosted?x=1", "return_url": "https://app.calab.test/api/billing/return?topup=1"}}
	}))
	m.on("POST", "/v1/payment_intents", 200, patch(t, fixture(t, "pi_offsession_succeeded.json"), func(pi map[string]any) {
		pi["status"], pi["amount_received"], pi["latest_charge"] = "requires_payment_method", 0, nil
		pi["metadata"].(map[string]any)["kind"] = provider.MetadataKindSavedMethod
		pi["last_payment_error"] = map[string]any{"type": "card_error", "code": "payment_intent_authentication_failure"}
	}))
	p := m.provider(t)
	req := offReq()
	req.OnSession, req.ReturnURL = true, "https://app.calab.test/api/billing/return?topup=1"
	req.Metadata.Kind = provider.MetadataKindSavedMethod
	f, err := p.ChargeOffSession(ctx, req)
	if err != nil || f.Status != provider.PaymentRequiresAction || f.NextActionURL != "https://hooks.stripe.com/3d_secure_2/hosted?x=1" {
		t.Fatalf("3ds %+v %v", f, err)
	}
	r := m.last(t, "POST", "/v1/payment_intents")
	if r.form.Get("off_session") != "" || r.form.Get("return_url") != req.ReturnURL || r.form.Get("confirm") != "true" ||
		r.form.Get("metadata[kind]") != provider.MetadataKindSavedMethod {
		t.Fatalf("form %v", r.form)
	}
	if f, err := p.ChargeOffSession(ctx, req); err != nil || f.Status != provider.PaymentFailed {
		t.Fatalf("auth failed %+v %v", f, err)
	}
	req.ReturnURL = ""
	if _, err := p.ChargeOffSession(ctx, req); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("no return url: %v", err)
	}
}
