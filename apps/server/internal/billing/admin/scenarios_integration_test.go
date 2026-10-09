//go:build integration

package admin_test

import (
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/admin"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider/fake"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Enable: preview writes nothing, the same request_id replays, another body is 409, a second
// enable is BILLING_ACCOUNT_EXISTS; validation of request_id and reason.
func TestEnableIdempotentAndPreview(t *testing.T) {
	e := newEnv(t, 2)
	path := "/api/admin/billing/workspaces/" + e.ws.String() + "/enable"
	rid := uuid.NewString()
	req := &v1.AdminEnableBillingRequest{Reason: "pilot customer", RequestId: rid}

	e.wantErr(422, "", "POST", path, &v1.AdminEnableBillingRequest{Reason: "pilot customer"})
	e.wantErr(422, "", "POST", path, &v1.AdminEnableBillingRequest{Reason: "pil", RequestId: rid})
	e.wantErr(422, "", "POST", path, &v1.AdminEnableBillingRequest{Reason: "pilot customer", RequestId: rid, Market: "mars"})

	var prev v1.AdminBillingMutationResult
	e.must("POST", path+"?preview=1", req, &prev)
	if !prev.GetPreview() || prev.GetAuditId() != "" || prev.GetAccount().GetStatus() != v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_INACTIVE || prev.GetAccount().GetProvider() != "stripe" {
		t.Fatalf("preview: %v", &prev)
	}
	if _, err := e.d.Q.GetLiveBillingAccountByWorkspace(ctx, &e.ws); !db.IsNotFound(err) || e.audits() != 0 {
		t.Fatalf("preview wrote: %v, %d audit rows", err, e.audits())
	}

	var res v1.AdminBillingMutationResult
	e.must("POST", path, req, &res)
	e.acc = uuid.MustParse(res.GetAccount().GetAccountId())
	if res.GetPreview() || res.GetReplayed() || res.GetAuditId() == "" || res.GetAccount().GetStatus() != v1.BillingAccountStatus_BILLING_ACCOUNT_STATUS_INACTIVE ||
		res.GetAccount().GetMarket() != "global" || res.GetAccount().GetProvider() != "stripe" || res.GetAccount().GetWorkspaceName() != e.wsName {
		t.Fatalf("enable: %v", &res)
	}
	var again v1.AdminBillingMutationResult
	e.must("POST", path, req, &again)
	if !again.GetReplayed() || again.GetAccount().GetAccountId() != e.acc.String() || again.GetAuditId() != res.GetAuditId() {
		t.Fatalf("replay: %v", &again)
	}
	e.wantErr(409, billing.ReasonRequestReused, "POST", path, &v1.AdminEnableBillingRequest{Reason: "another reason", RequestId: rid})
	e.wantErr(409, billing.ReasonAccountExists, "POST", path, &v1.AdminEnableBillingRequest{Reason: "pilot customer", RequestId: uuid.NewString()})
	if got := e.actions(); len(got) != 1 || got[0] != "enable" {
		t.Fatalf("audit: %v", got)
	}

	// Lists and details.
	var list v1.AdminBillingAccounts
	e.must("GET", "/api/admin/billing/accounts?q="+url.QueryEscape(e.wsName[:9])+"&status=inactive", nil, &list)
	if len(list.GetAccounts()) == 0 || list.GetAccounts()[0].GetAccountId() != e.acc.String() || list.GetAccounts()[0].GetBillableMembers() != 2 {
		t.Fatalf("list: %v", &list)
	}
	e.must("GET", "/api/admin/billing/accounts?q="+e.ws.String()+"&status=active", nil, &list)
	if len(list.GetAccounts()) != 0 {
		t.Fatalf("status filter: %v", &list)
	}
	var det v1.AdminBillingAccountDetails
	e.must("GET", "/api/admin/billing/accounts/"+e.acc.String(), nil, &det)
	if det.GetAccount().GetAccountId() != e.acc.String() || det.GetFreeAdvance().GetCurrency() != "USD" {
		t.Fatalf("details: %v", &det)
	}
	e.wantErr(404, "", "GET", "/api/admin/billing/accounts/"+uuid.NewString(), nil)
}

// Manual credit and its reversal: preview, replay, only an unused credit is reversed once.
func TestManualCreditAndReverse(t *testing.T) {
	e := newEnv(t, 2)
	e.enable()
	base := "/api/admin/billing/accounts/" + e.acc.String()
	rid := uuid.NewString()
	req := &v1.AdminManualCreditRequest{Amount: usd(500), Reason: "goodwill credit", RequestId: rid}

	var prev v1.AdminBillingMutationResult
	e.must("POST", base+"/manual-credits", &v1.AdminManualCreditRequest{Amount: usd(500), Reason: "goodwill credit", RequestId: rid, Preview: true}, &prev)
	if !prev.GetPreview() || prev.GetBalanceAfter().GetMinor() != 500 || e.account().BalanceMinor != 0 || e.audits() != 1 {
		t.Fatalf("preview: %v balance %d audits %d", &prev, e.account().BalanceMinor, e.audits())
	}
	e.wantErr(422, billing.ReasonInvalidCurrencyForAccount, "POST", base+"/manual-credits",
		&v1.AdminManualCreditRequest{Amount: &v1.Money{Minor: 500, Currency: "RUB"}, Reason: "goodwill credit", RequestId: uuid.NewString()})

	var res v1.AdminBillingMutationResult
	e.must("POST", base+"/manual-credits", req, &res)
	if res.GetCreditId() == "" || res.GetBalanceBefore().GetMinor() != 0 || res.GetBalanceAfter().GetMinor() != 500 || e.account().BalanceMinor != 500 {
		t.Fatalf("credit: %v", &res)
	}
	var again v1.AdminBillingMutationResult
	e.must("POST", base+"/manual-credits", req, &again)
	if !again.GetReplayed() || again.GetCreditId() != res.GetCreditId() || e.account().BalanceMinor != 500 {
		t.Fatalf("replay: %v balance %d", &again, e.account().BalanceMinor)
	}
	e.wantErr(409, billing.ReasonRequestReused, "POST", base+"/manual-credits",
		&v1.AdminManualCreditRequest{Amount: usd(600), Reason: "goodwill credit", RequestId: rid})
	e.wantErr(409, billing.ReasonRevisionConflict, "POST", base+"/manual-credits",
		&v1.AdminManualCreditRequest{Amount: usd(1), Reason: "goodwill credit", RequestId: uuid.NewString(), ExpectedRevision: 1})

	// Reverse the unused credit: preview, then once.
	rev := base + "/manual-credits/" + res.GetCreditId() + "/reverse"
	rrid := uuid.NewString()
	e.must("POST", rev+"?preview=1", &v1.AdminReverseCreditRequest{Reason: "credit by mistake", RequestId: rrid}, &prev)
	if prev.GetAmount().GetMinor() != 500 || e.account().BalanceMinor != 500 {
		t.Fatalf("reverse preview: %v", &prev)
	}
	var out v1.AdminBillingMutationResult
	e.must("POST", rev, &v1.AdminReverseCreditRequest{Reason: "credit by mistake", RequestId: rrid}, &out)
	if out.GetAmount().GetMinor() != 500 || e.account().BalanceMinor != 0 {
		t.Fatalf("reverse: %v balance %d", &out, e.account().BalanceMinor)
	}
	e.must("POST", rev, &v1.AdminReverseCreditRequest{Reason: "credit by mistake", RequestId: rrid}, &out)
	if !out.GetReplayed() || out.GetAmount().GetMinor() != 500 || e.account().BalanceMinor != 0 {
		t.Fatalf("reverse replay: %v", &out)
	}
	e.wantErr(409, billing.ReasonManualCreditAlreadyReverse, "POST", rev, &v1.AdminReverseCreditRequest{Reason: "credit by mistake", RequestId: uuid.NewString()})

	// A credit that paid for seats is not reversed (spent part would become debt).
	e.must("POST", base+"/manual-credits", &v1.AdminManualCreditRequest{Amount: usd(100), Reason: "goodwill credit", RequestId: uuid.NewString()}, &res)
	if _, err := e.c.Activate(ctx, e.acc, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	bal := e.account().BalanceMinor
	e.wantErr(409, "", "POST", base+"/manual-credits/"+res.GetCreditId()+"/reverse", &v1.AdminReverseCreditRequest{Reason: "credit by mistake", RequestId: uuid.NewString()})
	if e.account().BalanceMinor != bal {
		t.Fatal("refused reversal moved money")
	}
	e.wantErr(404, "", "POST", base+"/manual-credits/"+uuid.NewString()+"/reverse", &v1.AdminReverseCreditRequest{Reason: "credit by mistake", RequestId: uuid.NewString()})

	// Admin debit: never into debt.
	e.wantErr(409, billing.ReasonInsufficientFunds, "POST", base+"/admin-debit", &v1.AdminManualCreditRequest{Amount: usd(bal + 1), Reason: "correction", RequestId: uuid.NewString()})
	e.must("POST", base+"/admin-debit", &v1.AdminManualCreditRequest{Amount: usd(bal), Reason: "correction", RequestId: uuid.NewString()}, &out)
	if e.account().BalanceMinor != 0 || out.GetBalanceAfter().GetMinor() != 0 {
		t.Fatalf("debit: %v", &out)
	}
	want := []string{"enable", "manual_credit", "manual_credit.reverse", "manual_credit", "admin_debit"}
	if got := e.actions(); len(got) != len(want) {
		t.Fatalf("audit rows %v, want %v", got, want)
	}
	var ledger v1.LedgerPage
	e.must("GET", base+"/ledger?limit=2", nil, &ledger)
	if len(ledger.GetEntries()) != 2 || ledger.GetEntries()[0].GetKind() != v1.LedgerEntryKind_LEDGER_ENTRY_KIND_ADMIN_DEBIT || ledger.GetNextCursor() == "" {
		t.Fatalf("ledger: %v", &ledger)
	}
	e.must("GET", base+"/ledger?cursor="+ledger.GetNextCursor(), nil, &ledger)
	if len(ledger.GetEntries()) != 3 {
		t.Fatalf("ledger page 2: %v", &ledger)
	}
}

// Refunds: refundable bound, preview, partial refunds sum within the payment, replay without a
// second provider call, provider failure releases the reservation, unknown stays pending.
func TestRefunds(t *testing.T) {
	e := newEnv(t, 1)
	e.enable()
	p := e.pay(1000)
	path := "/api/admin/billing/payments/" + p.ID.String() + "/refunds"
	refund := func(amount int64, rid string) *v1.AdminRefundRequest {
		return &v1.AdminRefundRequest{Amount: usd(amount), Reason: "customer asked", RequestId: rid}
	}

	calls0 := e.fp.Calls("Refund")
	e.wantErr(409, billing.ReasonRefundExceedsRefundable, "POST", path, refund(1001, uuid.NewString()))
	var res v1.AdminBillingMutationResult
	e.must("POST", path+"?preview=1", refund(400, uuid.NewString()), &res)
	if !res.GetPreview() || res.GetRefundable().GetMinor() != 1000 || res.GetBalanceAfter().GetMinor() != 600 || len(e.refunds()) != 0 || e.account().BalanceMinor != 1000 {
		t.Fatalf("preview: %v", &res)
	}
	if e.fp.Calls("Refund") != calls0 {
		t.Fatal("preview called the provider")
	}

	rid := uuid.NewString()
	e.must("POST", path, refund(400, rid), &res)
	if len(res.GetRefunds()) != 1 || res.GetRefunds()[0].GetRefund().GetStatus() != v1.RefundStatus_REFUND_STATUS_SUCCEEDED ||
		res.GetRefunds()[0].GetProviderRefundId() == "" || e.account().BalanceMinor != 600 {
		t.Fatalf("refund: %v", &res)
	}
	calls := e.fp.Calls("Refund")
	e.must("POST", path, refund(400, rid), &res)
	if !res.GetReplayed() || len(e.refunds()) != 1 || e.fp.Calls("Refund") != calls || e.account().BalanceMinor != 600 {
		t.Fatalf("replay: %v refunds %d calls %d", &res, len(e.refunds()), e.fp.Calls("Refund"))
	}
	e.wantErr(409, billing.ReasonRequestReused, "POST", path, refund(401, rid))

	// The provider declines: the reservation goes back.
	e.fp.Queue(fake.OpRefund, fake.Decline)
	e.must("POST", path, refund(300, uuid.NewString()), &res)
	if res.GetRefunds()[0].GetRefund().GetStatus() != v1.RefundStatus_REFUND_STATUS_FAILED || e.account().BalanceMinor != 600 {
		t.Fatalf("declined: %v balance %d", &res, e.account().BalanceMinor)
	}

	// Unknown outcome: stays pending with the money reserved; the same request_id finishes it.
	e.fp.Queue(fake.OpRefund, fake.Unknown)
	urid := uuid.NewString()
	e.must("POST", path, refund(100, urid), &res)
	if res.GetRefunds()[0].GetRefund().GetStatus() != v1.RefundStatus_REFUND_STATUS_PENDING || e.account().BalanceMinor != 500 {
		t.Fatalf("unknown: %v balance %d", &res, e.account().BalanceMinor)
	}
	var det v1.AdminBillingAccountDetails
	e.must("GET", "/api/admin/billing/accounts/"+e.acc.String(), nil, &det)
	if det.GetPendingRefunds().GetMinor() != 100 {
		t.Fatalf("pending refunds: %v", &det)
	}
	e.must("POST", path, refund(100, urid), &res)
	if !res.GetReplayed() || res.GetRefunds()[0].GetRefund().GetStatus() != v1.RefundStatus_REFUND_STATUS_SUCCEEDED || e.account().BalanceMinor != 500 {
		t.Fatalf("unknown retried: %v", &res)
	}

	// Partial refunds never exceed the payment: 400 + 100 refunded, 500 left.
	e.wantErr(409, billing.ReasonRefundExceedsRefundable, "POST", path, refund(501, uuid.NewString()))
	e.must("POST", path, refund(500, uuid.NewString()), &res)
	pay, err := e.d.Q.GetBillingPayment(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pay.RefundedMinor != 1000 || e.account().BalanceMinor != 0 {
		t.Fatalf("refunded %d balance %d", pay.RefundedMinor, e.account().BalanceMinor)
	}
	e.wantErr(409, billing.ReasonRefundExceedsRefundable, "POST", path, refund(1, uuid.NewString()))

	var list v1.AdminBillingRefunds
	e.must("GET", "/api/admin/billing/refunds?account_id="+e.acc.String()+"&status=succeeded", nil, &list)
	if len(list.GetRefunds()) != 3 {
		t.Fatalf("refund list: %v", &list)
	}
	var pays v1.AdminBillingPayments
	e.must("GET", "/api/admin/billing/payments?account_id="+e.acc.String(), nil, &pays)
	if len(pays.GetPayments()) != 1 || pays.GetPayments()[0].GetPayment().GetRefunded().GetMinor() != 1000 {
		t.Fatalf("payments: %v", &pays)
	}
	if got := e.actions(); len(got) != 5 { // enable + 4 refunds (the declined one included)
		t.Fatalf("audit: %v", got)
	}
}

// Owner refund requests: approve refunds FIFO over the payments with unused money; reject moves
// nothing; a decided request is not decided again.
func TestDecideRefundRequest(t *testing.T) {
	e := newEnv(t, 1)
	e.enable()
	p1 := e.pay(1000)
	p2 := e.pay(1000)
	request := func(amount int64) sqlc.BillingRefundRequest {
		rr, err := db.GuardValue(ctx, e.d, func(q *sqlc.Queries) (sqlc.BillingRefundRequest, error) {
			return q.InsertBillingRefundRequest(ctx, sqlc.InsertBillingRefundRequestParams{AccountID: e.acc, RequestID: uuid.New(), AmountMinor: amount, Reason: "leaving", RequestedBy: &e.owner})
		})
		if err != nil {
			t.Fatal(err)
		}
		return rr
	}
	decide := func(id uuid.UUID) string { return "/api/admin/billing/refund-requests/" + id.String() + "/decide" }

	big := request(2500)
	e.wantErr(409, billing.ReasonRefundExceedsRefundable, "POST", decide(big.ID), &v1.AdminDecideRefundRequest{Approve: true, Reason: "owner request", RequestId: uuid.NewString()})

	rr := request(1500)
	var res v1.AdminBillingMutationResult
	e.must("POST", decide(rr.ID)+"?preview=1", &v1.AdminDecideRefundRequest{Approve: true, Reason: "owner request", RequestId: uuid.NewString()}, &res)
	if len(res.GetRefunds()) != 2 || len(e.refunds()) != 0 {
		t.Fatalf("preview: %v", &res)
	}
	e.must("POST", decide(rr.ID), &v1.AdminDecideRefundRequest{Approve: true, Reason: "owner request", RequestId: uuid.NewString()}, &res)
	if len(res.GetRefunds()) != 2 || res.GetRefundRequest().GetRequest().GetStatus() != v1.RefundRequestStatus_REFUND_REQUEST_STATUS_APPROVED {
		t.Fatalf("approve: %v", &res)
	}
	byPayment := map[string]int64{}
	for _, r := range res.GetRefunds() {
		if r.GetRefund().GetStatus() != v1.RefundStatus_REFUND_STATUS_SUCCEEDED {
			t.Fatalf("refund not done: %v", r)
		}
		byPayment[r.GetRefund().GetPaymentId()] += r.GetRefund().GetAmount().GetMinor()
	}
	if byPayment[p1.ID.String()] != 1000 || byPayment[p2.ID.String()] != 500 || e.account().BalanceMinor != 500 {
		t.Fatalf("FIFO split %v balance %d", byPayment, e.account().BalanceMinor)
	}
	e.wantErr(409, "", "POST", decide(rr.ID), &v1.AdminDecideRefundRequest{Approve: true, Reason: "owner request", RequestId: uuid.NewString()})

	e.must("POST", decide(big.ID), &v1.AdminDecideRefundRequest{Reason: "not eligible", RequestId: uuid.NewString()}, &res)
	if res.GetRefundRequest().GetRequest().GetStatus() != v1.RefundRequestStatus_REFUND_REQUEST_STATUS_REJECTED || len(res.GetRefunds()) != 0 || e.account().BalanceMinor != 500 {
		t.Fatalf("reject: %v", &res)
	}
	var list v1.AdminBillingRefundRequests
	e.must("GET", "/api/admin/billing/refund-requests?account_id="+e.acc.String()+"&status=approved", nil, &list)
	if len(list.GetRequests()) != 1 || list.GetRequests()[0].GetRequest().GetAmount().GetMinor() != 1500 {
		t.Fatalf("requests: %v", &list)
	}
}

// Price versions start >= 10 days ahead and are immutable (a duplicate start is 409).
func TestPriceVersions(t *testing.T) {
	e := newEnv(t, 1)
	price := func(from time.Time, rid string) *v1.AdminCreatePriceRequest {
		return &v1.AdminCreatePriceRequest{Market: "global", Plan: v1.Plan_PLAN_TEAM, Unit: usd(12), EffectiveFrom: timestamppb.New(from),
			Reason: "price update", RequestId: rid}
	}
	e.wantErr(422, billing.ReasonPriceEffectiveTooSoon, "POST", "/api/admin/billing/prices", price(t0.Add(admin.PriceNotice-time.Second), uuid.NewString()))
	e.wantErr(422, billing.ReasonInvalidCurrencyForAccount, "POST", "/api/admin/billing/prices",
		&v1.AdminCreatePriceRequest{Market: "ru", Plan: v1.Plan_PLAN_TEAM, Unit: usd(12), EffectiveFrom: timestamppb.New(t0.Add(30 * billing.Day)), Reason: "price update", RequestId: uuid.NewString()})
	from := t0.Add(admin.PriceNotice + time.Duration(time.Now().UnixNano()%1000)*time.Minute)
	var prev v1.AdminBillingMutationResult
	e.must("POST", "/api/admin/billing/prices?preview=1", price(from, uuid.NewString()), &prev)
	var res v1.AdminBillingMutationResult
	e.must("POST", "/api/admin/billing/prices", price(from, uuid.NewString()), &res)
	if res.GetPrice().GetSku() != "seat.team.day" || res.GetPrice().GetUnit().GetMinor() != 12 || !res.GetPrice().GetEffectiveFrom().AsTime().Equal(from) {
		t.Fatalf("price: %v", &res)
	}
	e.wantErr(409, "", "POST", "/api/admin/billing/prices", price(from, uuid.NewString()))
	var list v1.AdminPriceVersions
	e.must("GET", "/api/admin/billing/prices", nil, &list)
	n := 0
	for _, p := range list.GetPrices() {
		if p.GetId() == res.GetPrice().GetId() || p.GetId() == prev.GetPrice().GetId() {
			n++
		}
	}
	if n != 1 { // the preview did not insert
		t.Fatalf("listed %d of the new version", n)
	}
}

// Hold and discount: audited, revision-checked; the discount prices the next charges.
func TestHoldAndDiscount(t *testing.T) {
	e := newEnv(t, 1)
	e.enable()
	base := "/api/admin/billing/accounts/" + e.acc.String()
	var res v1.AdminBillingMutationResult
	e.wantErr(422, "", "POST", base+"/hold", &v1.AdminHoldRequest{HoldUntil: timestamppb.New(t0.Add(-time.Hour)), Reason: "incident 42", RequestId: uuid.NewString()})
	e.must("POST", base+"/hold", &v1.AdminHoldRequest{HoldUntil: timestamppb.New(t0.Add(billing.Day)), Reason: "incident 42", RequestId: uuid.NewString()}, &res)
	if res.GetAccount().GetHoldUntil() == nil || e.account().HoldUntil == nil {
		t.Fatalf("hold: %v", &res)
	}
	e.must("POST", base+"/hold", &v1.AdminHoldRequest{Reason: "incident resolved", RequestId: uuid.NewString()}, &res)
	if e.account().HoldUntil != nil {
		t.Fatal("hold not released")
	}

	e.wantErr(422, "", "PUT", base+"/discount", &v1.AdminDiscountRequest{DiscountBps: 10001, Reason: "partner deal", RequestId: uuid.NewString()})
	e.wantErr(409, billing.ReasonRevisionConflict, "PUT", base+"/discount", &v1.AdminDiscountRequest{DiscountBps: 5000, Reason: "partner deal", RequestId: uuid.NewString(), ExpectedRevision: 999})
	rev := uint64(e.account().Revision) //nolint:gosec // test
	e.must("PUT", base+"/discount?preview=1", &v1.AdminDiscountRequest{DiscountBps: 5000, Reason: "partner deal", RequestId: uuid.NewString(), ExpectedRevision: rev}, &res)
	if res.GetAccount().GetDiscountBps() != 5000 || e.account().DiscountBps != 0 || e.account().Revision != int64(rev) { //nolint:gosec // test
		t.Fatalf("preview: %v, stored %d", &res, e.account().DiscountBps)
	}
	e.must("PUT", base+"/discount", &v1.AdminDiscountRequest{DiscountBps: 5000, Reason: "partner deal", RequestId: uuid.NewString(), ExpectedRevision: rev}, &res)
	if res.GetAccount().GetDiscountBps() != 5000 || e.committed != 3 {
		t.Fatalf("discount: %v committed %d", &res, e.committed)
	}
	e.pay(1000)
	if _, err := e.c.Activate(ctx, e.acc, core.PlanTeam, uuid.New(), &e.owner); err != nil {
		t.Fatal(err)
	}
	if b := e.account().BalanceMinor; b != 995 { // one seat-day at 10 cents, half off
		t.Fatalf("balance after a discounted day: %d", b)
	}
	if got := e.actions(); len(got) != 4 {
		t.Fatalf("audit: %v", got)
	}
}

// Reconcile goes to the T5 reconciler and is audited; the test clock is 404 unless allowed.
func TestReconcileAndTestClock(t *testing.T) {
	e := newEnv(t, 1)
	e.enable()
	var res v1.AdminBillingMutationResult
	e.must("POST", "/api/admin/billing/accounts/"+e.acc.String()+"/reconcile", &v1.AdminReconcileRequest{Reason: "missing payment", RequestId: uuid.NewString()}, &res)
	if len(e.rec.calls) != 1 || e.rec.calls[0] != e.acc || res.GetAuditId() == "" || len(e.rec.released) != 0 {
		t.Fatalf("reconcile: %v %v", &res, e.rec.calls)
	}
	// Needs-review refunds confirmed absent at the provider are released after the reconcile;
	// a replay of the same request does not release again.
	rel := uuid.New()
	req := &v1.AdminReconcileRequest{Reason: "refund never reached Stripe", RequestId: uuid.NewString(), ReleaseRefundIds: []string{rel.String()}}
	for range 2 {
		e.must("POST", "/api/admin/billing/accounts/"+e.acc.String()+"/reconcile", req, &res)
	}
	if len(e.rec.released) != 1 || e.rec.released[0] != rel {
		t.Fatalf("released %v", e.rec.released)
	}
	e.wantErr(422, "", "POST", "/api/admin/billing/accounts/"+e.acc.String()+"/reconcile",
		&v1.AdminReconcileRequest{Reason: "x", RequestId: uuid.NewString(), ReleaseRefundIds: []string{"nope"}})
	e.wantErr(404, billing.ReasonTestClockDisabled, "POST", "/api/admin/billing/test-clock", &v1.AdminBillingTestClockRequest{})

	clk := &billing.SwitchClock{}
	h := admin.New(admin.Deps{DB: e.d, Core: e.c, Clock: clk, TestClock: clk})
	e.mux = newMux(e, h)
	var out v1.AdminBillingTestClockResponse
	e.must("POST", "/api/admin/billing/test-clock", &v1.AdminBillingTestClockRequest{Now: timestamppb.New(t0), AdvanceSeconds: 3600}, &out)
	if !out.GetFixed() || !out.GetNow().AsTime().Equal(t0.Add(time.Hour)) {
		t.Fatalf("test clock: %v", &out)
	}
	e.must("POST", "/api/admin/billing/test-clock", &v1.AdminBillingTestClockRequest{}, &out)
	if out.GetFixed() {
		t.Fatalf("test clock reset: %v", &out)
	}
}
