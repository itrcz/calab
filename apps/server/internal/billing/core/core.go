package core

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Account statuses (billing_accounts.status).
const (
	StatusInactive  = "inactive"
	StatusActive    = "active"
	StatusStopped   = "stopped"
	StatusSuspended = "suspended"
	StatusClosed    = "closed"
)

// Paid plans of an account (billing_accounts.plan) and the Free plan billing gives a stopped
// account (workspace_plans.plan).
const (
	PlanTeam       = "team"
	PlanEnterprise = "enterprise" // «Business»
	PlanFree       = "free"
)

// DebtWindow is the time from the first negative balance to the suspension (ADR-0080 §8).
const DebtWindow = 7 * billing.Day

// MaxCatchUpSteps bounds the renewals one transaction applies. An account further behind (a
// worker down for months) is caught up by the worker over several transactions; meanwhile
// spending actions answer billing.ErrReconciling.
const MaxCatchUpSteps = 64

// Errors of the core that are not shared in package billing.
var (
	// ErrCreditAlreadyReversed: a manual credit is reversed once.
	ErrCreditAlreadyReversed = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_CONFLICT,
		"manual credit already reversed").WithDetails(billing.ReasonManualCreditAlreadyReverse, 0, 0)
	// errDuplicateEntry: a ledger business key exists although the command did not see its
	// idempotency key: a bug, so the whole command rolls back.
	errDuplicateEntry = errors.New("billing core: duplicate ledger business key")
)

// Config is the part of config.Billing the core obeys (kill switches).
type Config struct {
	// Debits (BILLING_DEBITS_ENABLED): seat charges and renewals run. Off: admission passes
	// without a charge, activation / plan change / paid resume answer billing.ErrDisabled.
	Debits bool
	// Enforcement (BILLING_ENFORCEMENT_ENABLED): seat growth needs free advance and the debt
	// deadline suspends. Off: growth may go into debt and nobody is suspended (shadow mode).
	Enforcement bool
}

// Hooks connect the core to the packages it must not import.
type Hooks struct {
	// PlanChanged runs inside the transaction right after the core wrote workspace_plans
	// (source = billing) for workspaceID, while the account is locked. It must not lock
	// workspace rows (lock order: workspace → account): the identity grants of the plan and
	// auth.InvalidateIdentity run after the commit instead (app wiring, Committed).
	PlanChanged func(ctx context.Context, q *sqlc.Queries, workspaceID uuid.UUID, plan string) error
	// Committed runs after the commit of a command the core ran in its own transaction:
	// plans.Invalidate, WORKSPACE_UPDATE / BILLING_UPDATE (T5). planChanged reports a new
	// workspace_plans row. Commands run inside a caller's transaction never call it; their
	// caller does that after its own commit.
	Committed func(ctx context.Context, acc sqlc.BillingAccount, planChanged bool)
}

// Core is the money core of balance billing: the only writer of balances, lots and charges.
type Core struct {
	db    *db.DB
	clock billing.Clock
	cfg   Config
	hooks Hooks
}

// New creates the core. clock is billing.DBClock in production.
func New(d *db.DB, clock billing.Clock, cfg Config, hooks Hooks) *Core {
	return &Core{db: d, clock: clock, cfg: cfg, hooks: hooks}
}

var _ billing.Seats = (*Core)(nil)

// state is one command on one locked account.
type state struct {
	c     *Core
	ctx   context.Context
	q     *sqlc.Queries
	acc   sqlc.BillingAccount
	now   time.Time
	actor *uuid.UUID
	rev0  int64 // revision when locked: Committed runs only if it moved
	// joining: members already written by the caller's transaction but not billable before
	// now (Admit catches up past boundaries without them).
	joining     int32
	dirty       bool // status / plan / episode / schedule changed: save before commit
	planChanged bool
}

// lock takes the account lock and the decision time (after the lock, ADR-0080 §10).
func (c *Core) lock(ctx context.Context, q *sqlc.Queries, accountID uuid.UUID, actor *uuid.UUID) (*state, error) {
	acc, err := q.LockBillingAccount(ctx, accountID)
	if db.IsNotFound(err) {
		return nil, billing.ErrAccountNotFound
	}
	if err != nil {
		return nil, err
	}
	return c.stateOf(ctx, q, acc, actor)
}

func (c *Core) stateOf(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, actor *uuid.UUID) (*state, error) {
	now, err := c.clock.Now(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("billing clock: %w", err)
	}
	return &state{c: c, ctx: ctx, q: q, acc: acc, now: now.UTC(), actor: actor, rev0: acc.Revision}, nil
}

// run executes fn as one transaction on the locked account; the whole command rolls back on
// any error. Committed runs after the commit.
func (c *Core) run(ctx context.Context, accountID uuid.UUID, actor *uuid.UUID, fn func(s *state) error) (sqlc.BillingAccount, error) {
	var s *state
	err := c.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if s, err = c.lock(ctx, q, accountID, actor); err != nil {
			return err
		}
		if err := fn(s); err != nil {
			return err
		}
		return s.save()
	})
	if err != nil {
		return sqlc.BillingAccount{}, err
	}
	c.committed(ctx, s)
	return s.acc, nil
}

// runOn is run for a command addressed by a dependent row: find reads the account id
// without locking anything (lock order: account first, then its rows).
func (c *Core) runOn(ctx context.Context, actor *uuid.UUID, find func(q *sqlc.Queries) (uuid.UUID, error), fn func(s *state) error) (sqlc.BillingAccount, error) {
	var s *state
	err := c.db.Tx(ctx, func(q *sqlc.Queries) error {
		id, err := find(q)
		if err != nil {
			return err
		}
		if s, err = c.lock(ctx, q, id, actor); err != nil {
			return err
		}
		if err := fn(s); err != nil {
			return err
		}
		return s.save()
	})
	if err != nil {
		return sqlc.BillingAccount{}, err
	}
	c.committed(ctx, s)
	return s.acc, nil
}

func (c *Core) committed(ctx context.Context, s *state) {
	if s != nil && c.hooks.Committed != nil && (s.acc.Revision != s.rev0 || s.planChanged) {
		c.hooks.Committed(ctx, s.acc, s.planChanged)
	}
}

// save writes status, plan, debt episode and schedule if they changed, then syncs the plan.
func (s *state) save() error {
	if !s.dirty {
		return nil
	}
	acc, err := s.q.UpdateBillingAccountState(s.ctx, sqlc.UpdateBillingAccountStateParams{
		Status: s.acc.Status, Plan: s.acc.Plan, NegativeSince: s.acc.NegativeSince, SuspendAt: s.acc.SuspendAt,
		NextDueAt: s.acc.NextDueAt, Now: s.now, ID: s.acc.ID,
	})
	if err != nil {
		return err
	}
	s.acc, s.dirty = acc, false
	return s.syncPlan()
}

func (s *state) setStatus(status string) {
	if s.acc.Status != status {
		s.acc.Status, s.dirty = status, true
	}
}

func (s *state) setNextDue(t *time.Time) {
	if !sameTime(s.acc.NextDueAt, t) {
		s.acc.NextDueAt, s.dirty = t, true
	}
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

// held: an incident hold freezes debits and suspension (renewals, seat purchases).
func (s *state) held() bool {
	return s.acc.HoldUntil != nil && s.acc.HoldUntil.After(s.now)
}

// openEpisode records the first negative balance at `at` once (ADR-0080 §8).
func (s *state) openEpisode(at time.Time) {
	if s.acc.BalanceMinor >= 0 || s.acc.NegativeSince != nil {
		return
	}
	ns, sa := at.UTC(), at.UTC().Add(DebtWindow)
	s.acc.NegativeSince, s.acc.SuspendAt, s.dirty = &ns, &sa, true
}

// closeEpisodeIfPaid ends the debt episode once every due charge is applied and the balance
// is not negative. A suspended account keeps it until Resume.
func (s *state) closeEpisodeIfPaid() {
	if s.acc.NegativeSince == nil || s.acc.BalanceMinor < 0 || s.acc.Status == StatusSuspended {
		return
	}
	s.acc.NegativeSince, s.acc.SuspendAt, s.dirty = nil, nil, true
}

func (s *state) clearEpisode() {
	if s.acc.NegativeSince != nil {
		s.acc.NegativeSince, s.acc.SuspendAt, s.dirty = nil, nil, true
	}
}

func ptr[T any](v T) *T { return &v }
