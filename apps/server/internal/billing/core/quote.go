package core

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// ReserveDays is the horizon of the reserve and of the auto-topup amount (ADR-0080 §7).
const ReserveDays = 30

// Quote is the money picture of an account for one plan, in minor units of Currency.
type Quote struct {
	Status        string
	Plan          string
	Currency      string
	PriceID       uuid.UUID
	Billable      int32 // members to pay for (no guests, no bots)
	Covered       int32 // seats of Plan covering now
	UnitMinor     int64 // per seat per day after the discount
	DailyMinor    int64 // Billable × UnitMinor
	BalanceMinor  int64 // signed
	DebtMinor     int64 // max(0, -balance)
	FreeMinor     int64 // unused money on the funding lots
	FirstDayMinor int64 // first day of the uncovered members (activation / resume paid)
	// ResumePaidMinor = debt + first day (M17); ActivateMinor is the same for an account
	// without debt.
	ResumePaidMinor int64
	Reserve30dMinor int64 // 30 × daily (M7)
	// AutoTopupMinor = debt + reserve30d: the auto-topup amount A (M11, T7).
	AutoTopupMinor int64
	// DaysLeft: whole days the positive balance pays at the daily cost (0 without balance).
	DaysLeft  int64
	NextDueAt *time.Time
	SuspendAt *time.Time
}

// QuoteInput are the facts a quote is computed from.
type QuoteInput struct {
	Status, Plan, Currency string
	PriceID                uuid.UUID
	Billable, Covered      int32
	UnitMinor              int64
	BalanceMinor           int64
	FreeMinor              int64
	NextDueAt, SuspendAt   *time.Time
}

// ComputeQuote is the pure arithmetic of a quote.
func ComputeQuote(in QuoteInput) (Quote, error) {
	q := Quote{Status: in.Status, Plan: in.Plan, Currency: in.Currency, PriceID: in.PriceID, Billable: in.Billable,
		Covered: in.Covered, UnitMinor: in.UnitMinor, BalanceMinor: in.BalanceMinor, FreeMinor: in.FreeMinor,
		NextDueAt: in.NextDueAt, SuspendAt: in.SuspendAt}
	var err error
	if q.DailyMinor, err = money.MulMinor(in.UnitMinor, int64(in.Billable)); err != nil {
		return q, err
	}
	if q.FirstDayMinor, err = money.MulMinor(in.UnitMinor, int64(max(0, in.Billable-in.Covered))); err != nil {
		return q, err
	}
	if in.BalanceMinor < 0 {
		q.DebtMinor = -in.BalanceMinor
	}
	if q.ResumePaidMinor, err = money.AddMinor(q.DebtMinor, q.FirstDayMinor); err != nil {
		return q, err
	}
	if q.Reserve30dMinor, err = money.MulMinor(q.DailyMinor, ReserveDays); err != nil {
		return q, err
	}
	if q.AutoTopupMinor, err = money.AddMinor(q.DebtMinor, q.Reserve30dMinor); err != nil {
		return q, err
	}
	if in.BalanceMinor > 0 && q.DailyMinor > 0 {
		q.DaysLeft = in.BalanceMinor / q.DailyMinor
	}
	return q, nil
}

// Quote applies what is due (the before-action catch-up, so the numbers are not stale) and
// returns the quote of plan ("" = the account's plan). It is a write transaction; with
// Config.Debits off nothing is applied.
func (c *Core) Quote(ctx context.Context, accountID uuid.UUID, plan string) (Quote, error) {
	var out Quote
	_, err := c.run(ctx, accountID, nil, func(s *state) error {
		if _, err := s.catchUp(s.now); err != nil {
			return err
		}
		var err error
		out, err = s.quote(plan)
		return err
	})
	return out, err
}

// QuoteIn is Quote inside the caller's transaction on an account it locked (no catch-up).
func (c *Core) QuoteIn(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, plan string) (Quote, error) {
	s, err := c.stateOf(ctx, q, acc, nil)
	if err != nil {
		return Quote{}, err
	}
	return s.quote(plan)
}

func (s *state) quote(plan string) (Quote, error) {
	if plan == "" {
		plan = s.acc.Plan
	}
	// The custom plan is quoted only as the account's own (its price versions are the account's).
	if !ValidPaidPlan(plan) && (plan != PlanCustom || s.acc.Plan != PlanCustom) {
		return Quote{}, badPlan()
	}
	price, unit, _, err := s.unitPrice(plan, s.now)
	if err != nil {
		return Quote{}, err
	}
	n, err := s.billable()
	if err != nil {
		return Quote{}, err
	}
	covered := int32(0)
	if s.acc.Status == StatusActive || s.acc.Status == StatusStopped {
		if covered, err = s.capacity(plan, s.now); err != nil {
			return Quote{}, err
		}
	}
	free, err := s.freeAdvance()
	if err != nil {
		return Quote{}, err
	}
	return ComputeQuote(QuoteInput{Status: s.acc.Status, Plan: plan, Currency: s.acc.Currency, PriceID: price.ID,
		Billable: n, Covered: covered, UnitMinor: unit, BalanceMinor: s.acc.BalanceMinor, FreeMinor: free,
		NextDueAt: s.acc.NextDueAt, SuspendAt: s.acc.SuspendAt})
}
