//go:build integration

package core_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/core"
	"github.com/calaba/calaba/server/internal/billing/worker"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

var (
	ctx = context.Background()
	// t0 is the start of every scenario (fake clock); days are full 24 h from it.
	t0 = time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
)

func day(n int) time.Time { return t0.Add(time.Duration(n) * billing.Day) }

// env is one workspace with a billing account on a fake clock.
type env struct {
	t           *testing.T
	d           *db.DB
	clk         *billing.FakeClock
	c           *core.Core
	w           *worker.Worker
	ws, owner   uuid.UUID
	acc         uuid.UUID
	members     []uuid.UUID // billable members except the owner, oldest first
	planChanged atomic.Int32
	committed   atomic.Int32
	pays        int
}

func newEnv(t *testing.T, members int) *env { return newEnvMarket(t, members, "global") }

// newEnvMarket: owner + members-1 billable members and an inactive account of market.
func newEnvMarket(t *testing.T, members int, market string) *env {
	t.Helper()
	d := dbtest.Connect(t)
	e := &env{t: t, d: d, clk: billing.NewFakeClock(t0)}
	e.c = core.New(d, e.clk, core.Config{Debits: true, Enforcement: true}, core.Hooks{
		Committed: func(_ context.Context, _ sqlc.BillingAccount, planChanged bool) {
			e.committed.Add(1)
			if planChanged {
				e.planChanged.Add(1)
			}
		},
	})
	e.w = worker.New(e.c, worker.Options{Suspend: true, Batch: 1000})
	email := uuid.NewString() + "@billing.test"
	u, err := d.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: "Owner", Settings: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	e.owner = u.ID
	ws, err := d.Q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{Slug: "b" + strings.ReplaceAll(uuid.NewString(), "-", "")[:20],
		Name: "Billing", Visibility: "private", OwnerID: u.ID})
	if err != nil {
		t.Fatal(err)
	}
	e.ws = ws.ID
	if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: u.ID, Role: "owner"}); err != nil {
		t.Fatal(err)
	}
	// A guest and a bot never count.
	guest := e.user()
	if _, err := d.Q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: guest, Role: "guest"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Pool.Exec(ctx, `WITH b AS (INSERT INTO users (display_name, settings, is_bot) VALUES ('bot', '{}', true) RETURNING id)
		INSERT INTO workspace_members (workspace_id, user_id, role) SELECT $1, id, 'member' FROM b`, ws.ID); err != nil {
		t.Fatal(err)
	}
	e.addMembers(members - 1)
	acc, err := e.c.EnableAccount(ctx, ws.ID, market, "stripe", &u.ID)
	if err != nil {
		t.Fatal(err)
	}
	e.acc = acc.ID
	t.Cleanup(func() {
		// Closed accounts are never claimed by the worker of a later test.
		_, _ = d.Pool.Exec(ctx, `UPDATE billing_accounts SET status = 'closed', closed_at = now(), next_due_at = NULL WHERE id = $1`, acc.ID)
	})
	return e
}

func (e *env) user() uuid.UUID {
	e.t.Helper()
	email := uuid.NewString() + "@billing.test"
	u, err := e.d.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: "M", Settings: []byte("{}")})
	if err != nil {
		e.t.Fatal(err)
	}
	return u.ID
}

// addMembers adds n billable members directly (no billing: setup before activation).
func (e *env) addMembers(n int) {
	e.t.Helper()
	if n <= 0 {
		return
	}
	rows, err := e.d.Pool.Query(ctx, `WITH u AS (
		INSERT INTO users (email, display_name, settings)
		SELECT gen_random_uuid()::text || '@billing.test', 'M', '{}' FROM generate_series(1, $1)
		RETURNING id)
	INSERT INTO workspace_members (workspace_id, user_id, role) SELECT $2, id, 'member' FROM u RETURNING user_id`, n, e.ws)
	if err != nil {
		e.t.Fatal(err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		e.t.Fatal(err)
	}
	e.members = append(e.members, ids...)
}

// join adds a new member through the admission path: membership + Admit in one transaction.
func (e *env) join() (uuid.UUID, error) {
	u := e.user()
	return u, e.joinUser(u, uuid.New())
}

func (e *env) joinUser(u, request uuid.UUID) error {
	err := e.d.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: e.ws, UserID: u, Role: "member"}); err != nil && !db.IsNotFound(err) {
			return err
		}
		return e.c.Admit(ctx, q, e.ws, u, request)
	})
	if err == nil {
		e.members = append(e.members, u)
	}
	return err
}

// remove drops the newest n members.
func (e *env) remove(n int) {
	e.t.Helper()
	for range n {
		u := e.members[len(e.members)-1]
		e.members = e.members[:len(e.members)-1]
		if _, err := e.d.Q.RemoveMember(ctx, sqlc.RemoveMemberParams{WorkspaceID: e.ws, UserID: u}); err != nil {
			e.t.Fatal(err)
		}
	}
}

func (e *env) isMember(u uuid.UUID) bool {
	_, err := e.d.Q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: e.ws, UserID: u})
	return err == nil
}

// pay records a succeeded provider payment at the fake time and credits it.
func (e *env) pay(amount int64) uuid.UUID {
	e.t.Helper()
	p := e.payment(amount)
	if _, err := e.c.CreditPaymentTx(ctx, p); err != nil {
		e.t.Fatal(err)
	}
	return p
}

func (e *env) payment(amount int64) uuid.UUID {
	e.t.Helper()
	e.pays++
	at := e.clk.Time()
	acc := e.account()
	p, err := e.d.Q.InsertBillingPayment(ctx, sqlc.InsertBillingPaymentParams{AccountID: e.acc, Provider: "stripe",
		ProviderAccount: "acct_test", Livemode: false, ProviderPaymentID: "pi_" + uuid.NewString(), AmountMinor: amount,
		Currency: acc.Currency, Status: "succeeded", Origin: "import", SucceededAt: &at})
	if err != nil {
		e.t.Fatal(err)
	}
	return p.ID
}

func (e *env) credit(amount int64) uuid.UUID {
	e.t.Helper()
	lot, err := e.c.AdminCredit(ctx, e.acc, amount, "test", uuid.New(), &e.owner)
	if err != nil {
		e.t.Fatal(err)
	}
	return lot
}

func (e *env) activate(plan string) {
	e.t.Helper()
	if _, err := e.c.Activate(ctx, e.acc, plan, uuid.New(), &e.owner); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) at(t time.Time) { e.clk.Set(t) }

// tick moves the clock to t and runs one worker round.
func (e *env) tick(t time.Time) {
	e.clk.Set(t)
	e.w.Tick(ctx)
}

func (e *env) account() sqlc.BillingAccount {
	e.t.Helper()
	a, err := e.d.Q.GetBillingAccount(ctx, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	return a
}

func (e *env) balance() int64 { return e.account().BalanceMinor }

func (e *env) wantBalance(want int64) {
	e.t.Helper()
	if got := e.balance(); got != want {
		e.t.Fatalf("balance %d, want %d", got, want)
	}
	e.check()
}

// charges lists the seat lots oldest first.
func (e *env) charges() []sqlc.BillingCharge {
	e.t.Helper()
	rows, err := e.d.Pool.Query(ctx, `SELECT * FROM billing_charges WHERE account_id = $1 ORDER BY starts_at, created_at, id`, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	out, err := pgx.CollectRows(rows, pgx.RowToStructByPos[sqlc.BillingCharge])
	if err != nil {
		e.t.Fatal(err)
	}
	return out
}

func (e *env) lastCharge() sqlc.BillingCharge {
	e.t.Helper()
	cs := e.charges()
	if len(cs) == 0 {
		e.t.Fatal("no charges")
	}
	return cs[len(cs)-1]
}

func (e *env) ledgerCount() int {
	e.t.Helper()
	var n int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM billing_ledger WHERE account_id = $1`, e.acc).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *env) lot(id uuid.UUID) sqlc.BillingFundingLot {
	e.t.Helper()
	l, err := e.d.Q.GetBillingFundingLot(ctx, id)
	if err != nil {
		e.t.Fatal(err)
	}
	return l
}

func (e *env) lotOf(payment uuid.UUID) sqlc.BillingFundingLot {
	e.t.Helper()
	l, err := e.d.Q.GetBillingFundingLotByPayment(ctx, &payment)
	if err != nil {
		e.t.Fatal(err)
	}
	return l
}

func (e *env) workspacePlan() sqlc.WorkspacePlan {
	e.t.Helper()
	p, err := e.d.Q.GetWorkspacePlan(ctx, e.ws)
	if err != nil {
		e.t.Fatal(err)
	}
	return p
}

// check asserts the money invariants of the account: sum(ledger) = balance cache and
// entry_seq; balance = free advance - debt; never free advance and debt at once.
func (e *env) check() {
	e.t.Helper()
	ms, err := e.c.CheckIntegrity(ctx)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, m := range ms {
		if m.AccountID == e.acc {
			e.t.Fatalf("integrity %s: %+v", m.Check, m)
		}
	}
	free, err := e.d.Q.BillingFreeAdvance(ctx, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	debt, err := e.d.Q.BillingDebt(ctx, e.acc)
	if err != nil {
		e.t.Fatal(err)
	}
	if free > 0 && debt > 0 {
		e.t.Fatalf("free advance %d next to debt %d", free, debt)
	}
	var allocBad int
	if err := e.d.Pool.QueryRow(ctx, `SELECT count(*) FROM billing_charges c
		WHERE c.account_id = $1 AND c.amount_minor <> c.unfunded_minor + c.compensated_minor +
			coalesce((SELECT sum(a.amount_minor) FROM billing_allocations a WHERE a.charge_id = c.id), 0)`, e.acc).Scan(&allocBad); err != nil {
		e.t.Fatal(err)
	}
	if allocBad > 0 {
		e.t.Fatalf("%d charges whose allocations + debt + compensation != amount", allocBad)
	}
}

func wantErr(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error %v, want %v", err, want)
	}
}

// apiErr: a domain refusal is an API error (status < 500); anything else is a bug.
func apiErr(err error) bool {
	if err == nil {
		return true
	}
	var he *httpx.Error
	return errors.As(err, &he) && he.Status < 500
}

func timeEq(t *testing.T, name string, got *time.Time, want time.Time) {
	t.Helper()
	if got == nil || !got.Equal(want) {
		t.Fatalf("%s = %v, want %v", name, got, want)
	}
}
