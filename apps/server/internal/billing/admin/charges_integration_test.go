//go:build integration

package admin_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/admin"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/provider"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Audit M5: a chargeback the bank reported outside its API is recorded by hand — the money
// leaves the balance, the dispute hold blocks refunds (and auto-topups) until it is closed.
func TestChargebackRecordedByHand(t *testing.T) {
	e := newEnv(t, 1)
	e.enable()
	p := e.pay(1000)
	path := "/api/admin/billing/payments/" + p.ID.String() + "/chargebacks"
	cb := func(amount int64, ref, rid string) *v1.AdminRecordChargebackRequest {
		return &v1.AdminRecordChargebackRequest{Amount: usd(amount), BankReference: ref, Reason: "bank letter of 10.10", RequestId: rid}
	}

	// Stripe reports its disputes by webhook: a manual chargeback too would take the money twice.
	e.wantErr(409, "", "POST", path, cb(400, "CB-2026-1", uuid.NewString()))
	if _, err := e.d.Pool.Exec(ctx, `UPDATE billing_payments SET provider = 'tochka' WHERE id = $1`, p.ID); err != nil {
		t.Fatal(err)
	}

	var res v1.AdminBillingMutationResult
	e.must("POST", path+"?preview=1", cb(400, "CB-2026-1", uuid.NewString()), &res)
	if !res.GetPreview() || res.GetBalanceAfter().GetMinor() != 600 || e.account().BalanceMinor != 1000 || e.account().DisputeHold {
		t.Fatalf("preview: %v", &res)
	}
	e.wantErr(422, "", "POST", path, cb(1001, "CB-2026-1", uuid.NewString()))
	e.wantErr(422, "", "POST", path, cb(400, "x", uuid.NewString()))

	rid := uuid.NewString()
	e.must("POST", path, cb(400, "CB-2026-1", rid), &res)
	acc := e.account()
	if acc.BalanceMinor != 600 || !acc.DisputeHold || res.GetDispute().GetDispute().GetStatus() != v1.DisputeStatus_DISPUTE_STATUS_OPEN ||
		res.GetDispute().GetProviderDisputeId() != admin.ManualDisputePrefix+p.ID.String()+":CB-2026-1" {
		t.Fatalf("recorded: %v balance %d hold %t", &res, acc.BalanceMinor, acc.DisputeHold)
	}
	e.must("POST", path, cb(400, "CB-2026-1", rid), &res)
	if !res.GetReplayed() || e.account().BalanceMinor != 600 {
		t.Fatalf("replay: %v", &res)
	}
	e.wantErr(409, "", "POST", path, cb(100, "CB-2026-1", uuid.NewString()))
	// At most what the payment can still lose: 1000 − 400.
	e.wantErr(422, "", "POST", path, cb(601, "CB-2026-2", uuid.NewString()))

	// The hold refuses refunds of the account.
	e.wantErr(409, billing.ReasonDisputeHold, "POST", "/api/admin/billing/payments/"+p.ID.String()+"/refunds",
		&v1.AdminRefundRequest{Amount: usd(100), Reason: "customer asked", RequestId: uuid.NewString()})
	var det v1.AdminBillingAccountDetails
	e.must("GET", "/api/admin/billing/accounts/"+e.acc.String(), nil, &det)
	if len(det.GetOpenDisputes()) != 1 || !det.GetAccount().GetDisputeHold() {
		t.Fatalf("details: %v", &det)
	}

	dPath := "/api/admin/billing/disputes/" + res.GetDispute().GetDispute().GetId() + "/close"
	closeReq := func(o v1.DisputeStatus) *v1.AdminCloseDisputeRequest {
		return &v1.AdminCloseDisputeRequest{Outcome: o, Reason: "bank decided for us", RequestId: uuid.NewString()}
	}
	e.wantErr(422, "", "POST", dPath, closeReq(v1.DisputeStatus_DISPUTE_STATUS_OPEN))
	e.must("POST", dPath, closeReq(v1.DisputeStatus_DISPUTE_STATUS_WON), &res)
	if acc := e.account(); acc.BalanceMinor != 1000 || acc.DisputeHold || res.GetDispute().GetDispute().GetStatus() != v1.DisputeStatus_DISPUTE_STATUS_WON {
		t.Fatalf("won: %v balance %d hold %t", &res, acc.BalanceMinor, acc.DisputeHold)
	}
	e.wantErr(409, "", "POST", dPath, closeReq(v1.DisputeStatus_DISPUTE_STATUS_LOST))

	// A lost chargeback keeps the money taken.
	e.must("POST", path, cb(300, "CB-2026-3", uuid.NewString()), &res)
	e.must("POST", "/api/admin/billing/disputes/"+res.GetDispute().GetDispute().GetId()+"/close", closeReq(v1.DisputeStatus_DISPUTE_STATUS_LOST), &res)
	if acc := e.account(); acc.BalanceMinor != 700 || acc.DisputeHold {
		t.Fatalf("lost: balance %d hold %t", acc.BalanceMinor, acc.DisputeHold)
	}

	// A provider's dispute is closed by its webhook, never by hand.
	var d sqlc.BillingDispute
	if err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		d, _, err = e.c.OpenDispute(ctx, q, core.DisputeReq{PaymentID: p.ID, ProviderDisputeID: "dp_" + uuid.NewString(), Amount: 100})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	e.wantErr(409, "", "POST", "/api/admin/billing/disputes/"+d.ID.String()+"/close", closeReq(v1.DisputeStatus_DISPUTE_STATUS_WON))
	n := map[string]int{}
	for _, a := range e.actions() {
		n[a]++
	}
	if n["chargeback"] != 2 || n["dispute.close"] != 2 {
		t.Fatalf("audit: %v", n)
	}
}

type checker struct {
	calls []uuid.UUID
	att   func() (sqlc.BillingAutotopupAttempt, error)
}

func (c *checker) CheckAttempt(_ context.Context, _, attemptID uuid.UUID) (sqlc.BillingAutotopupAttempt, error) {
	c.calls = append(c.calls, attemptID)
	return c.att()
}

// Audit M6: the account page shows the newest saved-card charge with its window, and «Проверить
// списание сейчас» reads it at once (audited).
func TestCheckChargeNow(t *testing.T) {
	e := newEnv(t, 1)
	e.enable()
	var custID, pmID uuid.UUID
	if err := e.d.Pool.QueryRow(ctx, `INSERT INTO billing_customers (account_id, provider, provider_account, livemode, customer_id)
		VALUES ($1, 'tochka', '300123123', true, $2) RETURNING id`, e.acc, e.acc.String()).Scan(&custID); err != nil {
		t.Fatal(err)
	}
	if err := e.d.Pool.QueryRow(ctx, `INSERT INTO billing_payment_methods (account_id, customer_id, provider, livemode, provider_pm_id, kind)
		VALUES ($1, $2, 'tochka', true, $3, 'card') RETURNING id`, e.acc, custID, uuid.NewString()).Scan(&pmID); err != nil {
		t.Fatal(err)
	}
	sent := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
	var attID uuid.UUID
	if err := e.d.Pool.QueryRow(ctx, `INSERT INTO billing_autotopup_attempts (account_id, pm_id, amount_minor, currency, status, created_at, dispatched_at, order_snapshot)
		VALUES ($1, $2, 15000, 'USD', 'unknown', $3, $3, '{}') RETURNING id`, e.acc, pmID, sent).Scan(&attID); err != nil {
		t.Fatal(err)
	}
	var det v1.AdminBillingAccountDetails
	e.must("GET", "/api/admin/billing/accounts/"+e.acc.String(), nil, &det)
	lc := det.GetLastCharge()
	if lc.GetAttempt().GetId() != attID.String() || lc.GetAttempt().GetStatus() != v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_UNKNOWN ||
		!lc.GetReconcilable() || !lc.GetCheckable() || lc.GetProvider() != string(provider.Tochka) || lc.GetKind() != "auto" ||
		!lc.GetResolveBy().AsTime().Equal(sent.Add(24*time.Hour)) {
		t.Fatalf("last charge: %v", lc)
	}

	path := "/api/admin/billing/accounts/" + e.acc.String() + "/charges/" + attID.String() + "/check"
	req := func() *v1.AdminCheckChargeRequest {
		return &v1.AdminCheckChargeRequest{Reason: "owner says the card was charged", RequestId: uuid.NewString()}
	}
	e.wantErr(501, billing.ReasonNotImplemented, "POST", path, req())

	ck := &checker{att: func() (sqlc.BillingAutotopupAttempt, error) {
		att, err := e.d.Q.GetBillingAutoTopupAttemptOfAccount(ctx, sqlc.GetBillingAutoTopupAttemptOfAccountParams{ID: attID, AccountID: e.acc})
		att.Status, att.FailureCode = "failed", "not_found"
		return att, err
	}}
	e.mux = newMux(e, admin.New(admin.Deps{DB: e.d, Core: e.c, Clock: e.clk, ProviderSpec: "stripe:global", Charges: ck}))
	var res v1.AdminBillingMutationResult
	e.must("POST", path, req(), &res)
	if len(ck.calls) != 1 || res.GetCharge().GetAttempt().GetStatus() != v1.AutoTopupAttemptStatus_AUTO_TOPUP_ATTEMPT_STATUS_FAILED || res.GetAuditId() == "" {
		t.Fatalf("check: %v calls %d", &res, len(ck.calls))
	}
	e.wantErr(404, "", "POST", "/api/admin/billing/accounts/"+e.acc.String()+"/charges/"+uuid.NewString()+"/check", req())
	if len(ck.calls) != 1 {
		t.Fatal("an unknown attempt was checked")
	}
}
