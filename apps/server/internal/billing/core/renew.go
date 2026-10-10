package core

import (
	"time"

	"github.com/calaba/calaba/server/internal/billing"
)

// catchUp applies everything due up to `until` (ADR-0080 §4.3, §8): the renewal of every lot
// boundary in order, each starting at its old boundary (a late worker gives no free time), the
// end of a stopped account's coverage, and the suspension at the debt deadline. done=false:
// MaxCatchUpSteps renewals were applied and more are due (the worker continues).
func (s *state) catchUp(until time.Time) (done bool, err error) {
	if s.held() || !s.c.cfg.Debits {
		return true, nil
	}
	for steps := 0; ; steps++ {
		due := s.acc.NextDueAt
		if due == nil || due.After(until) || (s.acc.Status != StatusActive && s.acc.Status != StatusStopped) {
			break
		}
		if steps == MaxCatchUpSteps {
			return false, nil
		}
		b := due.UTC()
		if s.acc.Status == StatusStopped {
			// The paid coverage of a stopped account ended: Free from now on.
			s.setNextDue(nil)
			continue
		}
		if s.deadlinePassed(b) {
			s.suspend()
			break
		}
		if err := s.renewAt(b); err != nil {
			return false, err
		}
		next, err := s.nextEnd(b)
		if err != nil {
			return false, err
		}
		s.setNextDue(next)
	}
	if s.deadlinePassed(until) {
		s.suspend()
	}
	return true, nil
}

// deadlinePassed: the debt deadline is at or before t, the balance is still negative and
// enforcement is on.
func (s *state) deadlinePassed(t time.Time) bool {
	return s.c.cfg.Enforcement && s.acc.SuspendAt != nil && !t.Before(*s.acc.SuspendAt) &&
		s.acc.BalanceMinor < 0 && (s.acc.Status == StatusActive || s.acc.Status == StatusStopped)
}

// suspend closes the workspace for unpaid billing: no further charges or intervals (M16).
func (s *state) suspend() {
	s.setStatus(StatusSuspended)
	s.setNextDue(nil)
}

// renewAt buys the capacity missing at boundary b for the current team. It may go into debt
// (the debt episode starts at b); inside an open episode the lot is cut at the deadline when a
// full day would leave the balance negative (M18, prorated half up).
func (s *state) renewAt(b time.Time) error {
	n, err := s.billableBefore()
	if err != nil {
		return err
	}
	covered, err := s.capacity(s.acc.Plan, b)
	if err != nil {
		return err
	}
	need := n - covered
	if need <= 0 {
		return nil
	}
	end := b.Add(billing.Day)
	if sa := s.acc.SuspendAt; sa != nil && sa.After(b) && end.After(*sa) {
		_, unit, _, err := s.unitPrice(s.acc.Plan, b)
		if err != nil {
			return err
		}
		full, err := ChargeAmount(unit, need, billing.Day)
		if err != nil {
			return err
		}
		if s.acc.BalanceMinor-full < 0 && s.c.cfg.Enforcement {
			end = *sa
		}
	}
	_, _, err = s.buy(buyReq{
		plan: s.acc.Plan, qty: need, start: b, end: end, reason: ReasonRenew,
		key:       "renew:" + s.acc.ID.String() + ":" + s.acc.Plan + ":" + b.UTC().Format(time.RFC3339Nano),
		allowDebt: true,
	})
	return err
}
