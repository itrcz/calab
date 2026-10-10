//go:build integration

package billinghttp_test

import (
	"bytes"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	billinghttp "github.com/calaba/calaba/server/internal/billing/http"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka/tochkatest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ADR-0083: Tochka (RU, RUB) behind the real adapter and an in-memory bank; Stripe is the fake.

func rub(minor int64) *v1.Money { return &v1.Money{Minor: minor, Currency: "RUB"} }

func ruEnv(t *testing.T) *env {
	t.Helper()
	return newEnv(t, envOpt{bank: tochkatest.New(t), market: "ru"})
}

// tochkaWebhook posts a raw webhook body (a bare JWT, text/plain) to the public route.
func (e *env) tochkaWebhook(body []byte) int {
	e.t.Helper()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.srv.URL+"/api/billing/tochka/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "text/plain")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

func (e *env) rubTopup(method string, minor int64, reqID string) (int, string, *v1.CreateTopupResponse) {
	e.t.Helper()
	var out v1.CreateTopupResponse
	st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: method, Amount: rub(minor), RequestId: reqID}, &out)
	return st, reason, &out
}

func (e *env) summary() *v1.BillingSummary {
	e.t.Helper()
	var out v1.GetBillingResponse
	if st, reason := e.do(e.owner, "GET", e.base(), nil, &out); st != 200 {
		e.t.Fatalf("get billing: %d %s", st, reason)
	}
	return out.GetSummary()
}

func TestTochkaTopupWebhookCreditsOnce(t *testing.T) {
	e := ruEnv(t)
	sum := e.summary()
	if len(sum.GetMethods()) != 2 || sum.GetMethods()[0].GetId() != "tochka:card" || sum.GetMethods()[1].GetId() != "tochka:sbp" ||
		sum.GetMethods()[0].GetMin().GetMinor() != 15000 || sum.GetMethods()[0].GetMax().GetMinor() != 50000000 || sum.GetMethods()[0].GetAutoTopupCapable() {
		t.Fatalf("methods %v", sum.GetMethods())
	}
	st, reason, out := e.rubTopup("tochka:sbp", 15000, uuid.NewString())
	if st != 200 {
		t.Fatalf("topup: %d %s", st, reason)
	}
	co, err := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	if err != nil || co.ProviderSessionID == nil || co.Provider != "tochka" || co.Currency != "RUB" || co.NextPollAt == nil {
		t.Fatalf("checkout %+v %v", co, err)
	}
	op := e.bank.Op(*co.ProviderSessionID)
	if op.LinkID != co.ID.String() || op.ConsumerID != e.acc.String() || op.Mode != "sbp" || op.Amount != "150.00" || op.Email == "" {
		t.Fatalf("bank op %+v", op)
	}
	e.bank.Pay(op.ID, "sbp")
	body := e.bank.Webhook(op.ID)
	if st := e.tochkaWebhook(body); st != 200 {
		t.Fatalf("webhook %d", st)
	}
	if st := e.tochkaWebhook(body); st != 200 { // the bank's redelivery: one inbox row
		t.Fatalf("redelivery %d", st)
	}
	e.process()
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider = 'tochka' AND object_id = $1`, op.ID); n != 1 {
		t.Fatalf("inbox rows %d", n)
	}
	if acc := e.account(); acc.BalanceMinor != 15000 || e.lots() != 1 {
		t.Fatalf("balance %d lots %d", acc.BalanceMinor, e.lots())
	}
	// The app's poll of the checkout, the background poll and the reconciliation find it credited.
	var cs v1.CheckoutStatus
	if st, _ := e.do(e.owner, "GET", e.base()+"/checkouts/"+co.ID.String(), nil, &cs); st != 200 || !cs.GetCredited() || cs.GetState() != v1.CheckoutState_CHECKOUT_STATE_COMPLETED {
		t.Fatalf("checkout status %v", &cs)
	}
	e.in.PollOnce(ctx)
	e.in.Reconcile(ctx)
	if err := e.in.ReconcileAccount(ctx, e.acc); err != nil {
		t.Fatal(err)
	}
	if acc := e.account(); acc.BalanceMinor != 15000 || e.lots() != 1 || e.count(`SELECT count(*) FROM billing_payments WHERE account_id = $1`, e.acc) != 1 {
		t.Fatalf("after re-reads: balance %d lots %d", acc.BalanceMinor, e.lots())
	}
}

func TestTochkaWebhookSignatureAndForeign(t *testing.T) {
	e := ruEnv(t)
	_, _, out := e.rubTopup("tochka:card", 20000, uuid.NewString())
	co, _ := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	e.bank.Pay(*co.ProviderSessionID, "card")
	body := e.bank.Webhook(*co.ProviderSessionID)
	tampered := append(bytes.Clone(body[:len(body)-4]), []byte("AAAA")...)
	for name, b := range map[string][]byte{"tampered": tampered, "garbage": []byte("hello"), "other key": signedByOther(t)} {
		if st := e.tochkaWebhook(b); st != 400 {
			t.Errorf("%s: %d", name, st)
		}
	}
	if n := e.count(`SELECT count(*) FROM billing_provider_events WHERE provider = 'tochka' AND object_id = $1`, *co.ProviderSessionID); n != 0 {
		t.Fatalf("stored %d events from bad signatures", n)
	}
	// The bank's test webhook of another customer code: 200, stored ignored, no money.
	if st := e.tochkaWebhook(e.bank.WebhookFor(*co.ProviderSessionID, "999999999")); st != 200 {
		t.Fatalf("foreign: %d", st)
	}
	e.process()
	if e.account().BalanceMinor != 0 {
		t.Fatal("credited from a foreign webhook")
	}
}

// signedByOther is a webhook signed by another bank's key.
func signedByOther(t *testing.T) []byte {
	other := tochkatest.New(t)
	return other.WebhookFor("00000000-0000-0000-0000-000000000000", tochkatest.Customer)
}

func TestTochkaLimitsServerSide(t *testing.T) {
	e := ruEnv(t)
	for _, c := range []struct {
		amount *v1.Money
		reason string
	}{
		{rub(14999), billing.ReasonAmountOutOfRange},
		{rub(50000001), billing.ReasonAmountOutOfRange},
		{&v1.Money{Minor: 20000, Currency: "USD"}, billing.ReasonInvalidCurrencyForAccount},
	} {
		st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: "tochka:card", Amount: c.amount, RequestId: uuid.NewString()}, nil)
		if st != 422 || reason != c.reason {
			t.Errorf("%v: %d %s", c.amount, st, reason)
		}
	}
	if st, reason := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: "stripe:card", Amount: rub(20000), RequestId: uuid.NewString()}, nil); st != 422 || reason != billing.ReasonMethodUnavailable {
		t.Errorf("stripe for RU: %d %s", st, reason)
	}
	if e.bank.Creates != 0 {
		t.Fatalf("links created: %d", e.bank.Creates)
	}
	if st, _, _ := e.rubTopup("tochka:card", 15000, uuid.NewString()); st != 200 {
		t.Fatalf("150 ₽ refused: %d", st)
	}
}

// Webhooks report successes only: a paid checkout without a webhook is credited by polling, an
// expired one is closed by polling; the poll backs off while the page stays open.
func TestTochkaPollingWithoutWebhooks(t *testing.T) {
	e := ruEnv(t)
	_, _, out := e.rubTopup("tochka:card", 30000, uuid.NewString())
	cid := uuid.MustParse(out.GetCheckoutId())
	due := func() {
		if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_checkouts SET next_poll_at = now() - interval '1 second' WHERE id = $1`, cid); err != nil {
			t.Fatal(err)
		}
	}
	due()
	if n := e.in.PollOnce(ctx); n != 1 {
		t.Fatalf("polled %d", n)
	}
	co, _ := e.d.Q.GetBillingCheckout(ctx, cid)
	if co.Status != "open" || co.Polls != 1 || co.NextPollAt == nil || time.Until(*co.NextPollAt) < 50*time.Second {
		t.Fatalf("after an open poll: %+v", co)
	}
	e.bank.Pay(*co.ProviderSessionID, "card")
	due()
	e.in.PollOnce(ctx)
	if e.account().BalanceMinor != 30000 || e.lots() != 1 {
		t.Fatalf("not credited by polling: %d", e.account().BalanceMinor)
	}
	if co, _ = e.d.Q.GetBillingCheckout(ctx, cid); co.Status != "completed" {
		t.Fatalf("checkout %s", co.Status)
	}
	// A webhook arriving late changes nothing.
	if st := e.tochkaWebhook(e.bank.Webhook(*co.ProviderSessionID)); st != 200 {
		t.Fatal(st)
	}
	e.process()
	if e.account().BalanceMinor != 30000 || e.lots() != 1 {
		t.Fatal("late webhook credited again")
	}

	_, _, out = e.rubTopup("tochka:sbp", 20000, uuid.NewString())
	cid = uuid.MustParse(out.GetCheckoutId())
	co, _ = e.d.Q.GetBillingCheckout(ctx, cid)
	e.bank.Expire(*co.ProviderSessionID)
	due()
	e.in.PollOnce(ctx)
	if co, _ = e.d.Q.GetBillingCheckout(ctx, cid); co.Status != "expired" {
		t.Fatalf("expired checkout is %s", co.Status)
	}
	if e.account().BalanceMinor != 30000 {
		t.Fatal("money from an expired link")
	}
}

// A create whose answer was lost: the retry with the same request id finds the link the bank
// made (duplicate paymentLinkId), never a second one.
func TestTochkaLostCreateAnswer(t *testing.T) {
	e := ruEnv(t)
	e.bank.LoseNextCreate = true
	reqID := uuid.NewString()
	if st, reason, _ := e.rubTopup("tochka:card", 20000, reqID); st != 503 || reason != billing.ReasonProviderUnavailable {
		t.Fatalf("lost answer: %d %s", st, reason)
	}
	st, reason, out := e.rubTopup("tochka:card", 20000, reqID)
	if st != 200 || out.GetUrl() == "" {
		t.Fatalf("retry: %d %s", st, reason)
	}
	if e.bank.Creates != 1 {
		t.Fatalf("links created: %d", e.bank.Creates)
	}
	co, _ := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	if *co.ProviderSessionID != e.bank.ByLink(co.ID.String()) {
		t.Fatal("another operation stored")
	}
}

// payRU tops up minor by card through the bank and credits it (webhook).
func (e *env) payRU(minor int64) sqlc.BillingPayment {
	e.t.Helper()
	st, reason, out := e.rubTopup("tochka:card", minor, uuid.NewString())
	if st != 200 {
		e.t.Fatalf("topup %d %s", st, reason)
	}
	co, _ := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	e.bank.Pay(*co.ProviderSessionID, "card")
	if st := e.tochkaWebhook(e.bank.Webhook(*co.ProviderSessionID)); st != 200 {
		e.t.Fatal(st)
	}
	e.process()
	pay, err := e.d.Q.GetBillingPaymentByCheckout(ctx, &co.ID)
	if err != nil || pay.Status != "succeeded" {
		e.t.Fatalf("payment %+v %v", pay, err)
	}
	return pay
}

func (e *env) reserveRU(pay sqlc.BillingPayment, minor int64) sqlc.BillingRefund {
	e.t.Helper()
	var ref sqlc.BillingRefund
	err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		ref, _, err = e.core.ReserveRefund(ctx, q, core.RefundReq{PaymentID: pay.ID, Amount: minor, IdemKey: "refund:" + uuid.NewString(),
			Origin: core.RefundOriginCalab, Reason: "test"})
		return err
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return ref
}

func (e *env) refundRow(id uuid.UUID) sqlc.BillingRefund {
	e.t.Helper()
	r, err := e.d.Q.GetBillingRefund(ctx, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

// Refunds are sent at most once (no idempotency at the bank): a lost answer is resolved by
// reading Order[], never by a second POST; full and partial refunds settle by polling.
func TestTochkaRefundsOnce(t *testing.T) {
	e := ruEnv(t)
	pay := e.payRU(15000)
	// Partial refund, answer lost.
	e.bank.LoseNextRefund = true
	ref := e.reserveRU(pay, 5000)
	if err := e.in.RetryRefund(ctx, ref); err == nil {
		t.Fatal("lost answer reported as done")
	}
	ref = e.refundRow(ref.ID)
	if ref.DispatchedAt == nil || ref.Status != core.RefundPending || e.bank.RefundPosts != 1 {
		t.Fatalf("after a lost answer: %+v posts %d", ref, e.bank.RefundPosts)
	}
	for range 3 { // the reconciliation never sends it again
		if err := e.in.RetryRefund(ctx, e.refundRow(ref.ID)); err != nil {
			t.Fatal(err)
		}
	}
	ref = e.refundRow(ref.ID)
	if e.bank.RefundPosts != 1 || ref.Status != core.RefundSucceeded || ref.ProviderRefundID == nil {
		t.Fatalf("resolved by reading: %+v posts %d", ref, e.bank.RefundPosts)
	}
	if acc := e.account(); acc.BalanceMinor != 10000 {
		t.Fatalf("balance %d", acc.BalanceMinor)
	}
	// The rest, the bank answers; ON-REFUND first, REFUNDED later.
	e.bank.RefundsSettle = false
	ref2 := e.reserveRU(pay, 10000)
	if err := e.in.RetryRefund(ctx, ref2); err != nil {
		t.Fatal(err)
	}
	if r := e.refundRow(ref2.ID); r.Status != core.RefundPending || r.ProviderRefundID == nil {
		t.Fatalf("on-refund: %+v", r)
	}
	e.bank.Settle(pay.ProviderPaymentID)
	if err := e.in.RetryRefund(ctx, e.refundRow(ref2.ID)); err != nil {
		t.Fatal(err)
	}
	if r := e.refundRow(ref2.ID); r.Status != core.RefundSucceeded || e.bank.RefundPosts != 2 {
		t.Fatalf("settled: %+v posts %d", r, e.bank.RefundPosts)
	}
	if acc := e.account(); acc.BalanceMinor != 0 {
		t.Fatalf("balance %d", acc.BalanceMinor)
	}
}

// The refund answer's orderId differs from the refund's entry in Order[] (the bank does not
// document that they agree): the answer's id is not stored, the listed refund is matched to the
// Calab refund by payment and amount — never imported a second time as a dashboard refund.
func TestTochkaRefundAnswerOtherOrderID(t *testing.T) {
	e := ruEnv(t)
	pay := e.payRU(15000)
	e.bank.RefundAnswerOtherOrder = true
	ref := e.reserveRU(pay, 5000)
	if err := e.in.RetryRefund(ctx, ref); err != nil {
		t.Fatal(err)
	}
	ref = e.refundRow(ref.ID)
	if ref.ProviderRefundID != nil || ref.DispatchedAt == nil || ref.Status != core.RefundPending {
		t.Fatalf("unconfirmed answer: %+v", ref)
	}
	if err := e.in.RetryRefund(ctx, ref); err != nil {
		t.Fatal(err)
	}
	ref = e.refundRow(ref.ID)
	if ref.Status != core.RefundSucceeded || ref.ProviderRefundID == nil || e.bank.RefundPosts != 1 {
		t.Fatalf("matched by listing: %+v posts %d", ref, e.bank.RefundPosts)
	}
	if n := e.count(`SELECT count(*) FROM billing_refunds WHERE account_id = $1`, e.acc); n != 1 {
		t.Fatalf("refund rows %d (the listed refund imported as a dashboard refund)", n)
	}
	if acc := e.account(); acc.BalanceMinor != 10000 {
		t.Fatalf("balance %d", acc.BalanceMinor)
	}
}

// A digital-ruble payment is refunded only in the bank's interface: needs_review, nothing sent;
// the operator's refund in the bank is then matched to the reserved row.
func TestTochkaDigitalRubleRefundNeedsReview(t *testing.T) {
	e := ruEnv(t)
	st, _, out := e.rubTopup("tochka:sbp", 20000, uuid.NewString())
	if st != 200 {
		t.Fatal(st)
	}
	co, _ := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	e.bank.Pay(*co.ProviderSessionID, "digitalRuble")
	e.tochkaWebhook(e.bank.Webhook(*co.ProviderSessionID))
	e.process()
	pay, err := e.d.Q.GetBillingPaymentByCheckout(ctx, &co.ID)
	if err != nil {
		t.Fatal(err)
	}
	ref := e.reserveRU(pay, 20000)
	if err := e.in.RetryRefund(ctx, ref); err != nil {
		t.Fatal(err)
	}
	ref = e.refundRow(ref.ID)
	if ref.NeedsReviewAt == nil || ref.Status != core.RefundPending || e.bank.RefundPosts != 0 {
		t.Fatalf("needs review: %+v posts %d", ref, e.bank.RefundPosts)
	}
	e.bank.RefundByHand(pay.ProviderPaymentID, "200.00")
	if err := e.in.RetryRefund(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if r := e.refundRow(ref.ID); r.Status != core.RefundSucceeded || r.ProviderRefundID == nil {
		t.Fatalf("matched manual refund: %+v", r)
	}
	if n := e.count(`SELECT count(*) FROM billing_refunds WHERE account_id = $1`, e.acc); n != 1 {
		t.Fatalf("refund rows %d (a manual refund imported twice)", n)
	}
}

// --- market choice before the first payment and the sales modes (ADR-0083) ---

func selfServeRU(t *testing.T) *env {
	return newEnv(t, envOpt{bank: tochkatest.New(t), noAccount: true, cfg: func(c *billinghttp.Config) { c.SelfServe = true }})
}

func (e *env) get() *v1.GetBillingResponse {
	e.t.Helper()
	var out v1.GetBillingResponse
	if st, reason := e.do(e.owner, "GET", e.base(), nil, &out); st != 200 {
		e.t.Fatalf("get: %d %s", st, reason)
	}
	return &out
}

func (e *env) quoteMarket(market string) (int, string) {
	e.t.Helper()
	var q v1.BillingQuote
	st, reason := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{
		Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE, Plan: v1.Plan_PLAN_TEAM, Market: market}, &q)
	if st == 200 && e.acc == uuid.Nil {
		acc, err := e.d.Q.GetLiveBillingAccountByWorkspace(ctx, &e.ws)
		if err != nil {
			e.t.Fatal(err)
		}
		e.acc = acc.ID
	}
	return st, reason
}

func (e *env) setAccept(provider string, open bool) {
	e.t.Helper()
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO billing_provider_settings (provider, accept_new) VALUES ($1, $2)
		ON CONFLICT (provider) DO UPDATE SET accept_new = EXCLUDED.accept_new`, provider, open); err != nil {
		e.t.Fatal(err)
	}
}

func currencies(offers []*v1.BillingPlanOffer) map[string]int {
	out := map[string]int{}
	for _, o := range offers {
		if o.GetUnitPrice() != nil {
			out[o.GetUnitPrice().GetCurrency()]++
		}
	}
	return out
}

func TestMarketChoiceBeforeFirstPayment(t *testing.T) {
	e := selfServeRU(t)
	g := e.get()
	if g.GetSalesMode() != v1.BillingSalesMode_BILLING_SALES_MODE_BOTH || len(g.GetMarkets()) != 2 || g.GetDefaultMarket() != "global" {
		t.Fatalf("both: %v %v %s", g.GetSalesMode(), g.GetMarkets(), g.GetDefaultMarket())
	}
	if c := currencies(g.GetOffers()); c["USD"] != 2 || c["RUB"] != 2 {
		t.Fatalf("offers %v", c)
	}
	if st, reason := e.quoteMarket("ru"); st != 200 {
		t.Fatalf("quote ru: %d %s", st, reason)
	}
	if a := e.account(); a.Market != "ru" || a.Currency != "RUB" || a.Provider != "tochka" {
		t.Fatalf("account %+v", a)
	}
	if st, reason := e.quoteMarket("global"); st != 200 {
		t.Fatalf("back to global: %d %s", st, reason)
	}
	if a := e.account(); a.Market != "global" || a.Currency != "USD" || a.Provider != "stripe" {
		t.Fatalf("account %+v", a)
	}
	if st, _ := e.quoteMarket("ru"); st != 200 {
		t.Fatal("ru again")
	}
	// The first payment fixes it.
	e.payRU(15000)
	if st, reason := e.quoteMarket("global"); st != 409 || reason != billing.ReasonMarketFixed {
		t.Fatalf("after the first credit: %d %s", st, reason)
	}
	g = e.get()
	if g.GetSalesMode() != v1.BillingSalesMode_BILLING_SALES_MODE_UNSPECIFIED || len(g.GetMarkets()) != 1 || g.GetMarkets()[0] != "ru" {
		t.Fatalf("fixed: %v %v", g.GetSalesMode(), g.GetMarkets())
	}
	if c := currencies(g.GetOffers()); c["USD"] != 0 || c["RUB"] != 2 {
		t.Fatalf("fixed offers %v", c)
	}
}

// An open checkout fixes the market too; a checkout racing a switch never mixes currencies.
func TestMarketChangeRacesCheckout(t *testing.T) {
	for i := range 6 {
		e := selfServeRU(t)
		if st, _ := e.quoteMarket("ru"); st != 200 {
			t.Fatal("quote")
		}
		var wg sync.WaitGroup
		var topSt, switchSt int
		wg.Add(2)
		go func() {
			defer wg.Done()
			topSt, _, _ = e.rubTopup("tochka:card", 20000, uuid.NewString())
		}()
		go func() {
			defer wg.Done()
			switchSt, _ = e.quoteMarket("global")
		}()
		wg.Wait()
		a := e.account()
		cos := e.count(`SELECT count(*) FROM billing_checkouts WHERE account_id = $1 AND status = 'open'`, a.ID)
		mixed := e.count(`SELECT count(*) FROM billing_checkouts WHERE account_id = $1 AND currency <> $2`, a.ID, a.Currency)
		switch {
		case mixed != 0:
			t.Fatalf("run %d: a checkout in another currency than the account (%s)", i, a.Currency)
		case topSt == 200 && (a.Market != "ru" || cos != 1 || switchSt != 409):
			t.Fatalf("run %d: checkout won but account %s, open %d, switch %d", i, a.Market, cos, switchSt)
		case topSt != 200 && (a.Market != "global" || cos != 0):
			t.Fatalf("run %d: switch won but account %s, open %d, topup %d", i, a.Market, cos, topSt)
		}
	}
}

func TestSalesModes(t *testing.T) {
	t.Run("only tochka", func(t *testing.T) {
		e := selfServeRU(t)
		e.setAccept("stripe", false)
		g := e.get()
		if g.GetSalesMode() != v1.BillingSalesMode_BILLING_SALES_MODE_RU_ONLY || len(g.GetMarkets()) != 1 || g.GetDefaultMarket() != "ru" {
			t.Fatalf("%v %v %s", g.GetSalesMode(), g.GetMarkets(), g.GetDefaultMarket())
		}
		if c := currencies(g.GetOffers()); c["USD"] != 0 || c["RUB"] != 2 {
			t.Fatalf("offers %v", c)
		}
		if st, reason := e.quoteMarket("global"); st != 422 || reason != billing.ReasonMarketUnavailable {
			t.Fatalf("closed global: %d %s", st, reason)
		}
		if st, _ := e.quoteMarket(""); st != 200 || e.account().Market != "ru" {
			t.Fatal("default market not ru")
		}
		if ms := e.summary().GetMethods(); len(ms) != 2 || ms[0].GetProvider() != "tochka" {
			t.Fatalf("methods %v", ms)
		}
	})
	t.Run("only stripe", func(t *testing.T) {
		e := selfServeRU(t)
		e.setAccept("tochka", false)
		g := e.get()
		if g.GetSalesMode() != v1.BillingSalesMode_BILLING_SALES_MODE_GLOBAL_ONLY || g.GetDefaultMarket() != "global" {
			t.Fatalf("%v %s", g.GetSalesMode(), g.GetDefaultMarket())
		}
		if c := currencies(g.GetOffers()); c["RUB"] != 0 || c["USD"] != 2 {
			t.Fatalf("offers %v", c)
		}
		if st, reason := e.quoteMarket("ru"); st != 422 || reason != billing.ReasonMarketUnavailable {
			t.Fatalf("closed ru: %d %s", st, reason)
		}
	})
	t.Run("contact", func(t *testing.T) {
		e := selfServeRU(t)
		if st, _ := e.quoteMarket("ru"); st != 200 { // an account made before both closed
			t.Fatal("quote")
		}
		e.setAccept("stripe", false)
		e.setAccept("tochka", false)
		g := e.get()
		if g.GetSalesMode() != v1.BillingSalesMode_BILLING_SALES_MODE_CONTACT || len(g.GetMarkets()) != 0 {
			t.Fatalf("%v %v", g.GetSalesMode(), g.GetMarkets())
		}
		if c := currencies(g.GetOffers()); c["USD"] != 2 || c["RUB"] != 0 {
			t.Fatalf("contact offers %v", c)
		}
		if st, reason := e.quoteMarket(""); st != 422 || reason != billing.ReasonMarketUnavailable {
			t.Fatalf("quote in contact mode: %d %s", st, reason)
		}
		if st, reason, _ := e.rubTopup("tochka:card", 20000, uuid.NewString()); st != 422 || reason != billing.ReasonMarketUnavailable {
			t.Fatalf("checkout in contact mode: %d %s", st, reason)
		}
		if e.bank.Creates != 0 {
			t.Fatal("a link was created")
		}
	})
	t.Run("fixed account on a closed provider still tops up", func(t *testing.T) {
		e := ruEnv(t)
		e.payRU(15000)
		e.setAccept("tochka", false)
		if st, reason, _ := e.rubTopup("tochka:sbp", 20000, uuid.NewString()); st != 200 {
			t.Fatalf("fixed account: %d %s", st, reason)
		}
		if ms := e.summary().GetMethods(); len(ms) != 2 {
			t.Fatalf("methods of a fixed account %v", ms)
		}
	})
}

func TestPublicOffers(t *testing.T) {
	e := selfServeRU(t)
	get := func() *v1.PublicBillingOffers {
		t.Helper()
		res, err := http.Get(e.srv.URL + "/api/billing/public/offers") //nolint:noctx // test
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = res.Body.Close() }()
		raw, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "public, max-age=300" {
			t.Fatalf("%d %q %s", res.StatusCode, res.Header.Get("Cache-Control"), raw)
		}
		var out v1.PublicBillingOffers
		if err := protojson.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return &out
	}
	for _, c := range []struct {
		stripe, tochka bool
		mode           v1.BillingSalesMode
		usd, rub       int
	}{
		{true, true, v1.BillingSalesMode_BILLING_SALES_MODE_BOTH, 2, 2},
		{false, true, v1.BillingSalesMode_BILLING_SALES_MODE_RU_ONLY, 0, 2},
		{true, false, v1.BillingSalesMode_BILLING_SALES_MODE_GLOBAL_ONLY, 2, 0},
		{false, false, v1.BillingSalesMode_BILLING_SALES_MODE_CONTACT, 2, 0},
	} {
		e.setAccept("stripe", c.stripe)
		e.setAccept("tochka", c.tochka)
		o := get()
		if cur := currencies(o.GetOffers()); o.GetMode() != c.mode || cur["USD"] != c.usd || cur["RUB"] != c.rub {
			t.Errorf("%v/%v: %v %v", c.stripe, c.tochka, o.GetMode(), cur)
		}
	}
}
