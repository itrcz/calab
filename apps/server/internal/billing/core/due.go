package core

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Due work kinds of ProcessDue.
const (
	DueRenewal    = "renewal"    // active accounts at a lot boundary
	DueCoverage   = "coverage"   // stopped accounts at the end of their paid coverage
	DueSuspension = "suspension" // accounts at their debt deadline
)

// ProcessDue claims one account with due work of kind (FOR UPDATE SKIP LOCKED, never one in
// skip or under an incident hold) and applies it in one transaction: renewals from the old
// boundaries, end of coverage, suspension. ok=false: nothing due. more: the account is still
// behind (MaxCatchUpSteps), claim it again. On error the account's transaction rolls back and
// id names it (the worker skips it for the rest of the round).
func (c *Core) ProcessDue(ctx context.Context, kind string, skip []uuid.UUID) (id uuid.UUID, ok, more bool, err error) {
	if skip == nil {
		skip = []uuid.UUID{}
	}
	var s *state
	err = c.db.Tx(ctx, func(q *sqlc.Queries) error {
		now, err := c.clock.Now(ctx, q)
		if err != nil {
			return err
		}
		var acc sqlc.BillingAccount
		switch kind {
		case DueRenewal:
			acc, err = q.ClaimBillingRenewal(ctx, sqlc.ClaimBillingRenewalParams{Status: StatusActive, Now: now, Skip: skip})
		case DueCoverage:
			acc, err = q.ClaimBillingRenewal(ctx, sqlc.ClaimBillingRenewalParams{Status: StatusStopped, Now: now, Skip: skip})
		default:
			acc, err = q.ClaimBillingSuspension(ctx, sqlc.ClaimBillingSuspensionParams{Now: now, Skip: skip})
		}
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		id, ok = acc.ID, true
		if s, err = c.stateOf(ctx, q, acc, nil); err != nil {
			return err
		}
		done, err := s.catchUp(s.now)
		if err != nil {
			return err
		}
		more = !done
		s.closeEpisodeIfPaid()
		return s.save()
	})
	if err != nil {
		return id, ok, false, err
	}
	if ok {
		c.committed(ctx, s)
	}
	return id, ok, more, nil
}
