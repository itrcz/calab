package core

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Admit implements billing.Seats inside the caller's transaction, after the membership row was
// written (so CountBillableMembers includes the new member). A workspace without a live
// account, an inactive or stopped account (Free) passes. Otherwise, after applying what is due:
//
//   - the seats of the current plan covering now are enough → no charge (replacement inside
//     the covered capacity, also during a debt episode: M3, M23);
//   - else one day of the missing seats is bought from the free advance, never into debt
//     (billing.ErrSeatGrowthRequiresFunds, M22);
//   - a suspended account refuses (billing.ErrWorkspaceBillingSuspended).
//
// requestID: a retry of the same operation is not charged twice (charge key admit:{account}:
// {request}). With Config.Debits off it passes without a charge; with Config.Enforcement off it
// never refuses (growth may go into debt). An incident hold passes without a charge.
func (c *Core) Admit(ctx context.Context, q *sqlc.Queries, workspaceID, _ uuid.UUID, requestID uuid.UUID) error {
	acc, err := q.LockLiveBillingAccountByWorkspace(ctx, &workspaceID)
	if db.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	switch acc.Status {
	case StatusSuspended:
		if c.cfg.Enforcement {
			return billing.ErrWorkspaceBillingSuspended
		}
		return nil
	case StatusActive:
	default:
		return nil
	}
	if !c.cfg.Debits {
		return nil
	}
	s, err := c.stateOf(ctx, q, acc, nil)
	if err != nil {
		return err
	}
	if s.held() {
		return nil
	}
	s.joining = 1
	done, err := s.catchUp(s.now)
	s.joining = 0
	if err != nil {
		return err
	}
	if !done {
		return billing.ErrReconciling
	}
	if s.acc.Status == StatusSuspended {
		return billing.ErrWorkspaceBillingSuspended // the caller rolls back; the worker suspends
	}
	if s.acc.Status == StatusActive {
		if err := s.admit(requestID); err != nil {
			return err
		}
	}
	return s.save()
}

func (s *state) admit(requestID uuid.UUID) error {
	key := "admit:" + s.acc.ID.String() + ":" + requestID.String()
	if _, err := s.q.GetBillingChargeByKey(s.ctx, key); err == nil {
		return nil // replay
	} else if !db.IsNotFound(err) {
		return err
	}
	n, err := s.billable()
	if err != nil {
		return err
	}
	covered, err := s.capacity(s.acc.Plan, s.now)
	if err != nil {
		return err
	}
	if n <= covered {
		return nil
	}
	if _, _, err := s.buy(buyReq{plan: s.acc.Plan, qty: n - covered, start: s.now, end: s.now.Add(billing.Day),
		reason: ReasonAdmit, key: key, allowDebt: !s.c.cfg.Enforcement, refuse: billing.ErrSeatGrowthRequiresFunds}); err != nil {
		return err
	}
	next, err := s.nextEnd(s.now)
	if err != nil {
		return err
	}
	s.setNextDue(next)
	return nil
}

// Promote implements billing.Seats: a guest became billable — the same as Admit.
func (c *Core) Promote(ctx context.Context, q *sqlc.Queries, workspaceID, userID, requestID uuid.UUID) error {
	return c.Admit(ctx, q, workspaceID, userID, requestID)
}

// Removed implements billing.Seats: nothing to do now. The freed seat stays covered until its
// lot ends (a replacement takes it for free) and the next renewal counts the members then.
func (c *Core) Removed(context.Context, *sqlc.Queries, uuid.UUID, uuid.UUID) error { return nil }
