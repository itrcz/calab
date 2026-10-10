//go:build integration

package billinghttp_test

import (
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/providers/tochka/tochkatest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Provider-account drift (2026-10-10): the account's Tochka customer row was written while
// TOCHKA_CUSTOMER_CODE named another customer; the operator fixed the env. New payment links go
// out under the configured code, so the row must follow it — or, with history under the old
// code, no checkout at all.

const oldCustomerCode = "300999999"

// staleCustomer writes the account's Tochka customer row under the old customer code.
func (e *env) staleCustomer() sqlc.BillingCustomer {
	e.t.Helper()
	bc, err := e.d.Q.InsertBillingCustomer(ctx, sqlc.InsertBillingCustomerParams{
		AccountID: e.acc, Provider: "tochka", ProviderAccount: oldCustomerCode, Livemode: true, CustomerID: e.acc.String(),
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return bc
}

func (e *env) customerAccount(id uuid.UUID) string {
	e.t.Helper()
	bc, err := e.d.Q.GetBillingCustomerByID(ctx, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return bc.ProviderAccount
}

func TestTochkaCustomerFollowsConfiguredAccount(t *testing.T) {
	e := ruEnv(t)
	bc := e.staleCustomer()
	st, reason, out := e.rubTopup("tochka:card", 15000, uuid.NewString())
	if st != 200 {
		t.Fatalf("topup: %d %s", st, reason)
	}
	if got := e.customerAccount(bc.ID); got != tochkatest.Customer {
		t.Fatalf("customer row on %s, want %s", got, tochkatest.Customer)
	}
	if n := e.count(`SELECT count(*) FROM billing_audit WHERE account_id = $1 AND action = 'billing.customer_account_moved'
		AND details->>'from_account' = $2 AND details->>'to_account' = $3`, e.acc, oldCustomerCode, tochkatest.Customer); n != 1 {
		t.Fatalf("audit rows %d", n)
	}
	// The paid link is credited: the inbox finds the customer under the configured code.
	co, err := e.d.Q.GetBillingCheckout(ctx, uuid.MustParse(out.GetCheckoutId()))
	if err != nil || co.ProviderSessionID == nil {
		t.Fatalf("checkout %+v %v", co, err)
	}
	e.bank.Pay(*co.ProviderSessionID, "card")
	if st := e.tochkaWebhook(e.bank.Webhook(*co.ProviderSessionID)); st != 200 {
		t.Fatalf("webhook %d", st)
	}
	e.process()
	if acc := e.account(); acc.BalanceMinor != 15000 || e.lots() != 1 {
		t.Fatalf("balance %d lots %d errors %v", acc.BalanceMinor, e.lots(), e.eventErrors())
	}
	// Another top-up: nothing to move, no second audit row.
	if st, reason, _ := e.rubTopup("tochka:card", 20000, uuid.NewString()); st != 200 {
		t.Fatalf("second topup: %d %s", st, reason)
	}
	if n := e.count(`SELECT count(*) FROM billing_audit WHERE account_id = $1 AND action = 'billing.customer_account_moved'`, e.acc); n != 1 {
		t.Fatalf("audit rows after a second top-up %d", n)
	}
}

func TestTochkaCustomerWithHistoryRefusesCheckout(t *testing.T) {
	cases := map[string]func(e *env, bc sqlc.BillingCustomer){
		"payment under the old code": func(e *env, _ sqlc.BillingCustomer) {
			if _, err := e.d.Pool.Exec(ctx, `INSERT INTO billing_payments (account_id, provider, provider_account, livemode, provider_payment_id,
				amount_minor, currency, status, origin) VALUES ($1, 'tochka', $2, true, 'op-old', 15000, 'RUB', 'failed', 'import')`, e.acc, oldCustomerCode); err != nil {
				e.t.Fatal(err)
			}
		},
		"saved method": func(e *env, bc sqlc.BillingCustomer) {
			if _, err := e.d.Pool.Exec(ctx, `INSERT INTO billing_payment_methods (account_id, customer_id, provider, livemode, provider_pm_id, kind)
				VALUES ($1, $2, 'tochka', true, $3, 'card')`, e.acc, bc.ID, "sub-"+uuid.NewString()); err != nil {
				e.t.Fatal(err)
			}
		},
		"checkout session that may still be paid": func(e *env, _ sqlc.BillingCustomer) {
			if _, err := e.d.Pool.Exec(ctx, `INSERT INTO billing_checkouts (account_id, request_id, body_hash, purpose, method_id, provider,
				amount_minor, currency, status, provider_session_id) VALUES ($1, $2, decode(repeat('ab', 32), 'hex'), 'topup', 'tochka:card', 'tochka',
				15000, 'RUB', 'completed', $3)`, e.acc, uuid.New(), "op-"+uuid.NewString()); err != nil {
				e.t.Fatal(err)
			}
		},
	}
	for name, history := range cases {
		t.Run(name, func(t *testing.T) {
			e := ruEnv(t)
			bc := e.staleCustomer()
			history(e, bc)
			for i, minor := range []int64{15000, 20000} { // the refusal frees the slot: the next try answers the same, not 409
				st, reason, _ := e.rubTopup("tochka:card", minor, uuid.NewString())
				if st != 503 || reason != billing.ReasonProviderAccountChanged {
					t.Fatalf("topup %d: %d %s", i, st, reason)
				}
			}
			if got := e.customerAccount(bc.ID); got != oldCustomerCode {
				t.Fatalf("customer row moved to %s", got)
			}
			if e.bank.Creates != 0 {
				t.Fatalf("payment links created: %d", e.bank.Creates)
			}
			if n := e.count(`SELECT count(*) FROM billing_checkouts WHERE account_id = $1 AND status = 'open'`, e.acc); n != 0 {
				t.Fatalf("open checkouts %d", n)
			}
			if n := e.count(`SELECT count(*) FROM billing_audit WHERE account_id = $1 AND action = 'billing.customer_account_moved'`, e.acc); n != 0 {
				t.Fatalf("audit rows %d", n)
			}
		})
	}
}
