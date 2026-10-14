//go:build integration

package billing_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

var ctx = context.Background()

// account creates a user, a workspace and its live USD billing account.
func account(t *testing.T, d *db.DB) (sqlc.BillingAccount, uuid.UUID) {
	t.Helper()
	email := uuid.NewString() + "@billing.test"
	u, err := d.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: "Owner", Settings: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "b" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Billing", Visibility: "private", OwnerID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	a, err := d.Q.InsertBillingAccount(ctx, sqlc.InsertBillingAccountParams{WorkspaceID: &ws.ID, Market: "global",
		Currency: "USD", Provider: "stripe", Plan: "team", CreatedBy: &u.ID})
	if err != nil {
		t.Fatal(err)
	}
	return a, u.ID
}

// sqlState returns the SQLSTATE and constraint of a database error.
func sqlState(err error) (string, string) {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code, pg.ConstraintName
	}
	return "", ""
}

func wantViolation(t *testing.T, err error, code, constraint string) {
	t.Helper()
	got, name := sqlState(err)
	if got != code || (constraint != "" && name != constraint) {
		t.Fatalf("want %s %s, got %v (%s %s)", code, constraint, err, got, name)
	}
}

func hash(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }

func payment(t *testing.T, d *db.DB, a sqlc.BillingAccount, pi string) (sqlc.BillingPayment, error) {
	t.Helper()
	at := time.Now()
	return d.Q.InsertBillingPayment(ctx, sqlc.InsertBillingPaymentParams{AccountID: a.ID, Provider: "stripe",
		ProviderAccount: "acct_test", Livemode: false, ProviderPaymentID: pi, AmountMinor: 1000, Currency: "USD",
		Status: "succeeded", Origin: "import", SucceededAt: &at})
}

func TestOneLiveAccountPerWorkspace(t *testing.T) {
	d := dbtest.Connect(t)
	a, owner := account(t, d)
	_, err := d.Q.InsertBillingAccount(ctx, sqlc.InsertBillingAccountParams{WorkspaceID: a.WorkspaceID, Market: "global",
		Currency: "USD", Provider: "stripe", Plan: "team", CreatedBy: &owner})
	wantViolation(t, err, "23505", "billing_accounts_workspace_live_idx")
	// Market and currency go together.
	_, err = d.Pool.Exec(ctx, `INSERT INTO billing_accounts (market, currency, provider) VALUES ('global', 'RUB', 'stripe')`)
	wantViolation(t, err, "23514", "billing_accounts_market_currency_check")
	// Seed prices: USD 10/30 cents, RUB 600/1800 kopecks.
	for sku, want := range map[string]int64{"seat.team.day": 10, "seat.enterprise.day": 30} {
		p, err := d.Q.GetBillingPriceAt(ctx, sqlc.GetBillingPriceAtParams{Market: "global", Sku: sku, At: time.Now()})
		if err != nil || p.UnitMinor != want || p.Currency != "USD" {
			t.Fatalf("%s: %+v %v", sku, p, err)
		}
	}
	p, err := d.Q.GetBillingPriceAt(ctx, sqlc.GetBillingPriceAtParams{Market: "ru", Sku: "seat.enterprise.day", At: time.Now()})
	if err != nil || p.UnitMinor != 1800 || p.Currency != "RUB" {
		t.Fatalf("ru enterprise: %+v %v", p, err)
	}
	_, err = d.Pool.Exec(ctx, `UPDATE billing_prices SET unit_minor = 1 WHERE id = $1`, p.ID)
	wantViolation(t, err, "23001", "")
	// Workspace delete keeps the account (workspace_id SET NULL).
	if _, err := d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'closed', closed_at = now() WHERE id = $1`, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `DELETE FROM workspaces WHERE id = $1`, *a.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if got, err := d.Q.GetBillingAccount(ctx, a.ID); err != nil || got.WorkspaceID != nil {
		t.Fatalf("after workspace delete: %+v %v", got, err)
	}
}

func TestDuplicateProviderPaymentCreditsOnce(t *testing.T) {
	d := dbtest.Connect(t)
	a, _ := account(t, d)
	p, err := payment(t, d, a, "pi_dup")
	if err != nil {
		t.Fatal(err)
	}
	// The same PaymentIntent again (webhook retry, pull-sync, Charge event): no new row.
	if _, err := payment(t, d, a, "pi_dup"); !db.IsNotFound(err) {
		t.Fatalf("second insert of pi_dup: %v", err)
	}
	lot, err := d.Q.InsertBillingFundingLot(ctx, sqlc.InsertBillingFundingLotParams{AccountID: a.ID, Source: "payment", PaymentID: &p.ID, AmountMinor: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.InsertBillingFundingLot(ctx, sqlc.InsertBillingFundingLotParams{AccountID: a.ID, Source: "payment", PaymentID: &p.ID, AmountMinor: 1000}); !db.IsNotFound(err) {
		t.Fatalf("second lot of one payment: %v", err)
	}
	// Only a payment lot has a payment, and only it.
	_, err = d.Q.InsertBillingFundingLot(ctx, sqlc.InsertBillingFundingLotParams{AccountID: a.ID, Source: "admin_credit", PaymentID: &p.ID, AmountMinor: 5})
	if c, _ := sqlState(err); c != "23514" && c != "23505" {
		t.Fatalf("admin credit with a payment: %v", err)
	}
	// consumed + refunded <= amount.
	if _, err := d.Q.ConsumeBillingFundingLot(ctx, sqlc.ConsumeBillingFundingLotParams{ID: lot.ID, Delta: 700}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.RefundBillingFundingLot(ctx, sqlc.RefundBillingFundingLotParams{ID: lot.ID, Delta: 300}); err != nil {
		t.Fatal(err)
	}
	_, err = d.Q.RefundBillingFundingLot(ctx, sqlc.RefundBillingFundingLotParams{ID: lot.ID, Delta: 1})
	wantViolation(t, err, "23514", "billing_funding_lots_amount_check")
	if open, err := d.Q.LockOpenBillingFundingLots(ctx, a.ID); err != nil || len(open) != 0 {
		t.Fatalf("a spent lot is open: %v %v", open, err)
	}
}

func TestLedgerAppendOnly(t *testing.T) {
	d := dbtest.Connect(t)
	a, owner := account(t, d)
	now := time.Now()
	var last sqlc.BillingLedger
	for i, amount := range []int64{1000, -100, -20} {
		kind := "topup"
		if amount < 0 {
			kind = "seat_charge"
		}
		err := d.Tx(ctx, func(q *sqlc.Queries) error {
			if _, err := q.LockBillingAccount(ctx, a.ID); err != nil {
				return err
			}
			var err error
			last, err = q.AppendBillingLedgerEntry(ctx, sqlc.AppendBillingLedgerEntryParams{AccountID: a.ID, Kind: kind,
				AmountMinor: amount, BusinessKey: fmt.Sprintf("test:%s:%d", a.ID, i), ActorID: &owner, Now: now})
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if last.Seq != 3 || last.BalanceAfter != 880 {
		t.Fatalf("last entry %+v", last)
	}
	acc, _ := d.Q.GetBillingAccount(ctx, a.ID)
	if acc.BalanceMinor != 880 || acc.EntrySeq != 3 || acc.Revision != a.Revision+3 {
		t.Fatalf("account cache %+v", acc)
	}
	if bad, err := d.Q.ListBillingLedgerMismatches(ctx); err != nil || len(bad) != 0 {
		t.Fatalf("mismatches %v %v", bad, err)
	}
	// A duplicate business key fails as a whole: the balance does not move.
	_, err := d.Q.AppendBillingLedgerEntry(ctx, sqlc.AppendBillingLedgerEntryParams{AccountID: a.ID, Kind: "topup",
		AmountMinor: 5, BusinessKey: last.BusinessKey, Now: now})
	wantViolation(t, err, "23505", "billing_ledger_business_key_key")
	if acc, _ := d.Q.GetBillingAccount(ctx, a.ID); acc.BalanceMinor != 880 {
		t.Fatalf("balance moved by a refused entry: %d", acc.BalanceMinor)
	}
	// The sign follows the kind.
	_, err = d.Q.AppendBillingLedgerEntry(ctx, sqlc.AppendBillingLedgerEntryParams{AccountID: a.ID, Kind: "seat_charge",
		AmountMinor: 5, BusinessKey: "test:sign", Now: now})
	wantViolation(t, err, "23514", "billing_ledger_sign_check")
	// UPDATE / DELETE / TRUNCATE raise.
	for _, sql := range []string{
		`UPDATE billing_ledger SET amount_minor = 1 WHERE id = $1`,
		`DELETE FROM billing_ledger WHERE id = $1`,
	} {
		_, err := d.Pool.Exec(ctx, sql, last.ID)
		wantViolation(t, err, "23001", "")
	}
	_, err = d.Pool.Exec(ctx, `TRUNCATE billing_ledger CASCADE`)
	wantViolation(t, err, "23001", "")
	if _, err2 := d.Q.InsertBillingAudit(ctx, sqlc.InsertBillingAuditParams{RequestID: uuid.New(), BodyHash: hash("x"), Action: "test", Details: []byte("{}")}); err2 != nil {
		t.Fatal(err2)
	}
	_, err = d.Pool.Exec(ctx, `DELETE FROM billing_audit`)
	wantViolation(t, err, "23001", "")
}

func TestOneOpenCheckoutPerAccount(t *testing.T) {
	d := dbtest.Connect(t)
	a, owner := account(t, d)
	insert := func(req uuid.UUID, body string) (sqlc.BillingCheckout, error) {
		return d.Q.InsertBillingCheckout(ctx, sqlc.InsertBillingCheckoutParams{AccountID: a.ID, RequestID: req, BodyHash: hash(body),
			Purpose: "topup", MethodID: "stripe:card", Provider: "stripe", AmountMinor: 1000, Currency: "USD",
			PayerSnapshot: []byte("{}"), CreatedBy: &owner})
	}
	r1 := uuid.New()
	c1, err := insert(r1, "a")
	if err != nil {
		t.Fatal(err)
	}
	// Same request_id: no new row (the handler compares body_hash).
	if _, err := insert(r1, "b"); !db.IsNotFound(err) {
		t.Fatalf("request_id replay: %v", err)
	}
	if got, _ := d.Q.GetBillingCheckoutByRequest(ctx, sqlc.GetBillingCheckoutByRequestParams{AccountID: a.ID, RequestID: r1}); string(got.BodyHash) != string(hash("a")) {
		t.Fatal("stored body hash")
	}
	// A second open checkout of the account is refused.
	_, err = insert(uuid.New(), "c")
	wantViolation(t, err, "23505", "billing_checkouts_one_open_idx")
	// Once the first is final, a new one may open.
	if _, err := d.Q.SetBillingCheckoutStatus(ctx, sqlc.SetBillingCheckoutStatusParams{ID: c1.ID, Status: "expired", Now: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.SetBillingCheckoutStatus(ctx, sqlc.SetBillingCheckoutStatusParams{ID: c1.ID, Status: "completed", Now: time.Now()}); !db.IsNotFound(err) {
		t.Fatalf("final checkout changed: %v", err)
	}
	if _, err := insert(uuid.New(), "d"); err != nil {
		t.Fatal(err)
	}
}

func TestOneOpenAutoTopupAttemptPerAccount(t *testing.T) {
	d := dbtest.Connect(t)
	a, _ := account(t, d)
	cust, err := d.Q.InsertBillingCustomer(ctx, sqlc.InsertBillingCustomerParams{AccountID: a.ID, Provider: "stripe", ProviderAccount: "acct_test", CustomerID: "cus_1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Q.InsertBillingCustomer(ctx, sqlc.InsertBillingCustomerParams{AccountID: a.ID, Provider: "stripe", ProviderAccount: "acct_test", CustomerID: "cus_2"}); !db.IsNotFound(err) {
		t.Fatalf("second customer of the account: %v", err)
	}
	var pm uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO billing_payment_methods (account_id, customer_id, provider, livemode, provider_pm_id, kind)
		VALUES ($1, $2, 'stripe', false, 'pm_1', 'card') RETURNING id`, a.ID, cust.ID).Scan(&pm); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	attempt := func() (sqlc.BillingAutotopupAttempt, error) {
		return d.Q.InsertBillingAutoTopupAttempt(ctx, sqlc.InsertBillingAutoTopupAttemptParams{AccountID: a.ID, PmID: pm, AmountMinor: 3200, Currency: "USD", Now: now})
	}
	first, err := attempt()
	if err != nil {
		t.Fatal(err)
	}
	for _, status := range []string{"prepared", "dispatched", "unknown"} {
		if status != "prepared" {
			if _, err := d.Q.SetBillingAutoTopupAttemptStatus(ctx, sqlc.SetBillingAutoTopupAttemptStatusParams{ID: first.ID, Status: status, Now: now}); err != nil {
				t.Fatal(err)
			}
		}
		_, err := attempt()
		wantViolation(t, err, "23505", "billing_autotopup_attempts_one_open_idx")
	}
	done, err := d.Q.SetBillingAutoTopupAttemptStatus(ctx, sqlc.SetBillingAutoTopupAttemptStatusParams{ID: first.ID, Status: "failed", FailureCode: "card_declined", Now: now})
	if err != nil || done.FinishedAt == nil || done.DispatchedAt == nil {
		t.Fatalf("finish: %+v %v", done, err)
	}
	if _, err := d.Q.SetBillingAutoTopupAttemptStatus(ctx, sqlc.SetBillingAutoTopupAttemptStatusParams{ID: first.ID, Status: "succeeded", Now: now}); !db.IsNotFound(err) {
		t.Fatalf("final attempt changed: %v", err)
	}
	if _, err := attempt(); err != nil {
		t.Fatalf("new attempt after a final one: %v", err)
	}
}

func TestDebtEpisodeColumns(t *testing.T) {
	d := dbtest.Connect(t)
	a, _ := account(t, d)
	now := time.Now()
	week := now.Add(7 * billing.Day)
	upd := func(neg, susp *time.Time) error {
		_, err := d.Q.UpdateBillingAccountState(ctx, sqlc.UpdateBillingAccountStateParams{ID: a.ID, Status: "active", Plan: "team",
			NegativeSince: neg, SuspendAt: susp, Now: now})
		return err
	}
	wantViolation(t, upd(&now, nil), "23514", "billing_accounts_episode_check")
	wantViolation(t, upd(nil, &week), "23514", "billing_accounts_episode_check")
	wantViolation(t, upd(&week, &now), "23514", "billing_accounts_episode_check")
	if err := upd(&now, &week); err != nil {
		t.Fatal(err)
	}
	if err := upd(nil, nil); err != nil {
		t.Fatal(err)
	}
	_, err := d.Pool.Exec(ctx, `UPDATE billing_accounts SET discount_bps = 10001 WHERE id = $1`, a.ID)
	wantViolation(t, err, "23514", "billing_accounts_discount_bps_check")
}

func TestChargeAndRefundConstraints(t *testing.T) {
	d := dbtest.Connect(t)
	a, _ := account(t, d)
	price, err := d.Q.GetBillingPriceAt(ctx, sqlc.GetBillingPriceAtParams{Market: "global", Sku: "seat.team.day", At: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	charge := func(key string, unfunded int64, end time.Time) (sqlc.BillingCharge, error) {
		return d.Q.InsertBillingCharge(ctx, sqlc.InsertBillingChargeParams{AccountID: a.ID, Sku: price.Sku, Plan: "team", PriceID: price.ID,
			Qty: 10, UnitMinor: 10, StartsAt: start, EndsAt: end, AmountMinor: 100, UnfundedMinor: unfunded, Reason: "activate", BusinessKey: key})
	}
	_, err = charge("activate:bad", 0, start)
	wantViolation(t, err, "23514", "billing_charges_interval_check")
	_, err = charge("activate:over", 101, start.Add(billing.Day))
	wantViolation(t, err, "23514", "")
	c, err := charge("activate:1", 40, start.Add(billing.Day))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := charge("activate:1", 0, start.Add(billing.Day)); !db.IsNotFound(err) {
		t.Fatalf("duplicate business key: %v", err)
	}
	if _, err := d.Q.CompensateBillingCharge(ctx, sqlc.CompensateBillingChargeParams{ID: c.ID, Delta: 71, DebtDelta: 10}); err == nil {
		t.Fatal("compensated + unfunded > amount accepted")
	}
	if _, err := d.Q.FundBillingCharge(ctx, sqlc.FundBillingChargeParams{ID: c.ID, Delta: 41}); !db.IsNotFound(err) {
		t.Fatalf("over-funding: %v", err)
	}
	p, err := payment(t, d, a, "pi_refund")
	if err != nil {
		t.Fatal(err)
	}
	refund := func(key string, providerID *string) (sqlc.BillingRefund, error) {
		return d.Q.InsertBillingRefund(ctx, sqlc.InsertBillingRefundParams{AccountID: a.ID, PaymentID: p.ID, AmountMinor: 100,
			Currency: "USD", Status: "pending", Origin: "calab", ProviderRefundID: providerID, IdemKey: key})
	}
	if _, err := refund("refund:a", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := refund("refund:b", nil); err != nil {
		t.Fatal("NULL provider refund ids are distinct")
	}
	if _, err := refund("refund:a", nil); !db.IsNotFound(err) {
		t.Fatalf("duplicate idem key: %v", err)
	}
	re := "re_1"
	if _, err := refund("refund:c", &re); err != nil {
		t.Fatal(err)
	}
	if _, err := refund("dashboard:re_1", &re); !db.IsNotFound(err) {
		t.Fatalf("duplicate provider refund: %v", err)
	}
	_, err = d.Pool.Exec(ctx, `UPDATE billing_payments SET refunded_minor = 1001 WHERE id = $1`, p.ID)
	wantViolation(t, err, "23514", "billing_payments_refunded_check")
}
