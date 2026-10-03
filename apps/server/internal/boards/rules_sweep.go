package boards

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Scheduled rule triggers (ADR-0060 §2, §5): every 15 minutes the sweeper looks for the tasks of
// each due_in / overdue / stale rule and runs the rule once per (rule, task, key date) — the key
// is the task's due date (due_in, overdue) or the date of its last change (stale), so a rule
// fires again only for a new deadline or a new idle spell. It also trims the run log.

// RuleSweepInterval is how often scheduled rules are checked.
const RuleSweepInterval = 15 * time.Minute

// ruleSweepBatch bounds the tasks of one rule per pass (the next pass continues).
const ruleSweepBatch = 200

// RunRules runs SweepRules every RuleSweepInterval until ctx is done; with Redis only one
// instance sweeps per interval.
func (s *Service) RunRules(ctx context.Context, r rueidis.Client) {
	t := time.NewTicker(RuleSweepInterval)
	defer t.Stop()
	for {
		if r == nil || r.Do(ctx, r.B().Set().Key(redisx.Key("boards:rules:sweep")).Value("1").Nx().Ex(RuleSweepInterval-time.Minute).Build()).Error() == nil {
			if n, err := s.SweepRules(ctx); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "boards: scheduled rules", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "boards: scheduled rules ran", "count", n)
			}
			if err := s.TrimRuleRuns(ctx); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "boards: rule runs trim", "err", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// TrimRuleRuns keeps the newest 100 runs of each rule and none older than 90 days.
func (s *Service) TrimRuleRuns(ctx context.Context) error {
	for range 20 {
		var n int64
		if err := s.tx(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
			var err error
			n, err = q.TrimRuleRuns(ctx)
			return err
		}); err != nil || n < 5000 {
			return err
		}
	}
	return nil
}

// SweepRules runs the scheduled rules on their due tasks and returns how many runs it made.
func (s *Service) SweepRules(ctx context.Context) (int, error) {
	rows, err := s.db.Q.ListScheduledRules(ctx)
	if err != nil {
		return 0, err
	}
	boardsOK := map[uuid.UUID]*sqlc.Board{}
	seen := map[uuid.UUID]bool{}
	total := 0
	for _, row := range rows {
		if !seen[row.BoardID] {
			seen[row.BoardID] = true
			b, err := s.db.Q.GetBoard(ctx, row.BoardID)
			if err != nil {
				return total, err
			}
			ok, err := s.automationsAllowed(ctx, b.WorkspaceID)
			if err != nil {
				return total, err
			}
			if ok && b.ArchivedAt == nil {
				boardsOK[b.ID] = &b
			}
		}
		b := boardsOK[row.BoardID]
		if b == nil {
			continue
		}
		r, err := decodeRule(row)
		if err != nil {
			continue
		}
		if row.TriggerKind != "stale" && Disabled(b.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_DUE_DATE) {
			continue
		}
		ts, err := s.scheduledTasks(ctx, r)
		if err != nil {
			return total, err
		}
		for _, t := range ts {
			fired, err := s.scheduledRun(ctx, r, t)
			if err != nil {
				return total, err
			}
			if fired {
				total++
			}
		}
	}
	return total, nil
}

// schedKey is the key date of a scheduled run of rule r on task t.
func schedKey(r rule, t taskRow) pgtype.Date {
	if r.row.TriggerKind == "stale" {
		return pgtype.Date{Time: utcDay(t.UpdatedAt), Valid: true}
	}
	return t.DueOn
}

// scheduledTasks finds the live, unfinished tasks of rule r's board its trigger holds for now,
// without a run for their key yet.
func (s *Service) scheduledTasks(ctx context.Context, r rule) ([]taskRow, error) {
	today := utcDay(s.Now())
	var a Args
	where := "WHERE t.board_id = " + a.Add(r.row.BoardID) + " AND t.archived_at IS NULL" +
		" AND EXISTS (SELECT 1 FROM board_statuses st WHERE st.id = t.status_id AND st.type NOT IN ('completed', 'cancelled'))"
	ruleID := a.Add(r.row.ID)
	date := func(d time.Time) string { return a.Add(pgtype.Date{Time: d, Valid: true}) }
	key := "t.due_on"
	switch k := r.trigger.GetKind().(type) {
	case *v1.RuleTrigger_DueIn_:
		where += " AND t.due_on >= " + date(today) + " AND t.due_on <= " + date(today.AddDate(0, 0, int(min(k.DueIn.GetDays(), MaxRuleTriggerDay))))
	case *v1.RuleTrigger_Overdue_:
		where += " AND t.due_on <= " + date(today.AddDate(0, 0, -int(max(min(k.Overdue.GetDays(), MaxRuleTriggerDay), 1))))
	case *v1.RuleTrigger_Stale_:
		where += " AND t.updated_at < " + a.Add(s.Now().AddDate(0, 0, -int(max(min(k.Stale.GetDays(), MaxRuleStaleDays), 1))))
		key = "(t.updated_at AT TIME ZONE 'UTC')::date"
	default:
		return nil, nil
	}
	// The condition in the query too (the engine checks it again in the run): tasks it rules out
	// are not claimed and rolled back every pass, nor do they fill the batch and starve the
	// matching tasks behind them. A filter that does not translate is left to the run, which logs it.
	if r.cond != nil {
		b := Args{vals: slices.Clone(a.vals)}
		if cond, err := Translate(r.cond, FilterEnv{Today: today}, &b); err == nil {
			a = b
			where += " AND (" + cond + ")"
		}
	}
	where += " AND NOT EXISTS (SELECT 1 FROM board_rule_runs rr WHERE rr.rule_id = " + ruleID + " AND rr.task_id = t.id AND rr.sched_key = " + key + ")"
	return queryTasks(ctx, s.db.Pool, where+" ORDER BY t.number LIMIT "+strconv.Itoa(ruleSweepBatch), a.Values()...)
}

// scheduledRun claims and runs rule r on task t (with the chain its changes start); false when
// the claim was taken or the condition does not hold (then nothing is kept).
func (s *Service) scheduledRun(ctx context.Context, r rule, t taskRow) (bool, error) {
	key := schedKey(r, t)
	if !key.Valid {
		return false, nil
	}
	fired := false
	var c change
	err := s.taskTx(ctx, &c, func(q *sqlc.Queries, tx pgx.Tx) error {
		fired = false
		n, err := q.ClaimScheduledRuleRun(ctx, sqlc.ClaimScheduledRuleRunParams{RuleID: r.row.ID, TaskID: &t.ID, TriggerKind: r.row.TriggerKind, SchedKey: key})
		if err != nil || n == 0 {
			return err
		}
		e := s.newEngine(ctx, q, tx)
		e.sched = &schedClaim{rule: r.row.ID, task: t.ID, key: key}
		br, err := e.board(r.row.BoardID)
		if err != nil {
			return err
		}
		if br == nil {
			return errNoMatch
		}
		e.fired[[2]uuid.UUID{r.row.ID, t.ID}] = true
		rr := r
		acts, err := e.apply(&rr, t.ID, ruleEvent{task: t.ID, board: t.BoardID, kind: r.row.TriggerKind})
		if err != nil {
			return err
		}
		next := make([]ruleEvent, 0, len(acts))
		for _, a := range acts {
			next = append(next, eventOf(a))
		}
		if err := e.chain(next, 2); err != nil {
			return err
		}
		if err := e.finish(); err != nil {
			return err
		}
		if !e.auto.empty() {
			c.auto = e.auto
		}
		fired = true
		return nil
	})
	if errors.Is(err, errNoMatch) {
		return false, nil
	}
	return fired, err
}
