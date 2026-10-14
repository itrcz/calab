package wiki

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// SweepInterval is how often TrashSweep runs (like the Disk's).
const SweepInterval = time.Hour

// sweepBatch: trash roots deleted per transaction.
const sweepBatch = 100

// TrashSweep deletes forever, once, the trash roots older than their workspace's
// wiki_trash_days (NULL = never), through the delete-forever path. Per workspace, batches of
// sweepBatch roots, each in a transaction holding the workspace's sweep advisory lock: another
// instance sweeping the same workspace skips it. Returns the number of roots deleted.
func (s *Service) TrashSweep(ctx context.Context) (int, error) {
	now := s.Now()
	wss, err := s.db.Q.ListWikiSweepWorkspaces(ctx, now)
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
		ok, err := q.TryAdvisoryXactLock(ctx, "calaba.wiki.sweep."+ws.String())
		if err != nil || !ok {
			return err
		}
		roots, err := q.ListWikiTrashRootsBefore(ctx, sqlc.ListWikiTrashRootsBeforeParams{WorkspaceID: ws, Cutoff: cutoff, Lim: sweepBatch})
		if err != nil {
			return err
		}
		more = len(roots) == sweepBatch
		if len(roots) > 0 {
			if err := q.LockDiskQuota(ctx, ws); err != nil { // the workspaces row first
				return err
			}
			if err := q.LockWikiTree(ctx, ws); err != nil {
				return err
			}
		}
		ids := make([]uuid.UUID, len(roots))
		for i, p := range roots {
			ids[i] = p.ID
		}
		ch, err := wikiacl.Load(ctx, q, ids)
		if err != nil {
			return err
		}
		for _, p := range roots {
			// Re-read under the row lock: skip a root deleted or restored since the listing.
			cur, err := q.GetWikiPageForUpdate(ctx, p.ID)
			if db.IsNotFound(err) {
				continue
			}
			if err != nil {
				return err
			}
			if !cur.TrashedRoot || cur.TrashedAt == nil || !cur.TrashedAt.Before(cutoff) {
				continue
			}
			d, err := s.deleteTree(ctx, q, cur, ch.Nodes(p.ID), nil)
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
				slog.ErrorContext(ctx, "wiki trash sweep", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "wiki trash swept", "deleted", n)
			}
		}
	}
}
