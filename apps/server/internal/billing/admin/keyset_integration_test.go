//go:build integration

package admin_test

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Audit M2: the background queues are walked page by page (keyset by id), so more than one
// page of waiting rows never hides the rest; refunds already marked needs_review stay out of the
// regular pass.
func TestBackgroundQueuesWalkEveryPage(t *testing.T) {
	e := newEnv(t, 1)
	e.enable()
	p := e.pay(1000)
	const n = 230 // more than two pages of 100
	t.Cleanup(func() {
		_, _ = e.d.Pool.Exec(ctx, `DELETE FROM billing_refunds WHERE idem_key LIKE 'keyset:%'`)
		_, _ = e.d.Pool.Exec(ctx, `DELETE FROM billing_payments WHERE provider_payment_id LIKE 'pi_keyset_%'`)
	})
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO billing_payments (account_id, provider, provider_account, livemode, provider_payment_id, amount_minor, currency, status, origin)
		SELECT $1, 'stripe', 'acct_keyset', false, 'pi_keyset_' || $2::text || '_' || g, 100, 'USD', 'processing', 'import' FROM generate_series(1, $3::int) g`,
		e.acc, uuid.NewString(), n); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Hour)
	if _, err := e.d.Pool.Exec(ctx, `INSERT INTO billing_refunds (account_id, payment_id, amount_minor, currency, status, origin, idem_key, updated_at, needs_review_at)
		SELECT $1, $2, 1, 'USD', 'pending', 'calab', 'keyset:' || $3::text || ':' || g, $4::timestamptz, CASE WHEN g <= $5::int THEN $4::timestamptz END FROM generate_series(1, $5::int + 3) g`,
		e.acc, p.ID, uuid.NewString(), old, n); err != nil {
		t.Fatal(err)
	}

	seen := map[uuid.UUID]bool{}
	if err := billing.WalkByID(ctx, 100, func(after uuid.UUID, lim int32) ([]sqlc.BillingPayment, error) {
		return e.d.Q.ListBillingPaymentsProcessing(ctx, sqlc.ListBillingPaymentsProcessingParams{After: after, Lim: lim})
	}, func(p sqlc.BillingPayment) uuid.UUID { return p.ID }, func(p sqlc.BillingPayment) {
		if p.AccountID == e.acc {
			seen[p.ID] = true
		}
	}); err != nil {
		t.Fatal(err)
	}
	if len(seen) != n {
		t.Fatalf("processing payments walked: %d, want %d", len(seen), n)
	}

	walk := func(withReview bool) int {
		got := 0
		if err := billing.WalkByID(ctx, 100, func(after uuid.UUID, lim int32) ([]sqlc.BillingRefund, error) {
			return e.d.Q.ListBillingRefundsToRetry(ctx, sqlc.ListBillingRefundsToRetryParams{
				AccountID: &e.acc, Before: time.Now().Add(-10 * time.Minute), WithReview: withReview, After: after, Lim: lim,
			})
		}, func(r sqlc.BillingRefund) uuid.UUID { return r.ID }, func(sqlc.BillingRefund) { got++ }); err != nil {
			t.Fatal(err)
		}
		return got
	}
	if got := walk(false); got != 3 {
		t.Fatalf("regular pass: %d refunds, want the 3 not under review", got)
	}
	if got := walk(true); got != n+3 {
		t.Fatalf("review pass: %d refunds, want %d", got, n+3)
	}
}
