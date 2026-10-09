package core

import (
	"errors"
	"fmt"
	"time"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/billing/money"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Charge reasons (billing_charges.reason).
const (
	ReasonActivate   = "activate"
	ReasonRenew      = "renew"
	ReasonAdmit      = "admit"
	ReasonChangePlan = "change_plan"
	ReasonResume     = "resume"
)

// SKU is the daily seat SKU of a paid plan.
func SKU(plan string) string { return "seat." + plan + ".day" }

// ValidPaidPlan reports a plan an account can buy seats of.
func ValidPaidPlan(plan string) bool { return plan == PlanTeam || plan == PlanEnterprise }

func planRank(plan string) int {
	if plan == PlanEnterprise {
		return 2
	}
	return 1
}

var dayMicros = billing.Day.Microseconds()

// ChargeAmount is the price of qty seats at unit (after discount) for d: a full day is
// unit × qty; a shorter lot (the last one before the debt deadline, M18) is the share of the
// day in microseconds, half up, of the whole amount.
func ChargeAmount(unit int64, qty int32, d time.Duration) (int64, error) {
	full, err := money.MulMinor(unit, int64(qty))
	if err != nil {
		return 0, err
	}
	if d >= billing.Day {
		return full, nil
	}
	return money.Prorate(full, d.Microseconds(), dayMicros)
}

// CompensationTarget is the cumulative compensation of a lot after canceledSeatUs of its
// qty × lot length seat-microseconds were given back: exact rational, half up once on the
// total (ADR-0080 §9), so partial cancellations sum to the same as one.
func CompensationTarget(amount int64, qty int32, lot time.Duration, canceledSeatUs int64) (int64, error) {
	whole, err := money.MulMinor(int64(qty), lot.Microseconds())
	if err != nil {
		return 0, err
	}
	if canceledSeatUs > whole {
		canceledSeatUs = whole
	}
	return money.Prorate(amount, canceledSeatUs, whole)
}

// unitPrice is the per-seat day price of plan at `at` after the account discount.
func (s *state) unitPrice(plan string, at time.Time) (sqlc.BillingPrice, int64, error) {
	p, err := s.q.GetBillingPriceAt(s.ctx, sqlc.GetBillingPriceAtParams{Market: s.acc.Market, Sku: SKU(plan), At: at})
	if db.IsNotFound(err) {
		return p, 0, fmt.Errorf("billing: no price of %s/%s at %s", s.acc.Market, SKU(plan), at.Format(time.RFC3339))
	}
	if err != nil {
		return p, 0, err
	}
	if p.Currency != s.acc.Currency {
		return p, 0, fmt.Errorf("billing: price %s in %s for a %s account", p.ID, p.Currency, s.acc.Currency)
	}
	unit, err := money.ApplyDiscountBps(p.UnitMinor, int(s.acc.DiscountBps))
	return p, unit, err
}

// capacity is the number of seats of plan covering t.
func (s *state) capacity(plan string, t time.Time) (int32, error) {
	return s.q.BillingCapacityAt(s.ctx, sqlc.BillingCapacityAtParams{AccountID: s.acc.ID, Plan: plan, At: t})
}

// billable is the number of paid seats the workspace needs now (members without guests / bots).
func (s *state) billable() (int32, error) {
	if s.acc.WorkspaceID == nil {
		return 0, nil
	}
	return s.q.CountBillableMembers(s.ctx, *s.acc.WorkspaceID)
}

// billableBefore is billable at a past boundary: without the members being admitted now.
func (s *state) billableBefore() (int32, error) {
	n, err := s.billable()
	return max(0, n-s.joining), err
}

// nextEnd is the first end of a lot of the current plan after t (the next renewal boundary).
func (s *state) nextEnd(after time.Time) (*time.Time, error) {
	t, err := s.q.NextBillingChargeEnd(s.ctx, sqlc.NextBillingChargeEndParams{AccountID: s.acc.ID, Plan: s.acc.Plan, After: after})
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ptr(t.UTC()), nil
}

// lastEnd is the end of the coverage of the current plan after t.
func (s *state) lastEnd(after time.Time) (*time.Time, error) {
	t, err := s.q.LastBillingChargeEnd(s.ctx, sqlc.LastBillingChargeEndParams{AccountID: s.acc.ID, Plan: s.acc.Plan, After: after})
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ptr(t.UTC()), nil
}

// buyReq is one seat lot purchase.
type buyReq struct {
	plan       string
	qty        int32
	start, end time.Time
	reason     string
	key        string // billing_charges.business_key
	allowDebt  bool   // renewal of the current team (and a downgrade) may go into debt
	refuse     error  // returned when the free advance does not cover it
}

// buy creates one seat lot funded FIFO from the free advance; the uncovered rest is debt only
// if allowDebt. created=false: the business key existed (replay), nothing changed.
func (s *state) buy(r buyReq) (sqlc.BillingCharge, bool, error) {
	if r.qty <= 0 || !r.end.After(r.start) {
		return sqlc.BillingCharge{}, false, fmt.Errorf("billing: bad purchase %d seats [%s, %s)", r.qty, r.start, r.end)
	}
	if ch, err := s.q.GetBillingChargeByKey(s.ctx, r.key); err == nil {
		return ch, false, nil
	} else if !db.IsNotFound(err) {
		return ch, false, err
	}
	price, unit, err := s.unitPrice(r.plan, r.start)
	if err != nil {
		return sqlc.BillingCharge{}, false, err
	}
	amount, err := ChargeAmount(unit, r.qty, r.end.Sub(r.start))
	if err != nil {
		return sqlc.BillingCharge{}, false, err
	}
	lots, free, err := s.openLots()
	if err != nil {
		return sqlc.BillingCharge{}, false, err
	}
	parts, rest := allocate(free, amount)
	if rest > 0 && !r.allowDebt {
		return sqlc.BillingCharge{}, false, r.refuse
	}
	ch, err := s.q.InsertBillingCharge(s.ctx, sqlc.InsertBillingChargeParams{
		AccountID: s.acc.ID, Sku: SKU(r.plan), Plan: r.plan, PriceID: price.ID, Qty: r.qty, UnitMinor: unit,
		DiscountBps: s.acc.DiscountBps, StartsAt: r.start, EndsAt: r.end, AmountMinor: amount, UnfundedMinor: rest,
		Reason: r.reason, BusinessKey: r.key, ActorID: s.actor,
	})
	if err != nil {
		return ch, false, err
	}
	if err := s.fund(ch.ID, lots, parts); err != nil {
		return ch, false, err
	}
	if err := s.append(KindSeatCharge, -amount, "charge:"+ch.ID.String(), refs{charge: &ch.ID}, r.reason); err != nil {
		return ch, false, err
	}
	s.openEpisode(r.start)
	return ch, true, nil
}

// cancelSeats gives back k seats of a lot from `at` to its end and compensates their unused
// value: the cumulative target minus what was compensated already, taken off the tail of the
// lot's money — its unpaid debt first, then the funding segments latest first, each back to
// its own lot (ADR-0080 §9: admin credit stays admin credit, cash goes back to its payment).
// Returns the compensation written.
func (s *state) cancelSeats(ch sqlc.BillingCharge, k int32, at time.Time, key string) (int64, error) {
	if k <= 0 || k > ch.Qty-ch.CanceledQty {
		return 0, fmt.Errorf("billing: cancel %d of %d seats of %s", k, ch.Qty-ch.CanceledQty, ch.ID)
	}
	if at.Before(ch.StartsAt) {
		at = ch.StartsAt
	}
	remaining := ch.EndsAt.Sub(at)
	if remaining < 0 {
		remaining = 0
	}
	seatUs, err := money.MulMinor(int64(k), remaining.Microseconds())
	if err != nil {
		return 0, err
	}
	total, err := money.AddMinor(ch.CanceledSeatUs, seatUs)
	if err != nil {
		return 0, err
	}
	target, err := CompensationTarget(ch.AmountMinor, ch.Qty, ch.EndsAt.Sub(ch.StartsAt), total)
	if err != nil {
		return 0, err
	}
	delta := max(0, target-ch.CompensatedMinor)
	debt := min(delta, ch.UnfundedMinor)
	rest := delta - debt
	if rest > 0 {
		segs, err := s.q.ListBillingChargeSegments(s.ctx, ch.ID)
		if err != nil {
			return 0, err
		}
		for i := len(segs) - 1; i >= 0 && rest > 0; i-- {
			x := min(rest, segs[i].AmountMinor)
			if _, err := s.q.LockBillingFundingLot(s.ctx, segs[i].LotID); err != nil {
				return 0, err
			}
			if _, err := s.q.InsertBillingAllocation(s.ctx, sqlc.InsertBillingAllocationParams{
				AccountID: s.acc.ID, ChargeID: ch.ID, LotID: segs[i].LotID, AmountMinor: -x,
			}); err != nil {
				return 0, err
			}
			if _, err := s.q.ConsumeBillingFundingLot(s.ctx, sqlc.ConsumeBillingFundingLotParams{Delta: -x, ID: segs[i].LotID}); err != nil {
				return 0, err
			}
			rest -= x
		}
		if rest > 0 {
			return 0, errors.New("billing: charge segments do not cover its compensation")
		}
	}
	if _, err := s.q.CancelBillingChargeSeats(s.ctx, sqlc.CancelBillingChargeSeatsParams{
		Qty: k, SeatUs: seatUs, CompensatedDelta: delta, DebtDelta: debt, ID: ch.ID,
	}); err != nil {
		return 0, err
	}
	if err := s.append(KindCompensation, delta, key, refs{charge: &ch.ID}, "seats returned"); err != nil {
		return 0, err
	}
	return delta, nil
}
