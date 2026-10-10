package core

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// The custom plan of an account (ADR-0086 «Индивидуальный тариф»): a superadmin gives the
// workspace its own limits, name and price per seat per day in the account currency. Seats are
// bought and renewed exactly like Team / Business, at the account's own price versions
// (billing_prices.account_id) instead of the market catalog, and without the account discount:
// the custom price is final. Price versions are append-only and start at effective_from >= now,
// so seat-days already bought keep their price and the past is never repriced; the newest version
// whose effective_from has come applies (CustomPriceAt). Self-serve changes of a custom plan are
// refused (plans.CheckTransition: BILLING_PLAN_ADMIN_ASSIGNED); top-ups and auto-topup work.

// MaxCustomAhead bounds how far ahead a custom price version may start.
const MaxCustomAhead = 365 * billing.Day

// customUnitCap is the highest custom price per seat per 24 h by currency: $100 / 10 000 ₽, a
// thousand times the catalog Team day — a typo guard, not a business limit.
var customUnitCap = map[string]int64{"USD": 10_000, "RUB": 1_000_000}

// CustomUnitCap is the highest custom price per seat per day in currency (0: unknown currency).
func CustomUnitCap(currency string) int64 { return customUnitCap[currency] }

// AssignPlan is a superadmin's plan assignment of an account.
type AssignPlan struct {
	Plan string // team | enterprise | custom
	// Custom: the custom plan's definition (required for custom; written to workspace_plans).
	Custom *CustomPlan
	// Unit: custom price per seat per day (0 = keep the price versions; required when the account
	// is not on its custom plan yet). From: its effective_from (zero = now; never in the past,
	// at most MaxCustomAhead ahead; the first custom price of an assignment starts now).
	Unit int64
	From time.Time
	// RequestID makes the seat purchase key of the switch (the admin command is idempotent by it).
	RequestID uuid.UUID
	// Note is the plan log note (the superadmin's reason, overridden limits).
	Note string
}

// AssignResult is what an assignment did.
type AssignResult struct {
	Price       *sqlc.BillingPrice // the custom price version written, if any
	Charged     int64              // seat-days bought now
	Compensated int64              // the rest of the previous plan's lots back on the balance
	Switched    bool               // the account moved to the plan now (or started on it)
}

// AssignPlanIn puts the locked account on a plan a superadmin chose, inside the caller's
// transaction (the admin command writes its audit row in it; preview = rollback). No Committed
// hook: the caller runs it after its commit. Usage limits are the caller's check (plans).
//
//   - custom, not on it yet: a price is required and starts now; an active account switches at
//     once like ChangePlan (the rest of its lots is compensated, a full day of every billable
//     member is bought at the custom price; a dearer day needs no debt and free advance, a
//     cheaper one may use the open debt window); an inactive or stopped one starts like Activate
//     (first day from the free advance, never into debt).
//   - custom, already on it: the definition applies now; a new price is a new version from From.
//   - team / enterprise: an active account switches like above; an inactive or stopped one only
//     gets the plan its owner activates next.
func (c *Core) AssignPlanIn(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, a AssignPlan, actor *uuid.UUID) (sqlc.BillingAccount, AssignResult, error) {
	var res AssignResult
	if a.Plan != PlanCustom && !ValidPaidPlan(a.Plan) {
		return acc, res, httpx.Validation("plan", "plan must be team, enterprise or custom")
	}
	if a.Plan == PlanCustom && a.Custom == nil {
		return acc, res, httpx.Validation("limits", "the custom plan needs its limits")
	}
	s, err := c.stateOf(ctx, q, acc, actor)
	if err != nil {
		return acc, res, err
	}
	switch s.acc.Status {
	case StatusClosed:
		return acc, res, billing.ErrAccountNotFound
	case StatusSuspended:
		return acc, res, billing.ErrWorkspaceBillingSuspended
	}
	done, err := s.catchUp(s.now)
	if err != nil {
		return acc, res, err
	}
	if !done {
		return acc, res, billing.ErrReconciling
	}
	if s.acc.Status == StatusSuspended {
		return acc, res, billing.ErrWorkspaceBillingSuspended
	}
	s.custom, s.planNote = a.Custom, a.Note
	key := "admin_plan:" + s.acc.ID.String() + ":" + a.RequestID.String()
	before := s.acc.BalanceMinor
	if a.Plan == PlanCustom {
		entering := s.acc.Plan != PlanCustom || s.acc.Status != StatusActive
		if res.Price, err = s.customPrice(a, entering); err != nil {
			return acc, res, err
		}
		if entering {
			if res.Compensated, err = s.switchTo(PlanCustom, key); err != nil {
				return acc, res, err
			}
			res.Switched = true
		}
	} else if s.acc.Plan != a.Plan || s.acc.Status != StatusActive {
		switch {
		case s.acc.Status == StatusActive:
			if res.Compensated, err = s.switchTo(a.Plan, key); err != nil {
				return acc, res, err
			}
			res.Switched = true
		case s.acc.NextDueAt != nil:
			// A stopped account with paid days running keeps their plan until they end.
			return acc, res, billing.ErrChangeIncompatible
		default:
			s.acc.Plan = a.Plan // inactive / stopped: what the owner activates next
		}
	}
	res.Charged = max(0, before+res.Compensated-s.acc.BalanceMinor)
	s.dirty = true // always: the revision moves and the plan row / log record the assignment
	if err := s.save(); err != nil {
		return acc, res, err
	}
	return s.acc, res, nil
}

// customPrice validates a.Unit / a.From and writes the new custom price version (nil: none
// needed — no unit given, or the same unit already applies from From with nothing after it).
func (s *state) customPrice(a AssignPlan, entering bool) (*sqlc.BillingPrice, error) {
	if a.Unit == 0 {
		if entering {
			return nil, httpx.Validation("unit", "a price per seat per day is required to put the account on its custom plan")
		}
		return nil, nil
	}
	if limit := CustomUnitCap(s.acc.Currency); a.Unit < 0 || limit == 0 || a.Unit > limit {
		return nil, httpx.Validation("unit", "the price per seat per day must be positive and at most the currency's cap")
	}
	from := a.From.UTC()
	if from.IsZero() {
		from = s.now
	}
	switch {
	case from.Before(s.now):
		return nil, httpx.Validation("effectiveFrom", "effective_from must not be in the past: bought seat-days keep their price")
	case from.After(s.now.Add(MaxCustomAhead)):
		return nil, httpx.Validation("effectiveFrom", "effective_from must be within 365 days")
	case entering && from.After(s.now):
		return nil, httpx.Validation("effectiveFrom", "the first custom price starts now")
	}
	versions, err := s.q.ListBillingCustomPrices(s.ctx, &s.acc.ID)
	if err != nil {
		return nil, err
	}
	if len(versions) > 0 {
		if cur, ok := CustomPriceAt(versions, from); ok && cur.ID == versions[0].ID && cur.UnitMinor == a.Unit {
			return nil, nil // the same price applies from then on already
		}
	}
	p, err := s.q.InsertBillingCustomPrice(s.ctx, sqlc.InsertBillingCustomPriceParams{
		Market: s.acc.Market, Currency: s.acc.Currency, UnitMinor: a.Unit, EffectiveFrom: from, CreatedBy: s.actor,
		AccountID: &s.acc.ID,
	})
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// switchTo moves the locked account to plan now and returns the compensation. Active: the rest
// of the current lots back on the balance, then a full day of every billable member on plan — a
// dearer day (by the unit price now) needs no debt and enough free advance, a cheaper one may
// use the open debt window (cut at its deadline). Inactive / stopped: started like Activate.
func (s *state) switchTo(plan, key string) (int64, error) {
	if !s.c.cfg.Debits {
		return 0, billing.ErrDisabled
	}
	if s.acc.Status != StatusActive {
		if s.acc.BalanceMinor < 0 {
			return 0, billing.ErrInsufficientFunds
		}
		var comp int64
		if s.acc.Status == StatusStopped && s.acc.Plan != plan {
			var err error
			if comp, err = s.cancelAll(s.acc.Plan, key+":comp"); err != nil {
				return 0, err
			}
			if err := s.normalize(); err != nil {
				return 0, err
			}
		}
		return comp, s.startPaid(plan, ReasonActivate, key)
	}
	_, oldUnit, _, err := s.unitPrice(s.acc.Plan, s.now)
	if err != nil {
		return 0, err
	}
	_, newUnit, _, err := s.unitPrice(plan, s.now)
	if err != nil {
		return 0, err
	}
	dearer := newUnit > oldUnit
	if dearer && (s.acc.BalanceMinor < 0 || s.acc.NegativeSince != nil) {
		return 0, billing.ErrChangeIncompatible
	}
	comp, err := s.cancelAll(s.acc.Plan, key+":comp")
	if err != nil {
		return 0, err
	}
	if err := s.normalize(); err != nil {
		return 0, err
	}
	s.acc.Plan, s.dirty = plan, true
	n, err := s.billable()
	if err != nil {
		return 0, err
	}
	end := s.now.Add(billing.Day)
	if sa := s.acc.SuspendAt; !dearer && sa != nil && sa.After(s.now) && end.After(*sa) {
		end = *sa
	}
	if n > 0 {
		if _, _, err := s.buy(buyReq{plan: plan, qty: n, start: s.now, end: end, reason: ReasonChangePlan, key: key,
			allowDebt: !dearer, refuse: billing.ErrInsufficientFunds}); err != nil {
			return 0, err
		}
	}
	s.closeEpisodeIfPaid()
	next, err := s.nextEnd(s.now)
	if err != nil {
		return 0, err
	}
	s.setNextDue(next)
	return comp, nil
}

// CustomPriceAt is the custom price version in effect at t among versions (any order): the
// newest one (created_at, then id) whose effective_from is at or before t — the rule of
// GetBillingCustomPriceAt. A version therefore replaces whatever was scheduled after its start.
func CustomPriceAt(versions []sqlc.BillingPrice, t time.Time) (sqlc.BillingPrice, bool) {
	var best sqlc.BillingPrice
	ok := false
	for _, v := range versions {
		if v.EffectiveFrom.After(t) {
			continue
		}
		if !ok || newer(v, best) {
			best, ok = v, true
		}
	}
	return best, ok
}

func newer(a, b sqlc.BillingPrice) bool {
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.After(b.CreatedAt)
	}
	return a.ID.String() > b.ID.String()
}

// NextCustomPrice is the first change of the custom price after now: the version and when it
// starts applying (ok=false: none scheduled).
func NextCustomPrice(versions []sqlc.BillingPrice, now time.Time) (sqlc.BillingPrice, time.Time, bool) {
	cur, hasCur := CustomPriceAt(versions, now)
	var starts []time.Time
	for _, v := range versions {
		if v.EffectiveFrom.After(now) {
			starts = append(starts, v.EffectiveFrom)
		}
	}
	sort.Slice(starts, func(i, j int) bool { return starts[i].Before(starts[j]) })
	for _, t := range starts {
		if p, ok := CustomPriceAt(versions, t); ok && (!hasCur || p.ID != cur.ID) {
			return p, t, true
		}
	}
	return sqlc.BillingPrice{}, time.Time{}, false
}

// NextPriceIn is the next price change of the account's plan after now, per seat per day as the
// account will pay it (catalog: after the account discount): unit and start, ok=false if none.
func (c *Core) NextPriceIn(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, now time.Time) (int64, time.Time, bool, error) {
	if acc.Plan == PlanCustom {
		versions, err := q.ListBillingCustomPrices(ctx, &acc.ID)
		if err != nil {
			return 0, time.Time{}, false, err
		}
		p, at, ok := NextCustomPrice(versions, now)
		return p.UnitMinor, at, ok, nil
	}
	p, err := q.GetNextBillingPriceAfter(ctx, sqlc.GetNextBillingPriceAfterParams{Market: acc.Market, Sku: SKU(acc.Plan), After: now})
	if db.IsNotFound(err) {
		return 0, time.Time{}, false, nil
	}
	if err != nil {
		return 0, time.Time{}, false, err
	}
	unit, err := money.ApplyDiscountBps(p.UnitMinor, int(acc.DiscountBps))
	return unit, p.EffectiveFrom, err == nil, err
}
