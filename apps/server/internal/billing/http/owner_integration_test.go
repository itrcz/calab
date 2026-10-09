//go:build integration

package billinghttp_test

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/mail"
)

// request_id idempotency of top-ups: same id + same body = same checkout (one provider call),
// same id + another body = 409, a second open checkout with another body = 409, the same
// top-up with a new id reuses the open one.
func TestTopupIdempotency(t *testing.T) {
	e := newEnv(t)
	req := &v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 2000, Currency: "USD"}, RequestId: uuid.NewString()}
	var a, b v1.CreateTopupResponse
	if st, r := e.do(e.owner, "POST", e.base()+"/topups", req, &a); st != 200 {
		t.Fatalf("topup: %d %s", st, r)
	}
	if st, _ := e.do(e.owner, "POST", e.base()+"/topups", req, &b); st != 200 || b.GetCheckoutId() != a.GetCheckoutId() || b.GetUrl() != a.GetUrl() {
		t.Fatalf("replay: %d %v vs %v", st, &b, &a)
	}
	if n := e.fake.Calls("CreateCheckout"); n != 1 {
		t.Fatalf("provider called %d times", n)
	}
	if !strings.HasPrefix(a.GetUrl(), "https://pay.fake.test/") {
		t.Fatalf("url %q", a.GetUrl())
	}
	other := &v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 3000, Currency: "USD"}, RequestId: req.GetRequestId()}
	if st, r := e.do(e.owner, "POST", e.base()+"/topups", other, nil); st != 409 || r != "BILLING_REQUEST_REUSED" {
		t.Fatalf("reused id: %d %s", st, r)
	}
	other.RequestId = uuid.NewString()
	if st, r := e.do(e.owner, "POST", e.base()+"/topups", other, nil); st != 409 || r != "BILLING_PAYMENT_PENDING" {
		t.Fatalf("second open checkout: %d %s", st, r)
	}
	same := &v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 2000, Currency: "USD"}, RequestId: uuid.NewString()}
	var c v1.CreateTopupResponse
	if st, _ := e.do(e.owner, "POST", e.base()+"/topups", same, &c); st != 200 || c.GetCheckoutId() != a.GetCheckoutId() {
		t.Fatalf("same top-up, new id: %d %v", st, &c)
	}
	// The success / cancel URL carries our checkout id.
	co, err := e.d.Q.GetBillingCheckout(e.t.Context(), uuid.MustParse(a.GetCheckoutId()))
	if err != nil || co.Status != "open" || co.ProviderSessionID == nil {
		t.Fatalf("%+v %v", co, err)
	}
	var sum v1.GetBillingResponse
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &sum); st != 200 || sum.GetSummary().GetOpenCheckoutId() != a.GetCheckoutId() {
		t.Fatalf("summary open checkout: %v", &sum)
	}
}

// The method and the amount are validated against the capability matrix (422).
func TestTopupValidation(t *testing.T) {
	e := newEnv(t)
	for _, c := range []struct {
		req    *v1.CreateTopupRequest
		reason string
	}{
		{&v1.CreateTopupRequest{MethodId: "stripe:sbp", Amount: &v1.Money{Minor: 2000, Currency: "USD"}}, "BILLING_METHOD_UNAVAILABLE"},
		{&v1.CreateTopupRequest{MethodId: "tochka:card", Amount: &v1.Money{Minor: 2000, Currency: "USD"}}, "BILLING_METHOD_UNAVAILABLE"},
		{&v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 499, Currency: "USD"}}, "BILLING_AMOUNT_OUT_OF_RANGE"},
		{&v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 500001, Currency: "USD"}}, "BILLING_AMOUNT_OUT_OF_RANGE"},
		{&v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 2000, Currency: "RUB"}}, "BILLING_CURRENCY_MISMATCH"},
	} {
		c.req.RequestId = uuid.NewString()
		if st, r := e.do(e.owner, "POST", e.base()+"/topups", c.req, nil); st != 422 || r != c.reason {
			t.Errorf("%v: %d %s, want 422 %s", c.req, st, r, c.reason)
		}
	}
	if st, _ := e.do(e.owner, "POST", e.base()+"/topups", &v1.CreateTopupRequest{MethodId: "stripe:card", Amount: &v1.Money{Minor: 2000, Currency: "USD"}}, nil); st != 422 {
		t.Errorf("no request_id: %d", st)
	}
	if e.fake.Calls("CreateCheckout") != 0 {
		t.Fatal("provider called for an invalid top-up")
	}
}

// Only the owner manages billing: members see the status only (no amounts) and get 403 on
// every money route; non-members 404.
func TestOwnerOnly(t *testing.T) {
	e := newEnv(t)
	e.paid(1000)
	var sum v1.GetBillingResponse
	if st, _ := e.do(e.member, "GET", e.base(), nil, &sum); st != 200 || sum.GetSummary() != nil ||
		sum.GetStatus().GetState() != v1.BillingState_BILLING_STATE_INACTIVE {
		t.Fatalf("member view: %d %v", st, &sum)
	}
	for _, r := range []struct{ method, path string }{
		{"POST", "/topups"}, {"GET", "/ledger"}, {"GET", "/payments"}, {"GET", "/payer"}, {"PUT", "/payer"},
		{"POST", "/quote"}, {"POST", "/activate"}, {"GET", "/refund-requests"}, {"POST", "/refund-requests"},
		{"GET", "/payment-methods"}, {"GET", "/checkouts/" + uuid.NewString()},
	} {
		if st, reason := e.do(e.member, r.method, e.base()+r.path, nil, nil); st != 403 || reason != "BILLING_OWNER_REQUIRED" {
			t.Errorf("member %s %s: %d %s", r.method, r.path, st, reason)
		}
	}
	stranger := e.user()
	if st, _ := e.do(stranger, "GET", e.base(), nil, nil); st != 404 {
		t.Fatalf("stranger: %d", st)
	}
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &sum); st != 200 || sum.GetSummary().GetBalance().GetMinor() != 1000 {
		t.Fatalf("owner: %v", &sum)
	}
}

// The owner flow after a top-up: summary, quote, activate with request_id (replay ok, another
// action with the same id 409), ledger and payments pages, refund request, payer.
func TestOwnerFlow(t *testing.T) {
	e := newEnv(t)
	e.paid(5000)
	var sum v1.GetBillingResponse
	if st, _ := e.do(e.owner, "GET", e.base(), nil, &sum); st != 200 {
		t.Fatal(st)
	}
	s := sum.GetSummary()
	if s.GetBillableMembers() != 2 || s.GetDailyCost().GetMinor() != 20 || s.GetForecastDays() != 250 || len(s.GetMethods()) != 1 ||
		s.GetMethods()[0].GetId() != "stripe:card" || s.GetMethods()[0].GetMin().GetMinor() != 500 || !s.GetMethods()[0].GetAutoTopupCapable() ||
		s.GetAutoTopup().GetDefaultMaxAmount().GetMinor() != 50000 {
		t.Fatalf("summary %v", s)
	}
	var q v1.BillingQuote
	if st, _ := e.do(e.owner, "POST", e.base()+"/quote", &v1.BillingQuoteRequest{Purpose: v1.BillingQuotePurpose_BILLING_QUOTE_PURPOSE_ACTIVATE}, &q); st != 200 ||
		q.GetCharge().GetMinor() != 20 || q.GetSeats() != 2 || q.GetToPay().GetMinor() != 0 || q.GetQuoteId() == "" {
		t.Fatalf("quote %v", &q)
	}
	act := &v1.BillingActionRequest{QuoteId: q.GetQuoteId(), RequestId: uuid.NewString(), ExpectedRevision: q.GetRevision()}
	if st, r := e.do(e.owner, "POST", e.base()+"/activate", act, &sum); st != 200 || sum.GetStatus().GetState() != v1.BillingState_BILLING_STATE_ACTIVE ||
		sum.GetSummary().GetBalance().GetMinor() != 4980 {
		t.Fatalf("activate: %d %s %v", st, r, &sum)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/activate", act, nil); st != 200 {
		t.Fatalf("replay: %d %s", st, r)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/stop", act, nil); st != 409 || r != "BILLING_REQUEST_REUSED" {
		t.Fatalf("same id, other action: %d %s", st, r)
	}
	if st, r := e.do(e.owner, "POST", e.base()+"/stop", &v1.BillingActionRequest{RequestId: uuid.NewString(), ExpectedRevision: 1}, nil); st != 409 || r != "BILLING_REVISION_CONFLICT" {
		t.Fatalf("stale revision: %d %s", st, r)
	}
	var lp v1.LedgerPage
	if st, _ := e.do(e.owner, "GET", e.base()+"/ledger", nil, &lp); st != 200 || len(lp.GetEntries()) != 2 ||
		lp.GetEntries()[0].GetKind() != v1.LedgerEntryKind_LEDGER_ENTRY_KIND_SEAT_CHARGE || lp.GetEntries()[0].GetQuantity() != 2 ||
		lp.GetEntries()[1].GetKind() != v1.LedgerEntryKind_LEDGER_ENTRY_KIND_TOPUP || lp.GetEntries()[1].GetPaymentId() == "" {
		t.Fatalf("ledger %v", &lp)
	}
	var pp v1.BillingPaymentPage
	if st, _ := e.do(e.owner, "GET", e.base()+"/payments", nil, &pp); st != 200 || len(pp.GetPayments()) != 1 ||
		pp.GetPayments()[0].GetReceiptUrl() == "" || pp.GetPayments()[0].GetStatus() != v1.PaymentStatus_PAYMENT_STATUS_SUCCEEDED {
		t.Fatalf("payments %v", &pp)
	}
	rr := &v1.CreateRefundRequest{Amount: &v1.Money{Minor: 6000, Currency: "USD"}, RequestId: uuid.NewString()}
	if st, r := e.do(e.owner, "POST", e.base()+"/refund-requests", rr, nil); st != 409 || r != "BILLING_REFUND_EXCEEDS_REFUNDABLE" {
		t.Fatalf("too much: %d %s", st, r)
	}
	rr.Amount.Minor, rr.Reason = 1000, "too much"
	var got v1.BillingRefundRequest
	if st, r := e.do(e.owner, "POST", e.base()+"/refund-requests", rr, &got); st != 200 || got.GetStatus() != v1.RefundRequestStatus_REFUND_REQUEST_STATUS_REQUESTED {
		t.Fatalf("refund request: %d %s", st, r)
	}
	var again v1.BillingRefundRequest
	if st, _ := e.do(e.owner, "POST", e.base()+"/refund-requests", rr, &again); st != 200 || again.GetId() != got.GetId() {
		t.Fatalf("refund request replay: %v", &again)
	}
	var list v1.BillingRefundRequests
	if st, _ := e.do(e.owner, "GET", e.base()+"/refund-requests", nil, &list); st != 200 || len(list.GetRequests()) != 1 {
		t.Fatalf("refund requests %v", &list)
	}
	payer := &v1.PutPayerRequest{Payer: &v1.PayerProfile{Type: v1.PayerType_PAYER_TYPE_COMPANY, Name: "Acme", Country: "ae", Email: "pay@acme.test"}}
	var pr v1.PayerProfile
	if st, r := e.do(e.owner, "PUT", e.base()+"/payer", payer, &pr); st != 200 || pr.GetCountry() != "AE" {
		t.Fatalf("payer: %d %s %v", st, r, &pr)
	}
	payer.Payer.Country = "Emirates"
	if st, _ := e.do(e.owner, "PUT", e.base()+"/payer", payer, nil); st != 422 {
		t.Fatalf("bad country: %d", st)
	}
}

// Billing mails are queued once per business key.
func TestBillingMailDeduped(t *testing.T) {
	e := newEnv(t)
	e.paid(1000)
	acc := e.account()
	ns, sa := acc.CreatedAt, acc.CreatedAt.Add(7*24*3600e9)
	acc.NegativeSince, acc.SuspendAt, acc.BalanceMinor, acc.Status = &ns, &sa, -300, "active"
	for range 3 {
		if err := e.in.Mail.StateChanged(ctx, acc); err != nil {
			t.Fatal(err)
		}
	}
	if n := e.notifications("debt:"); n != 1 {
		t.Fatalf("debt mails %d", n)
	}
	acc.Status = "suspended"
	_ = e.in.Mail.StateChanged(ctx, acc)
	_ = e.in.Mail.StateChanged(ctx, acc)
	if n := e.notifications("suspended:"); n != 1 {
		t.Fatalf("suspended mails %d", n)
	}
	// The queued mail renders (owner locale fallback English).
	var tmpl, to string
	if err := e.d.Pool.QueryRow(ctx, `SELECT o.template, o.to_addr FROM mail_outbox o JOIN billing_notifications b ON b.mail_id = o.id
		WHERE b.account_id = $1 AND b.key LIKE 'debt:%'`, e.acc).Scan(&tmpl, &to); err != nil || tmpl != string(mail.TemplateBillingDebtStarted) || !strings.HasSuffix(to, "@billing.test") {
		t.Fatalf("%s %s %v", tmpl, to, err)
	}
	if _, err := mail.Render(mail.TemplateBillingDebtStarted, "ru", mail.Params{"workspace": "W", "url": "https://app.calab.test", "amount": "USD 3.00", "deadline": "2026-10-17"}); err != nil {
		t.Fatal(err)
	}
	_ = sqlc.BillingAccount{}
}

// The return page is static HTML without money logic.
func TestReturnPage(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.srv.URL+"/api/billing/return?checkout="+uuid.NewString(), http.NoBody)
	req.Header.Set("Accept-Language", "ru-RU,ru;q=0.9")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") || !strings.Contains(string(b), "Оплата обрабатывается") ||
		!strings.Contains(string(b), `href="https://app.calab.test"`) {
		t.Fatalf("%d %s %s", res.StatusCode, res.Header.Get("Content-Type"), b)
	}
	_ = fake.Succeed
}

// Auto-topup consent: stored for a saved card of the account within the cap limit, revoked by
// DELETE and by deleting the card.
func TestAutoTopupConsent(t *testing.T) {
	e := newEnv(t)
	_, sess := e.topup(1500, true)
	if _, err := e.fake.CompleteCheckout(sess, fake.Succeed); err != nil {
		t.Fatal(err)
	}
	for _, w := range e.fake.TakeWebhooks() {
		e.webhook(w)
	}
	e.process()
	var ms v1.SavedPaymentMethods
	if st, _ := e.do(e.owner, "GET", e.base()+"/payment-methods", nil, &ms); st != 200 || len(ms.GetMethods()) != 1 {
		t.Fatalf("methods %v", &ms)
	}
	pm := ms.GetMethods()[0].GetId()
	put := &v1.PutAutoTopupRequest{PaymentMethodId: pm, MaxAmount: &v1.Money{Minor: 600000, Currency: "USD"}, ConsentVersion: 1, RequestId: uuid.NewString()}
	if st, r := e.do(e.owner, "PUT", e.base()+"/auto-topup", put, nil); st != 422 || r != "BILLING_AUTO_TOPUP_LIMIT" {
		t.Fatalf("over the limit: %d %s", st, r)
	}
	put.MaxAmount.Minor, put.RequestId = 20000, uuid.NewString()
	var at v1.AutoTopupSettings
	if st, r := e.do(e.owner, "PUT", e.base()+"/auto-topup", put, &at); st != 200 || !at.GetEnabled() || at.GetMaxAmount().GetMinor() != 20000 || at.GetPaymentMethodId() != pm {
		t.Fatalf("put: %d %s %v", st, r, &at)
	}
	if st, _ := e.do(e.member, "PUT", e.base()+"/auto-topup", put, nil); st != 403 {
		t.Fatalf("member: %d", st)
	}
	if st, _ := e.do(e.owner, "DELETE", e.base()+"/auto-topup", nil, &at); st != 200 || at.GetEnabled() {
		t.Fatalf("delete: %v", &at)
	}
	put.RequestId = uuid.NewString()
	if st, _ := e.do(e.owner, "PUT", e.base()+"/auto-topup", put, &at); st != 200 || !at.GetEnabled() {
		t.Fatalf("again: %v", &at)
	}
	if st, _ := e.do(e.owner, "DELETE", e.base()+"/payment-methods/"+pm, nil, nil); st != 204 {
		t.Fatalf("delete card: %d", st)
	}
	if st, _ := e.do(e.owner, "GET", e.base()+"/auto-topup", nil, &at); st != 200 || at.GetEnabled() {
		t.Fatalf("consent survived its card: %v", &at)
	}
}
