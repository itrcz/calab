package core

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Markets and their fixed currency (an account never changes currency, no FX).
var marketCurrency = map[string]string{"global": "USD", "ru": "RUB"}

// EnableAccount (superadmin) creates the inactive billing account of a workspace: nothing is
// charged until the owner activates it. billing.ErrAccountExists if a live account exists.
func (c *Core) EnableAccount(ctx context.Context, workspaceID uuid.UUID, market, provider string, actor *uuid.UUID) (sqlc.BillingAccount, error) {
	cur, ok := marketCurrency[market]
	if !ok {
		return sqlc.BillingAccount{}, httpx.Validation("market", "market must be global or ru")
	}
	if provider == "" {
		return sqlc.BillingAccount{}, httpx.Validation("provider", "provider required")
	}
	var acc sqlc.BillingAccount
	err := c.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.GetLiveBillingAccountByWorkspace(ctx, &workspaceID); err == nil {
			return billing.ErrAccountExists
		} else if !db.IsNotFound(err) {
			return err
		}
		var err error
		acc, err = q.InsertBillingAccount(ctx, sqlc.InsertBillingAccountParams{
			WorkspaceID: &workspaceID, Market: market, Currency: cur, Provider: provider, Plan: PlanTeam, CreatedBy: actor,
		})
		if db.UniqueViolation(err) == "billing_accounts_workspace_live_idx" {
			return billing.ErrAccountExists
		}
		return err
	})
	return acc, err
}

// MarketCurrency is the fixed currency of a market ("" for an unknown market).
func MarketCurrency(market string) string { return marketCurrency[market] }

// SwitchMarket moves an account that has no money yet to another market (ADR-0083): the owner's
// pre-payment choice (quote ACTIVATE with a market) and the superadmin's change. The market is
// fixed by the first money — a ledger entry, any payment row or an open checkout — or a custom
// price version (its currency is the account's, ADR-0086), checked under
// the account lock, so a checkout opened concurrently either commits first (the switch is
// refused) or sees the new market (POST …/topups re-validates under the same lock).
// expectedRevision 0 skips the revision check. Switching to the current market is a no-op.
func (c *Core) SwitchMarket(ctx context.Context, accountID uuid.UUID, market, provider string, expectedRevision int64, actor *uuid.UUID) (sqlc.BillingAccount, error) {
	return c.run(ctx, accountID, actor, func(s *state) error {
		if expectedRevision != 0 && s.acc.Revision != expectedRevision {
			return billing.ErrRevisionConflict
		}
		acc, err := c.SwitchMarketIn(ctx, s.q, s.acc, market, provider, s.now)
		if err != nil {
			return err
		}
		s.acc = acc
		return nil
	})
}

// SwitchMarketIn is SwitchMarket inside the caller's transaction on an account it locked (the
// admin command writes its audit row in the same transaction). No Committed hook: the caller
// runs it after its commit.
func (c *Core) SwitchMarketIn(ctx context.Context, q *sqlc.Queries, acc sqlc.BillingAccount, market, provider string, now time.Time) (sqlc.BillingAccount, error) {
	cur, ok := marketCurrency[market]
	if !ok {
		return acc, httpx.Validation("market", "market must be global or ru")
	}
	if provider == "" {
		return acc, billing.ErrMarketUnavailable
	}
	if acc.Market == market && acc.Provider == provider {
		return acc, nil
	}
	if acc.Status != StatusInactive && acc.Status != StatusStopped {
		return acc, billing.ErrMarketFixed
	}
	fixed, err := q.BillingAccountMarketFixed(ctx, acc.ID)
	if err != nil {
		return acc, err
	}
	if fixed {
		return acc, billing.ErrMarketFixed
	}
	out, err := q.SwitchBillingAccountMarket(ctx, sqlc.SwitchBillingAccountMarketParams{
		Market: market, Currency: cur, Provider: provider, Now: now, ID: acc.ID,
	})
	if db.IsNotFound(err) {
		return acc, billing.ErrMarketFixed
	}
	return out, err
}

func badPlan() error {
	return httpx.Validation("plan", "plan must be team or enterprise")
}

// Activate starts the paid plan (inactive or stopped account): the first day of every
// billable member not covered yet is bought from the free advance — never into debt
// (billing.ErrInsufficientFunds; M1, M5). A replay of an active account on the same plan
// returns it unchanged.
func (c *Core) Activate(ctx context.Context, accountID uuid.UUID, plan string, requestID uuid.UUID, actor *uuid.UUID) (sqlc.BillingAccount, error) {
	if !ValidPaidPlan(plan) {
		return sqlc.BillingAccount{}, badPlan()
	}
	return c.runGuarded(ctx, accountID, actor, func(s *state) error {
		switch s.acc.Status {
		case StatusActive:
			if s.acc.Plan == plan {
				return nil
			}
			return billing.ErrChangeIncompatible
		case StatusSuspended:
			return billing.ErrWorkspaceBillingSuspended
		case StatusClosed:
			return billing.ErrAccountNotFound
		}
		if !s.c.cfg.Debits {
			return billing.ErrDisabled
		}
		if _, err := s.catchUp(s.now); err != nil {
			return err
		}
		if s.acc.Status == StatusSuspended {
			return billing.ErrWorkspaceBillingSuspended
		}
		if err := s.guard(plan); err != nil {
			return err
		}
		if s.acc.BalanceMinor < 0 {
			return billing.ErrInsufficientFunds
		}
		key := "activate:" + s.acc.ID.String() + ":" + requestID.String()
		if s.acc.Status == StatusStopped && s.acc.Plan != plan {
			// Restarting a stopped account on another plan: the stopped plan's running lots
			// end now and their unused rest goes back to the balance (as ChangePlan does), so
			// the overlap is not paid twice.
			if _, err := s.cancelAll(s.acc.Plan, key+":comp"); err != nil {
				return err
			}
			if err := s.normalize(); err != nil {
				return err
			}
		}
		return s.startPaid(plan, ReasonActivate, key)
	})
}

// startPaid buys the first day of the uncovered billable members on plan and makes the
// account active.
func (s *state) startPaid(plan, reason, key string) error {
	if s.acc.Plan != plan {
		s.acc.Plan, s.dirty = plan, true
	}
	n, err := s.billable()
	if err != nil {
		return err
	}
	covered, err := s.capacity(plan, s.now)
	if err != nil {
		return err
	}
	if need := n - covered; need > 0 {
		if _, _, err := s.buy(buyReq{plan: plan, qty: need, start: s.now, end: s.now.Add(billing.Day), reason: reason,
			key: key, refuse: billing.ErrInsufficientFunds}); err != nil {
			return err
		}
	}
	s.setStatus(StatusActive)
	s.clearEpisodeIfPaid()
	next, err := s.nextEnd(s.now)
	if err != nil {
		return err
	}
	s.setNextDue(next)
	return nil
}

// clearEpisodeIfPaid closes the episode on a start: a new paid start needs a non-negative
// balance, which ends the episode (ADR-0080 §8).
func (s *state) clearEpisodeIfPaid() {
	if s.acc.BalanceMinor >= 0 {
		s.clearEpisode()
	}
}

// Stop ends the paid plan: no new charges or renewals; the running lots stay until their end
// (the workspace keeps the paid plan until then; after that Free if it fits Free, else the
// restricted mode — ADR-0086 amendment, owner 10.10: stopping is always allowed). Debt and its
// deadline stay. Stopping a stopped account is a no-op.
func (c *Core) Stop(ctx context.Context, accountID uuid.UUID, actor *uuid.UUID) (sqlc.BillingAccount, error) {
	return c.runGuarded(ctx, accountID, actor, func(s *state) error {
		switch s.acc.Status {
		case StatusStopped:
			return nil
		case StatusActive:
		case StatusSuspended:
			return billing.ErrWorkspaceBillingSuspended
		default:
			return billing.ErrChangeIncompatible
		}
		// A custom plan is the superadmin's assignment (ADR-0086 «Дополнение»): the owner does not
		// stop it; stopping is always allowed for the standard paid plans only.
		if s.acc.Plan == PlanCustom {
			return billing.ErrPlanAdminAssigned
		}
		done, err := s.catchUp(s.now)
		if err != nil {
			return err
		}
		if !done {
			return billing.ErrReconciling
		}
		if s.acc.Status != StatusActive {
			return nil // suspended at the deadline just now
		}
		s.setStatus(StatusStopped)
		end, err := s.lastEnd(s.now)
		if err != nil {
			return err
		}
		s.setNextDue(end)
		return s.settleFree(s.now) // no paid days left: Free or the restricted mode at once
	})
}

// ChangePlan switches an active account to another paid plan at once: the remaining part of
// the current plan's lots is compensated to the balance (each lot's unused share back to its
// own money sources) and a full day of the new plan for every billable member is bought in the
// same transaction. An upgrade needs no debt and enough free advance
// (billing.ErrChangeIncompatible / ErrInsufficientFunds); a downgrade may use the open debt
// window.
func (c *Core) ChangePlan(ctx context.Context, accountID uuid.UUID, plan string, requestID uuid.UUID, actor *uuid.UUID) (sqlc.BillingAccount, error) {
	if !ValidPaidPlan(plan) {
		return sqlc.BillingAccount{}, badPlan()
	}
	return c.runGuarded(ctx, accountID, actor, func(s *state) error {
		if s.acc.Status == StatusSuspended {
			return billing.ErrWorkspaceBillingSuspended
		}
		if s.acc.Status != StatusActive {
			return billing.ErrChangeIncompatible
		}
		if !s.c.cfg.Debits {
			return billing.ErrDisabled
		}
		key := "change_plan:" + s.acc.ID.String() + ":" + requestID.String()
		if _, err := s.q.GetBillingChargeByKey(s.ctx, key); err == nil {
			return nil // replay
		} else if !db.IsNotFound(err) {
			return err
		}
		done, err := s.catchUp(s.now)
		if err != nil {
			return err
		}
		if !done {
			return billing.ErrReconciling
		}
		if s.acc.Status == StatusSuspended {
			return billing.ErrWorkspaceBillingSuspended
		}
		if s.acc.Plan == plan {
			return nil
		}
		if err := s.guard(plan); err != nil {
			return err
		}
		upgrade := planRank(plan) > planRank(s.acc.Plan)
		if upgrade && (s.acc.BalanceMinor < 0 || s.acc.NegativeSince != nil) {
			return billing.ErrChangeIncompatible
		}
		if _, err := s.cancelAll(s.acc.Plan, key+":comp"); err != nil {
			return err
		}
		if err := s.normalize(); err != nil {
			return err
		}
		s.acc.Plan, s.dirty = plan, true
		n, err := s.billable()
		if err != nil {
			return err
		}
		end := s.now.Add(billing.Day)
		if sa := s.acc.SuspendAt; !upgrade && sa != nil && sa.After(s.now) && end.After(*sa) {
			end = *sa
		}
		if n > 0 {
			if _, _, err := s.buy(buyReq{plan: plan, qty: n, start: s.now, end: end, reason: ReasonChangePlan, key: key,
				allowDebt: !upgrade, refuse: billing.ErrInsufficientFunds}); err != nil {
				return err
			}
		}
		s.closeEpisodeIfPaid()
		next, err := s.nextEnd(s.now)
		if err != nil {
			return err
		}
		s.setNextDue(next)
		return nil
	})
}

// cancelAll gives back every remaining seat of plan's lots at now. Ledger keys are
// key:0, key:1, … in lot order.
func (s *state) cancelAll(plan, key string) (int64, error) {
	lots, err := s.q.LockBillingChargesCoveringAt(s.ctx, sqlc.LockBillingChargesCoveringAtParams{AccountID: s.acc.ID, Plan: plan, At: s.now})
	if err != nil {
		return 0, err
	}
	var total int64
	for i, ch := range lots {
		d, err := s.cancelSeats(ch, ch.Qty-ch.CanceledQty, s.now, key+":"+strconv.Itoa(i))
		if err != nil {
			return 0, err
		}
		total += d
	}
	return total, nil
}

// CancelSeats gives back qty unused seats of the current plan from now on (an explicit
// request to stop paying for idle seats, M10): the longest-living lots first, compensation to
// the balance from each lot's own money tail. An active account keeps at least the seats of
// its current billable members (billing.ErrChangeIncompatible). A replay of requestID is a
// no-op. Returns the compensation.
func (c *Core) CancelSeats(ctx context.Context, accountID uuid.UUID, qty int32, requestID uuid.UUID, actor *uuid.UUID) (int64, error) {
	if qty <= 0 {
		return 0, httpx.Validation("qty", "qty must be positive")
	}
	var total int64
	_, err := c.run(ctx, accountID, actor, func(s *state) error {
		key := "cancel:" + s.acc.ID.String() + ":" + requestID.String()
		if ok, err := s.entryExists(key + ":0"); err != nil || ok {
			return err
		}
		if s.acc.Status != StatusActive && s.acc.Status != StatusStopped {
			return billing.ErrChangeIncompatible
		}
		done, err := s.catchUp(s.now)
		if err != nil {
			return err
		}
		if !done {
			return billing.ErrReconciling
		}
		lots, err := s.q.LockBillingChargesCoveringAt(s.ctx, sqlc.LockBillingChargesCoveringAtParams{AccountID: s.acc.ID, Plan: s.acc.Plan, At: s.now})
		if err != nil {
			return err
		}
		var covered int32
		for _, ch := range lots {
			covered += ch.Qty - ch.CanceledQty
		}
		keep := int32(0)
		if s.acc.Status == StatusActive {
			if keep, err = s.billable(); err != nil {
				return err
			}
		}
		if covered-qty < keep {
			return billing.ErrChangeIncompatible
		}
		left, i := qty, 0
		for _, ch := range lots {
			if left == 0 {
				break
			}
			k := min(left, ch.Qty-ch.CanceledQty)
			d, err := s.cancelSeats(ch, k, s.now, key+":"+strconv.Itoa(i))
			if err != nil {
				return err
			}
			total += d
			left -= k
			i++
		}
		if err := s.normalize(); err != nil {
			return err
		}
		s.closeEpisodeIfPaid()
		var next *time.Time
		if s.acc.Status == StatusActive {
			next, err = s.nextEnd(s.now)
		} else {
			next, err = s.lastEnd(s.now)
		}
		if err != nil {
			return err
		}
		s.setNextDue(next)
		return nil
	})
	return total, err
}

// Resume modes.
const (
	ResumeFree = "free" // debt paid: Free plan, no seats bought
	ResumePaid = "paid" // debt paid and the first day of the team bought
)

// Resume lifts a billing suspension once the debt is paid (balance >= 0, else
// billing.ErrInsufficientFunds): free → stopped on the Free plan without buying seats (M21),
// or in the restricted mode when the workspace does not fit Free (never refused: paying the
// debt off must not require fitting a plan, ADR-0080 §8); paid → active on plan with the first
// day of every billable member bought from the free advance (M17: quote = debt + first day).
// Nothing is charged for the suspended time.
//
// Free on a lapsed account (ADR-0086 amendment) is the owner's way out of the restricted mode:
// refused with the violations (PLAN_LIMITS_EXCEEDED) until the workspace fits Free.
func (c *Core) Resume(ctx context.Context, accountID uuid.UUID, mode, plan string, requestID uuid.UUID, actor *uuid.UUID) (sqlc.BillingAccount, error) {
	if mode != ResumeFree && mode != ResumePaid {
		return sqlc.BillingAccount{}, httpx.Validation("mode", "mode must be free or paid")
	}
	// A custom plan resumes only as the account's own (a superadmin assigned it; the guard checks
	// the workspace is still on it).
	if mode == ResumePaid && !ValidPaidPlan(plan) && plan != PlanCustom {
		return sqlc.BillingAccount{}, badPlan()
	}
	return c.runGuarded(ctx, accountID, actor, func(s *state) error {
		if mode == ResumePaid && s.acc.Status == StatusActive && s.acc.Plan == plan {
			return nil // replay
		}
		if mode == ResumePaid && plan == PlanCustom && s.acc.Plan != PlanCustom {
			return badPlan()
		}
		if mode == ResumeFree && s.acc.Status == StatusStopped && s.acc.BalanceMinor >= 0 {
			if s.acc.LapsedAt != nil {
				if err := s.guard(PlanFree); err != nil {
					return err
				}
				s.setLapsed(nil)
			}
			s.clearEpisode()
			return nil
		}
		if s.acc.Status != StatusSuspended && s.acc.Status != StatusStopped {
			return billing.ErrChangeIncompatible
		}
		if s.acc.BalanceMinor < 0 {
			return billing.ErrInsufficientFunds
		}
		if mode == ResumeFree {
			s.setStatus(StatusStopped)
			s.setNextDue(nil)
			s.clearEpisode()
			return s.settleFree(s.now)
		}
		if !s.c.cfg.Debits {
			return billing.ErrDisabled
		}
		// A free resume is never checked (ADR-0080 §8: paying the debt off must not require
		// fitting a plan); a paid one is a transition to plan.
		if err := s.guard(plan); err != nil {
			return err
		}
		return s.startPaid(plan, ReasonResume, "resume:"+s.acc.ID.String()+":"+requestID.String())
	})
}
