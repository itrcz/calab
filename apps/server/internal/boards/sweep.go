package boards

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// SweepInterval is how often finished tasks are auto-archived (ADR-0042 §1).
const SweepInterval = time.Hour

// sweepBatch bounds one pass (the next pass continues).
const sweepBatch = 500

// Run auto-archives and sends the approval reminders (ADR-0049 §5) every interval until ctx is
// done; with Redis only one instance sweeps per interval (a lock key).
func (s *Service) Run(ctx context.Context, r rueidis.Client, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if r == nil || r.Do(ctx, r.B().Set().Key(redisx.Key("boards:sweep")).Value("1").Nx().Ex(interval-time.Minute).Build()).Error() == nil {
			if n, err := s.Sweep(ctx); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "boards: auto-archive", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "boards: tasks auto-archived", "count", n)
			}
			s.remindLogged(ctx)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Sweep archives the live tasks finished longer ago than their board's auto_archive_days
// (journal entry "archived" without an actor) and returns how many.
func (s *Service) Sweep(ctx context.Context) (int, error) {
	total := 0
	for range 20 {
		due, err := s.db.Q.DueAutoArchive(ctx, sweepBatch)
		if err != nil || len(due) == 0 {
			return total, err
		}
		ids := make([]uuid.UUID, len(due))
		ws := map[uuid.UUID]uuid.UUID{}
		for i, d := range due {
			ids[i], ws[d.ID] = d.ID, d.WorkspaceID
		}
		var acts []sqlc.TaskActivity
		var done []sqlc.ArchiveTasksRow
		err = s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
			var err error
			if done, err = q.ArchiveTasks(ctx, ids); err != nil {
				return err
			}
			for _, t := range done {
				a, err := q.InsertTaskActivity(ctx, sqlc.InsertTaskActivityParams{TaskID: t.ID, BoardID: t.BoardID, Kind: "archived",
					After: []byte(`{"auto": true}`)})
				if err != nil {
					return err
				}
				acts = append(acts, a)
			}
			_, err = s.webhookOutbox(ctx, q, tx, acts, nil)
			return err
		})
		if err != nil {
			return total, err
		}
		for i, t := range done {
			w := ws[t.ID]
			s.ev.Workspace(ctx, w, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskDelete{TaskDelete: &v1.TaskDelete{
				WorkspaceId: w.String(), BoardId: t.BoardID.String(), TaskId: t.ID.String()}}})
			s.ev.Workspace(ctx, w, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskActivity{TaskActivity: &v1.TaskActivityAppend{
				WorkspaceId: w.String(), TaskId: t.ID.String(), BoardId: t.BoardID.String(), Activity: activity(acts[i])}}})
		}
		total += len(done)
		if len(due) < sweepBatch {
			break
		}
	}
	return total, nil
}
