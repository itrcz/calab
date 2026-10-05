package push

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

var errBackpressure = errors.New("push routing capacity unavailable")

func (s *Service) enqueueIntent(ctx context.Context, recipient *uuid.UUID, job sqlc.PushDelivery) error {
	return s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockPushIntentAdmission(ctx); err != nil {
			return err
		}
		// Separate statements give the bounded count a snapshot after admission locks.
		n, err := q.QueuePushIntent(ctx, sqlc.QueuePushIntentParams{RecipientID: recipient, EventKey: job.EventKey, Kind: job.Kind, ReferenceID: job.ReferenceID, RoomID: job.RoomID, ActorID: job.ActorID, NoticeKind: job.NoticeKind, ContextID: job.ContextID, OccurrenceAt: job.OccurrenceAt, ReminderMinutes: job.ReminderMinutes, ExpiresAt: job.ExpiresAt})
		if err != nil || n > 0 {
			return err
		}
		duplicate, err := q.HasPushIntent(ctx, sqlc.HasPushIntentParams{RecipientID: recipient, EventKey: job.EventKey})
		if err != nil {
			return err
		}
		if !duplicate {
			return errBackpressure
		}
		return nil
	})
}
func intentDelivery(p sqlc.PushIntent) sqlc.PushDelivery {
	return sqlc.PushDelivery{EventKey: p.EventKey, Kind: p.Kind, ReferenceID: p.ReferenceID, RoomID: p.RoomID, ActorID: p.ActorID, NoticeKind: p.NoticeKind, ContextID: p.ContextID, OccurrenceAt: p.OccurrenceAt, ReminderMinutes: p.ReminderMinutes, ExpiresAt: p.ExpiresAt}
}

// Fanout claims durable resumable routing. Workspace expansion only creates
// recipient intents; a blocked endpoint cannot discard the unprocessed tail.
func (s *Service) Fanout(ctx context.Context) error {
	if len(s.providers) == 0 {
		return nil
	}
	lease := uuid.New()
	jobs, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) ([]sqlc.PushIntent, error) { return q.ClaimPushIntents(ctx, &lease) })
	if err != nil {
		return err
	}
	runGroup := func(calls bool) {
		var work sync.WaitGroup
		slots := make(chan struct{}, 8)
		for _, job := range jobs {
			if (job.Kind == callKind) != calls {
				continue
			}
			select {
			case slots <- struct{}{}:
			case <-ctx.Done():
				work.Wait()
				return
			}
			work.Add(1)
			go func(job sqlc.PushIntent) {
				defer work.Done()
				defer func() { <-slots }()
				bounded, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
				err := s.expand(bounded, job)
				cancel()
				settled, stop := context.WithTimeout(context.WithoutCancel(ctx), 250*time.Millisecond)
				defer stop()
				if err != nil {
					_, _ = db.GuardValue(settled, s.db, func(q *sqlc.Queries) (int64, error) {
						return q.RetryPushIntent(settled, sqlc.RetryPushIntentParams{ID: job.ID, LeaseID: job.LeaseID})
					})
				} else {
					_, _ = db.GuardValue(settled, s.db, func(q *sqlc.Queries) (int64, error) {
						return q.CompletePushIntent(settled, sqlc.CompletePushIntentParams{ID: job.ID, LeaseID: job.LeaseID})
					})
				}
			}(job)
		}
		work.Wait()
	}
	runGroup(true)
	runGroup(false)
	return nil
}
func (s *Service) expand(ctx context.Context, intent sqlc.PushIntent) error {
	job := intentDelivery(intent)
	if !job.ExpiresAt.After(time.Now()) {
		return nil
	}
	if intent.RecipientID != nil {
		return s.queueUser(ctx, *intent.RecipientID, job)
	}
	if job.Kind != messageKind || job.RoomID == nil {
		return nil
	}
	after := intent.AfterUser
	for {
		targets, err := s.db.Q.ListPushMessageTargets(ctx, sqlc.ListPushMessageTargetsParams{ID: *job.RoomID, After: after})
		if err != nil {
			return err
		}
		for _, target := range targets {
			if err := s.enqueueIntent(ctx, &target, job); err != nil {
				return err
			}
			n, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (int64, error) {
				return q.AdvancePushIntent(ctx, sqlc.AdvancePushIntentParams{ID: intent.ID, LeaseID: intent.LeaseID, AfterUser: target})
			})
			if err != nil {
				return err
			}
			if n != 1 {
				return errors.New("push routing lease replaced")
			}
			after = target
		}
		if len(targets) < 64 {
			return nil
		}
	}
}
