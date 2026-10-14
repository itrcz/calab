package boards

import (
	"context"
	"log/slog"
	"time"
	_ "time/tzdata" // TASKS_DUE_TZ: the distroless image has no zoneinfo

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/notifications"
)

// Due notices (ADR-0089 §4): at 09:00 in TASKS_DUE_TZ the assignees (the lead is one) of a live
// task hear that it is due tomorrow and, the next day, due today; the day after the due date
// they and the creator hear it is overdue — once each, deduplicated by task_due_notices.

// DueNoticeInterval is how often the due sweep runs (a notice is late by at most this).
const DueNoticeInterval = 5 * time.Minute

// DueNoticeHour is the local hour of TASKS_DUE_TZ from which the day's notices go out.
const DueNoticeHour = 9

// dueNoticeBatch bounds the tasks of one claim (the dedup rows are kept for 30 days).
const dueNoticeBatch = 200

// DueZone is the zone of TASKS_DUE_TZ (validated by config); Europe/Moscow when unset.
func DueZone(name string) *time.Location {
	if name == "" {
		name = "Europe/Moscow"
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}

// RunDueNotices sends the due notices every interval until ctx is done. Every server instance
// runs it: the claim (an insert into task_due_notices) hands each notice to one of them.
func (s *Service) RunDueNotices(ctx context.Context, interval time.Duration, loc *time.Location) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if n, err := s.DeliverDueNotices(ctx, loc); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "boards: due notices", "err", err)
		} else if n > 0 {
			slog.DebugContext(ctx, "boards: due notices sent", "count", n)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// dueDay is the date whose notices are due now: today in loc from DueNoticeHour on, else none.
func dueDay(now time.Time, loc *time.Location) (pgtype.Date, bool) {
	local := now.In(loc)
	if local.Hour() < DueNoticeHour {
		return pgtype.Date{}, false
	}
	y, m, d := local.Date()
	return pgtype.Date{Time: time.Date(y, m, d, 0, 0, 0, 0, time.UTC), Valid: true}, true
}

// DeliverDueNotices claims and sends the due notices of today and returns how many went out.
func (s *Service) DeliverDueNotices(ctx context.Context, loc *time.Location) (int, error) {
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		_, err := guarded.PurgeTaskDueNotices(ctx)
		return err
	}); err != nil {
		return 0, err
	}
	return s.DeliverDueNoticesAt(ctx, s.Now(), loc)
}

// DeliverDueNoticesAt is DeliverDueNotices at the moment now (tests).
func (s *Service) DeliverDueNoticesAt(ctx context.Context, now time.Time, loc *time.Location) (int, error) {
	today, ok := dueDay(now, loc)
	if !ok {
		return 0, nil
	}
	total := 0
	for range 50 {
		n, claimed, err := s.deliverDueBatch(ctx, today)
		total += n
		if err != nil || claimed == 0 {
			return total, err
		}
	}
	return total, nil
}

// dueNotice is one claimed task_due_notices kind as a notice.
var dueNotices = map[string]struct {
	kind     notifications.TaskKind
	daysLeft int32
}{
	"due_tomorrow": {notifications.TaskDueSoon, 1},
	"due_today":    {notifications.TaskDueSoon, 0},
	"overdue":      {notifications.TaskOverdue, -1},
}

// deliverDueBatch claims one batch and sends the notices the recipients' settings let through
// (the claim stays either way: one decision per day and date). Returns the notices sent and
// the rows claimed.
func (s *Service) deliverDueBatch(ctx context.Context, today pgtype.Date) (int, int, error) {
	type key struct {
		task uuid.UUID
		kind string
	}
	sent := map[uuid.UUID][]notice{}
	claimed := 0
	err := s.tx(ctx, func(q *sqlc.Queries, tx pgx.Tx) error {
		clear(sent)
		rows, err := q.ClaimTaskDueNotices(ctx, sqlc.ClaimTaskDueNoticesParams{Today: today, Lim: dueNoticeBatch})
		if err != nil {
			return err
		}
		claimed = len(rows)
		var order []key
		users := map[key][]uuid.UUID{}
		due := map[uuid.UUID]string{}
		for _, r := range rows {
			k := key{r.TaskID, r.Kind}
			if _, ok := users[k]; !ok {
				order = append(order, k)
			}
			users[k] = append(users[k], r.UserID)
			due[r.TaskID] = DateString(r.DueOn)
		}
		for _, k := range order {
			t, ok, err := taskByID(ctx, tx, k.task, false)
			if err != nil {
				return err
			}
			if !ok {
				continue
			}
			dn := dueNotices[k.kind]
			var c change
			dueOn := due[k.task]
			if err := s.notifyAddressed(ctx, q, t, uuid.Nil, dn.kind, users[k], func(n *notice) { n.dueOn, n.daysLeft = dueOn, dn.daysLeft }, &c); err != nil {
				return err
			}
			sent[k.task] = append(sent[k.task], c.notices...)
		}
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	n := 0
	for id, ns := range sent {
		s.sendNotices(ctx, id, ns)
		n += len(ns)
	}
	return n, claimed, nil
}
