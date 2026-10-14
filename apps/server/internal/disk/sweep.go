package disk

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/diskacl"
)

// SweepInterval is how often TrashSweep runs (ADR-0094 §4).
const SweepInterval = time.Hour

// sweepBatch: trash roots deleted per transaction.
const sweepBatch = 100

// TrashSweep deletes forever, once, the trash roots older than their workspace's
// disk_trash_days (NULL = never), through the delete-forever path. Per workspace, batches of
// sweepBatch roots, each in a transaction holding the workspace's sweep advisory lock: another
// instance sweeping the same workspace skips it. Returns the number of roots deleted.
func (s *Service) TrashSweep(ctx context.Context) (int, error) {
	now := s.Now()
	wss, err := s.db.Q.ListDiskSweepWorkspaces(ctx, now)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, w := range wss {
		cutoff := now.Add(-time.Duration(w.Days) * 24 * time.Hour)
		for {
			n, more, err := s.sweepBatch(ctx, w.ID, cutoff)
			total += n
			if err != nil {
				return total, err
			}
			if !more {
				break
			}
		}
	}
	return total, nil
}

func (s *Service) sweepBatch(ctx context.Context, ws uuid.UUID, cutoff time.Time) (int, bool, error) {
	var done []deleted
	more := false
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		ok, err := q.TryAdvisoryXactLock(ctx, "calaba.disk.sweep."+ws.String())
		if err != nil || !ok {
			return err
		}
		roots, err := q.ListDiskTrashRootsBefore(ctx, sqlc.ListDiskTrashRootsBeforeParams{WorkspaceID: ws, Cutoff: cutoff, Lim: sweepBatch})
		if err != nil {
			return err
		}
		more = len(roots) == sweepBatch
		if len(roots) > 0 {
			if err := q.LockDiskQuota(ctx, ws); err != nil {
				return err
			}
			// The tree lock after the quota row (an upload's order): no restore or move of this
			// subtree runs while it is deleted.
			if err := q.LockDiskTree(ctx, ws); err != nil {
				return err
			}
		}
		ids := make([]uuid.UUID, len(roots))
		for i, it := range roots {
			ids[i] = it.ID
		}
		ch, err := diskacl.Load(ctx, q, ids)
		if err != nil {
			return err
		}
		for _, it := range roots {
			// Re-read under the row lock: skip a root deleted or restored since the listing.
			cur, err := q.GetDiskItemForUpdate(ctx, it.ID)
			if db.IsNotFound(err) {
				continue
			}
			if err != nil {
				return err
			}
			if !cur.TrashedRoot || cur.TrashedAt == nil || !cur.TrashedAt.Before(cutoff) {
				continue
			}
			d, err := s.deleteTree(ctx, q, cur, ch.Nodes(it.ID), nil)
			if err != nil {
				return err
			}
			done = append(done, d)
		}
		return nil
	})
	if err != nil {
		return 0, false, err
	}
	s.finish(ctx, done)
	return len(done), more, nil
}

// RunTrashSweep runs TrashSweep every interval until ctx is done.
func (s *Service) RunTrashSweep(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := s.TrashSweep(ctx)
			if err != nil {
				slog.ErrorContext(ctx, "disk trash sweep", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "disk trash swept", "deleted", n)
			}
		}
	}
}
