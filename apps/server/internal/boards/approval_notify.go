package boards

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Delayed approval notices (ADR-0082): adding an approver or resetting their decided vote sets
// task_approvers.notify_due_at = now() + the board's delay; this worker sends what is due.

// ApprovalNoticeInterval is how often due approval notices are delivered (the one-minute
// default delay is then late by at most this).
const ApprovalNoticeInterval = 15 * time.Second

// approvalNoticeBatch bounds the tasks of one pass (the next tick continues).
const approvalNoticeBatch = 200

// RunApprovalNotices delivers due approval notices every interval until ctx is done. Every
// server instance runs it: the claim (SKIP LOCKED) hands each notice to one of them.
func (s *Service) RunApprovalNotices(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if n, err := s.DeliverApprovalNotices(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "boards: approval notices", "err", err)
		} else if n > 0 {
			slog.DebugContext(ctx, "boards: approval notices sent", "count", n)
		}
	}
}

// DeliverApprovalNotices sends the due approval notices and returns how many went out. A task
// that fails is logged and retried on the next pass; the others still go.
func (s *Service) DeliverApprovalNotices(ctx context.Context) (int, error) {
	ids, err := s.db.Q.DueApprovalNoticeTasks(ctx, approvalNoticeBatch)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	total := 0
	var first error
	for _, id := range ids {
		n, err := s.deliverApprovalNotices(ctx, id)
		if err != nil {
			if ctx.Err() != nil {
				return total, ctx.Err()
			}
			slog.WarnContext(ctx, "boards: approval notices of a task", "task", id, "err", err)
			if first == nil {
				first = err
			}
			continue
		}
		total += n
	}
	return total, first
}

// deliverApprovalNotices claims the due notices of one task and sends those still wanted: the
// vote is pending, the task is live and its board has APPROVALS on (a removed approver has no
// row left to claim). Notices of the same reason and adder go out together.
func (s *Service) deliverApprovalNotices(ctx context.Context, taskID uuid.UUID) (int, error) {
	var c change
	err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
		due, err := q.ClaimApprovalNotices(ctx, taskID)
		if err != nil || len(due) == 0 {
			return err
		}
		t, ok, err := taskByID(ctx, tx, taskID, false)
		if err != nil || !ok || t.ArchivedAt != nil {
			return err
		}
		b, err := q.GetBoard(ctx, t.BoardID)
		if err != nil {
			return err
		}
		if b.ArchivedAt != nil || Disabled(b.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_APPROVALS) {
			return nil
		}
		type group struct {
			reRequested bool
			actor       uuid.UUID
		}
		var order []group
		users := map[group][]uuid.UUID{}
		for _, d := range due {
			if d.State != votePending {
				continue // voted before the notice went out
			}
			g := group{reRequested: d.NotifyReason == reasonReRequested}
			if !g.reRequested && d.AddedBy != nil {
				g.actor = *d.AddedBy
			}
			if _, ok := users[g]; !ok {
				order = append(order, g)
			}
			users[g] = append(users[g], d.UserID)
		}
		for _, g := range order {
			if err := s.sendApprovalRequest(ctx, q, t, g.actor, users[g], g.reRequested, &c); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	s.sendNotices(ctx, taskID, c.notices)
	return len(c.notices), nil
}
