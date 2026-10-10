//go:build integration

package billinghttp_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/autotopup"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka/tochkatest"
)

// ADR-0083 phase 2 end to end with the real adapter: a card top-up with «save» opens a
// subscription without a schedule; its payment credits the top-up and saves the card (МИР ••0792);
// one-click top-ups charge the subscription (a lost answer is resolved by reading Order[], a
// decline fails); auto-topup in RUB charges it too; deleting the card ends the consent.
func TestTochkaSavedCard(t *testing.T) {
	e := newEnv(t, envOpt{bank: tochkatest.New(t), market: "ru", recurring: true, charger: true})
	sum := e.summary()
	if !sum.GetMethods()[0].GetAutoTopupCapable() || sum.GetMethods()[1].GetAutoTopupCapable() {
		t.Fatalf("methods %v", sum.GetMethods())
	}
	if st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: "tochka:sbp", Amount: rub(20000),
		RequestId: uuid.NewString(), SaveMethod: true}, nil); st != 422 {
		t.Fatalf("sbp save: %d %s", st, reason)
	}
	var out v1.CreateTopupResponse
	if st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: "tochka:card", Amount: rub(20000),
		RequestId: uuid.NewString(), SaveMethod: true}, &out); st != 200 {
		t.Fatalf("topup: %d %s", st, reason)
	}
	co, _ := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	sub := *co.ProviderSessionID
	if op := e.bank.Op(sub); !op.Recurring || op.LinkID != co.ID.String() {
		t.Fatalf("subscription %+v", op)
	}
	e.bank.Pay(sub, "card")
	if st := e.tochkaWebhook(e.bank.Webhook(sub)); st != 200 {
		t.Fatal(st)
	}
	e.process()
	if b := e.account().BalanceMinor; b != 20000 {
		t.Fatalf("balance %d", b)
	}
	sum = e.summary()
	ms := sum.GetSavedMethods()
	if len(ms) != 1 || ms[0].GetProvider() != "tochka" || ms[0].GetBrand() != "mir" || ms[0].GetLast4() != "0792" || !ms[0].GetOneClick() || !ms[0].GetAutoTopupCapable() {
		t.Fatalf("saved %+v", ms)
	}
	pm := ms[0].GetId()

	oneClick := func(minor int64) *v1.SavedMethodTopup {
		t.Helper()
		var r v1.SavedMethodTopup
		if st, reason := e.do(e.owner, "POST", e.base()+"/saved-method-topups", &v1.CreateSavedMethodTopupRequest{
			PaymentMethodId: pm, Amount: rub(minor), RequestId: uuid.NewString()}, &r); st != 200 {
			t.Fatalf("one-click: %d %s", st, reason)
		}
		return &r
	}
	if r := oneClick(30000); r.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_SUCCEEDED || !r.GetCredited() {
		t.Fatalf("one-click %+v", r)
	}
	if b := e.account().BalanceMinor; b != 50000 || e.bank.Charges != 1 || e.bank.ApprovalCount(sub) != 2 {
		t.Fatalf("balance %d charges %d", b, e.bank.Charges)
	}
	if n := e.count(`SELECT count(*) FROM billing_payments WHERE account_id = $1 AND origin = 'saved_method' AND provider_payment_id LIKE $2`,
		e.acc, sub+":charge:%"); n != 1 {
		t.Fatalf("charge payments %d", n)
	}
	// The answer is lost but the bank charged: found in Order[] at once, never sent again.
	e.bank.LoseNextCharge = true
	if r := oneClick(15000); r.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_SUCCEEDED {
		t.Fatalf("lost answer %+v", r)
	}
	if e.bank.Charges != 2 || e.account().BalanceMinor != 65000 {
		t.Fatalf("charges %d balance %d", e.bank.Charges, e.account().BalanceMinor)
	}
	e.bank.DeclineNextCharge = true
	if r := oneClick(15000); r.GetState() != v1.SavedMethodTopupState_SAVED_METHOD_TOPUP_STATE_FAILED || r.GetFailureCode() != "declined" {
		t.Fatalf("declined %+v", r)
	}
	// A charge webhook names the subscription: it re-reads the binding payment, nothing new.
	if st := e.tochkaWebhook(e.bank.Webhook(sub)); st != 200 {
		t.Fatal(st)
	}
	e.process()
	if e.account().BalanceMinor != 65000 {
		t.Fatal("webhook credited again")
	}

	// Auto-topup in RUB: consent within the RUB limits, then a need → one charge of the card.
	if st, reason := e.do(e.owner, "PUT", e.base()+"/auto-topup", &v1.PutAutoTopupRequest{PaymentMethodId: pm, MaxAmount: rub(50000001),
		ConsentVersion: autotopup.ConsentVersion, RequestId: uuid.NewString()}, nil); st != 422 {
		t.Fatalf("cap above 500 000 ₽: %d %s", st, reason)
	}
	if st, reason := e.do(e.owner, "PUT", e.base()+"/auto-topup", &v1.PutAutoTopupRequest{PaymentMethodId: pm, MaxAmount: rub(5000000),
		ConsentVersion: autotopup.ConsentVersion, RequestId: uuid.NewString()}, nil); st != 200 {
		t.Fatalf("consent: %d %s", st, reason)
	}
	if _, err := e.core.Activate(ctx, e.acc, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	if bal := e.account().BalanceMinor; bal > 0 {
		if _, err := e.core.AdminDebit(ctx, e.acc, bal, "drain for the test", uuid.New(), &e.owner); err != nil {
			t.Fatal(err)
		}
	}
	if n := e.job.Tick(ctx); n != 1 {
		t.Fatalf("auto-topup dispatched %d", n)
	}
	if e.bank.Charges != 4 || e.account().BalanceMinor <= 0 {
		t.Fatalf("charges %d balance %d", e.bank.Charges, e.account().BalanceMinor)
	}
	if n := e.count(`SELECT count(*) FROM billing_autotopup_attempts WHERE account_id = $1 AND kind = 'auto' AND status = 'succeeded'`, e.acc); n != 1 {
		t.Fatalf("auto attempts %d", n)
	}

	// Delete: the bank refuses to cancel a recurring subscription (424) — detached here anyway.
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, e.srv.URL+e.base()+"/payment-methods/"+pm, strings.NewReader(""))
	req.Header.Set("X-Test-User", e.owner.String())
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 204 {
		t.Fatalf("delete %v %v", res, err)
	}
	_ = res.Body.Close()
	if len(e.summary().GetSavedMethods()) != 0 || e.count(`SELECT count(*) FROM billing_autotopup WHERE account_id = $1 AND revoked_at IS NULL`, e.acc) != 0 {
		t.Fatal("still saved / consent live")
	}
}
