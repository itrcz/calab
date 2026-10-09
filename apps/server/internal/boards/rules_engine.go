package boards

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// The automation engine (ADR-0060 §2, §5): after a task change, in its transaction, the enabled
// rules of the boards it touched are matched against its journal entries; the condition is one
// EXISTS over the task; the actions run in a savepoint (a failing action rolls back that rule's
// actions, never the change). What rules change triggers rules again up to MaxRuleDepth, each
// rule at most once per task in a chain. Everything the rules did is published after the commit.

// autoEffects is what automation rules did in one transaction (published by publishAuto).
type autoEffects struct {
	acts       []sqlc.TaskActivity
	ruleNames  map[uuid.UUID]string
	tasks      []uuid.UUID // TASK_UPDATE
	created    []uuid.UUID // TASK_CREATE (subtasks)
	archived   []taskRow   // TASK_DELETE
	notices    map[uuid.UUID][]notice
	checklists []clRef
	messages   []postedMessage
	events     []wsEvent // BOARD_RULE_UPDATE
}

type clRef struct {
	t  taskRow
	id uuid.UUID
}

type postedMessage struct {
	ws uuid.UUID
	m  sqlc.Message
}

func (a *autoEffects) empty() bool {
	return a == nil || (len(a.acts) == 0 && len(a.tasks) == 0 && len(a.created) == 0 && len(a.archived) == 0 &&
		len(a.notices) == 0 && len(a.checklists) == 0 && len(a.messages) == 0 && len(a.events) == 0)
}

func (a *autoEffects) touch(id uuid.UUID) {
	if !slices.Contains(a.tasks, id) {
		a.tasks = append(a.tasks, id)
	}
}

// merge adds what one successful rule run did.
func (a *autoEffects) merge(b *autoEffects, c *change, r *rule) {
	if a.ruleNames == nil {
		a.ruleNames = map[uuid.UUID]string{}
	}
	if a.notices == nil {
		a.notices = map[uuid.UUID][]notice{}
	}
	a.ruleNames[r.row.ID] = r.row.Name
	a.acts = append(a.acts, c.acts...)
	for _, x := range c.acts {
		a.touch(x.TaskID)
	}
	for _, id := range c.tasks {
		a.touch(id)
	}
	for _, id := range b.tasks {
		a.touch(id)
	}
	a.created = append(a.created, b.created...)
	a.archived = append(a.archived, b.archived...)
	a.checklists = append(a.checklists, b.checklists...)
	a.messages = append(a.messages, b.messages...)
	for task, ns := range b.notices {
		a.notices[task] = append(a.notices[task], ns...)
	}
}

// boardRules: the enabled rules of a live board whose plan has automations (nil: none run).
type boardRules struct {
	b     sqlc.Board
	rules []rule
}

type runTally struct {
	r       *rule
	n       int
	lastErr string
}

// engine runs the rules of one transaction.
type engine struct {
	s      *Service
	ctx    context.Context
	q      *sqlc.Queries
	tx     pgx.Tx
	boards map[uuid.UUID]*boardRules
	probed map[uuid.UUID][]sqlc.BoardRule // enabled rules already read by runRules
	fired  map[[2]uuid.UUID]bool
	runs   map[uuid.UUID]*runTally
	auto   *autoEffects
	// sched: a scheduled run (sweeper) — its claim row is finished instead of a new run row.
	sched *schedClaim
}

type schedClaim struct {
	rule, task uuid.UUID
	key        pgtype.Date
	done       bool
}

func (s *Service) newEngine(ctx context.Context, q *sqlc.Queries, tx pgx.Tx) *engine {
	return &engine{s: s, ctx: ctx, q: q, tx: tx, boards: map[uuid.UUID]*boardRules{}, fired: map[[2]uuid.UUID]bool{},
		runs: map[uuid.UUID]*runTally{}, auto: &autoEffects{}}
}

// automationsAllowed: the workspace's plan includes automations (no plan service: yes).
func (s *Service) automationsAllowed(ctx context.Context, wsID uuid.UUID) (bool, error) {
	if s.plans == nil {
		return true, nil
	}
	l, err := s.plans.Effective(ctx, wsID)
	return !l.AutomationsDisabled, err
}

// runRules runs the automation rules on the journal entries (and extra events) of change c in
// its transaction; what they did lands in c.auto. A failure of the engine itself is logged and
// rolled back to its savepoint: the user's change never fails because of rules.
func (s *Service) runRules(ctx context.Context, q *sqlc.Queries, tx pgx.Tx, c *change) error {
	if len(c.acts) == 0 && len(c.extra) == 0 {
		return nil
	}
	events := make([]ruleEvent, 0, len(c.acts)+len(c.extra))
	for _, a := range c.acts {
		events = append(events, eventOf(a))
	}
	events = append(events, c.extra...)
	// One index probe per board (ADR-0060 §5): a change on boards without rules costs nothing more.
	probed := map[uuid.UUID][]sqlc.BoardRule{}
	found := false
	for _, ev := range events {
		if _, ok := probed[ev.board]; ok {
			continue
		}
		rows, err := q.ListEnabledBoardRules(ctx, ev.board)
		if err != nil {
			return err
		}
		probed[ev.board] = rows
		found = found || len(rows) > 0
	}
	if !found {
		return nil
	}
	sp, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	e := s.newEngine(ctx, q.WithTx(sp), sp)
	e.probed = probed
	err = e.chain(events, 1)
	if err == nil {
		err = e.finish()
	}
	if err != nil {
		if rb := sp.Rollback(ctx); rb != nil {
			return rb
		}
		slog.WarnContext(ctx, "boards: automation rules skipped", "err", err)
		return nil
	}
	if err := sp.Commit(ctx); err != nil {
		return err
	}
	if !e.auto.empty() {
		c.auto = e.auto
	}
	return nil
}

// board loads the rules of a board once per transaction: one index probe when it has none.
func (e *engine) board(id uuid.UUID) (*boardRules, error) {
	if br, ok := e.boards[id]; ok {
		return br, nil
	}
	e.boards[id] = nil
	rows, ok := e.probed[id]
	var err error
	if !ok {
		rows, err = e.q.ListEnabledBoardRules(e.ctx, id)
	}
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	b, err := e.q.GetBoard(e.ctx, id)
	if err != nil || b.ArchivedAt != nil {
		return nil, err
	}
	if Disabled(b.DisabledFeatures, v1.BoardFeature_BOARD_FEATURE_AUTOMATIONS) {
		return nil, nil // the board switched automations off: its rules pause, nothing is deleted
	}
	if ok, err := e.s.automationsAllowed(e.ctx, b.WorkspaceID); err != nil || !ok {
		return nil, err
	}
	br := &boardRules{b: b}
	for _, row := range rows {
		r, err := decodeRule(row)
		if err != nil {
			slog.WarnContext(e.ctx, "boards: unreadable rule", "rule", row.ID, "err", err)
			continue
		}
		if !scheduled(row.TriggerKind) {
			br.rules = append(br.rules, r)
		}
	}
	e.boards[id] = br
	return br, nil
}

// chain matches the events against the rules level by level: the events of depth d fire rules
// whose changes are the events of depth d + 1.
func (e *engine) chain(events []ruleEvent, depth int) error {
	for ; len(events) > 0; depth++ {
		var next []ruleEvent
		var order []uuid.UUID
		by := map[uuid.UUID][]ruleEvent{}
		for _, ev := range events {
			if _, ok := by[ev.task]; !ok {
				order = append(order, ev.task)
			}
			by[ev.task] = append(by[ev.task], ev)
		}
		for _, tid := range order {
			evs := by[tid]
			br, err := e.board(evs[len(evs)-1].board)
			if err != nil {
				return err
			}
			if br == nil {
				continue
			}
			complete := e.checklistsDone(tid)
			for i := range br.rules {
				r := &br.rules[i]
				j := slices.IndexFunc(evs, func(ev ruleEvent) bool { return ev.board == r.row.BoardID && matchTrigger(r.trigger, ev, complete) })
				if j < 0 {
					continue
				}
				key := [2]uuid.UUID{r.row.ID, tid}
				if e.fired[key] {
					e.logRun(r, tid, false, RuleLoop+": the rule was triggered again by its own chain", 0)
					continue
				}
				if depth > MaxRuleDepth {
					e.logRun(r, tid, false, RuleLoop+": a chain of more than 3 rules", 0)
					continue
				}
				e.fired[key] = true
				acts, err := e.apply(r, tid, evs[j])
				if err != nil {
					return err
				}
				for _, a := range acts {
					next = append(next, eventOf(a))
				}
			}
		}
		events = next
	}
	return nil
}

// checklistsDone answers (once) whether every item of every checklist of the task is done.
func (e *engine) checklistsDone(task uuid.UUID) func() bool {
	var done *bool
	return func() bool {
		if done == nil {
			cnt, err := e.q.TaskChecklistCounts(e.ctx, task)
			ok := err == nil && cnt.Total > 0 && cnt.Done == cnt.Total
			done = &ok
		}
		return *done
	}
}

// errNoMatch: the condition of a scheduled run does not hold (its claim is rolled back).
var errNoMatch = errors.New("boards: rule condition does not hold")

// skipError: an action that cannot apply (a deleted status, label or user, nobody to notify)
// is skipped; the rule's other actions go on and the run records the reason.
type skipError struct{ msg string }

func (e skipError) Error() string { return e.msg }

func skip(msg string) error { return skipError{msg} }

// ruleErrText is how an action error reads in the run log: the API reason and message.
func ruleErrText(err error) string {
	var he *httpx.Error
	if errors.As(err, &he) {
		msg := he.Message
		if he.Field != "" {
			msg = he.Field + ": " + msg
		}
		if he.Reason != "" {
			return he.Reason + ": " + msg
		}
		return msg
	}
	return "internal error"
}

// apply runs rule r on task tid for event ev: the condition, then the actions in a savepoint.
// Returns the journal entries the actions wrote (the next level of the chain).
func (e *engine) apply(r *rule, tid uuid.UUID, ev ruleEvent) ([]sqlc.TaskActivity, error) {
	t, ok, err := taskByID(e.ctx, e.tx, tid, true)
	if err != nil || !ok || t.BoardID != r.row.BoardID || t.ArchivedAt != nil {
		return nil, err
	}
	if r.cond != nil {
		hold, err := e.condition(r, t, ev.actor)
		if err != nil {
			e.logRun(r, tid, false, "condition: "+ruleErrText(err), 0)
			return nil, nil
		}
		if !hold {
			if e.sched != nil && !e.sched.done && r.row.ID == e.sched.rule && tid == e.sched.task {
				return nil, errNoMatch
			}
			return nil, nil
		}
	}
	sp, err := e.tx.Begin(e.ctx)
	if err != nil {
		return nil, err
	}
	a := &actx{e: e, q: e.q.WithTx(sp), tx: sp, r: r, br: e.boards[r.row.BoardID], t: t, ev: ev,
		c: &change{rule: &ruleRef{id: r.row.ID, name: r.row.Name}}, fx: &autoEffects{}}
	applied := 0
	var problems []string
	for _, act := range r.actions {
		err := a.do(act)
		var sk skipError
		if errors.As(err, &sk) {
			problems = append(problems, "skipped "+ActionKind(act)+": "+sk.msg)
			continue
		}
		if err != nil {
			if rb := sp.Rollback(e.ctx); rb != nil {
				return nil, rb
			}
			e.logRun(r, tid, false, ActionKind(act)+": "+ruleErrText(err), 0)
			if !errors.As(err, new(*httpx.Error)) {
				slog.WarnContext(e.ctx, "boards: rule action failed", "rule", r.row.ID, "task", tid, "err", err)
			}
			return nil, nil
		}
		applied++
		if a.t, ok, err = taskByID(e.ctx, sp, tid, false); err != nil || !ok {
			if rb := sp.Rollback(e.ctx); rb != nil {
				return nil, rb
			}
			return nil, err
		}
	}
	if err := sp.Commit(e.ctx); err != nil {
		return nil, err
	}
	e.auto.merge(a.fx, a.c, r)
	if len(a.c.notices) > 0 {
		if e.auto.notices == nil {
			e.auto.notices = map[uuid.UUID][]notice{}
		}
		e.auto.notices[tid] = append(e.auto.notices[tid], a.c.notices...)
	}
	e.logRun(r, tid, len(problems) == 0, strings.Join(problems, "; "), applied)
	return a.c.acts, nil
}

// condition checks the rule's TaskFilter on the task as it is now ("me" = who made the change).
func (e *engine) condition(r *rule, t taskRow, actor *uuid.UUID) (bool, error) {
	env := FilterEnv{Today: utcDay(e.s.Now())}
	if actor != nil {
		env.Viewer = *actor
	}
	var a Args
	id := a.Add(t.ID)
	cond, err := Translate(r.cond, env, &a)
	if err != nil {
		return false, err
	}
	var ok bool
	err = e.tx.QueryRow(e.ctx, "SELECT EXISTS (SELECT 1 FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = "+id+" AND ("+cond+"))",
		a.Values()...).Scan(&ok)
	return ok, err
}

func utcDay(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// logRun records one run of a rule (the run row now, the rule's counters in finish).
func (e *engine) logRun(r *rule, task uuid.UUID, ok bool, msg string, applied int) {
	if utf8.RuneCountInString(msg) > 1000 {
		msg = string([]rune(msg)[:1000])
	}
	tl := e.runs[r.row.ID]
	if tl == nil {
		tl = &runTally{r: r}
		e.runs[r.row.ID] = tl
	}
	tl.n++
	tl.lastErr = msg
	if ok {
		tl.lastErr = ""
	}
	if e.sched != nil && !e.sched.done && r.row.ID == e.sched.rule && task == e.sched.task {
		e.sched.done = true
		_ = e.q.FinishScheduledRuleRun(e.ctx, sqlc.FinishScheduledRuleRunParams{RuleID: r.row.ID, TaskID: &task, SchedKey: e.sched.key,
			Ok: ok, Error: msg, ActionsApplied: int16(min(applied, MaxRuleActions))}) //nolint:gosec // ≤ 5
		return
	}
	_ = e.q.InsertBoardRuleRun(e.ctx, sqlc.InsertBoardRuleRunParams{RuleID: r.row.ID, TaskID: &task, TriggerKind: r.row.TriggerKind,
		Ok: ok, Error: msg, ActionsApplied: int16(min(applied, MaxRuleActions))}) //nolint:gosec // ≤ 5
}

// finish writes the rules' counters once per rule, in id order (no lock-order deadlocks between
// transactions), and queues BOARD_RULE_UPDATE for a rule whose error state changed.
func (e *engine) finish() error {
	ids := make([]uuid.UUID, 0, len(e.runs))
	for id := range e.runs {
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	for _, id := range ids {
		tl := e.runs[id]
		row, err := e.q.RecordBoardRuleRuns(e.ctx, sqlc.RecordBoardRuleRunsParams{ID: id, Runs: int32(tl.n), LastError: tl.lastErr}) //nolint:gosec // small
		if err != nil {
			return err
		}
		if tl.r.row.LastError != row.LastError {
			b := e.boards[row.BoardID]
			if b == nil {
				bb, err := e.q.GetBoard(e.ctx, row.BoardID)
				if err != nil {
					return err
				}
				b = &boardRules{b: bb}
			}
			e.auto.events = append(e.auto.events, wsEvent{b.b.WorkspaceID, ruleEvent92(b.b.WorkspaceID, row)})
		}
	}
	return nil
}

func ruleEvent92(ws uuid.UUID, row sqlc.BoardRule) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_BoardRuleUpdate{BoardRuleUpdate: &v1.BoardRuleUpdate{
		WorkspaceId: ws.String(), BoardId: row.BoardID.String(), Rule: ruleProto(row)}}}
}

// publishAuto sends what automation rules did, after the commit.
func (s *Service) publishAuto(ctx context.Context, a *autoEffects) {
	if a.empty() {
		return
	}
	for _, m := range a.messages {
		if err := s.system.Created(ctx, m.ws, m.m); err != nil {
			slog.WarnContext(ctx, "boards: rule message", "err", err)
		}
	}
	gone := map[uuid.UUID]bool{}
	for _, t := range a.archived {
		gone[t.ID] = true
		s.ev.Workspace(ctx, t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskDelete{TaskDelete: &v1.TaskDelete{
			WorkspaceId: t.WorkspaceID.String(), BoardId: t.BoardID.String(), TaskId: t.ID.String()}}})
	}
	for _, id := range a.created {
		gone[id] = true // TASK_CREATE carries it
		s.publishTaskEvent(ctx, id, true)
	}
	for _, id := range a.tasks {
		if !gone[id] {
			s.publishTaskEvent(ctx, id, false)
		}
	}
	for _, cl := range a.checklists {
		c, err := loadChecklist(ctx, s.db.Q, cl.id)
		if err != nil {
			continue
		}
		cnt, err := s.db.Q.TaskChecklistCounts(ctx, cl.t.ID)
		if err != nil {
			continue
		}
		s.ev.Workspace(ctx, cl.t.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskChecklistUpdate{TaskChecklistUpdate: &v1.TaskChecklistUpdate{
			WorkspaceId: cl.t.WorkspaceID.String(), BoardId: cl.t.BoardID.String(), TaskId: cl.t.ID.String(), Checklist: c,
			ChecklistTotal: uint32(max(cnt.Total, 0)), ChecklistDone: uint32(max(cnt.Done, 0))}}}) //nolint:gosec // counts
	}
	for _, x := range a.acts {
		if wsID, err := s.workspaceOf(ctx, x.BoardID); err == nil {
			s.ev.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskActivity{TaskActivity: &v1.TaskActivityAppend{
				WorkspaceId: wsID.String(), TaskId: x.TaskID.String(), Activity: activity(x)}}})
		}
	}
	for task, ns := range a.notices {
		s.sendNotices(ctx, task, ns)
	}
	for _, ev := range a.events {
		s.ev.Workspace(ctx, ev.ws, ev.ev)
	}
}
