-- Board automations (ADR-0060): rules, their runs, the board's Git webhook and task Git links.

-- ---- rules ----

-- name: ListBoardRules :many
SELECT * FROM board_rules WHERE board_id = $1 ORDER BY position, id;

-- name: ListEnabledBoardRules :many
-- The rules a change of the board may run (board_rules_enabled_idx): one lookup per board and
-- transaction; a board without rules costs this probe only.
SELECT * FROM board_rules WHERE board_id = $1 AND enabled ORDER BY position, id;

-- name: GetBoardRule :one
SELECT * FROM board_rules WHERE id = $1;

-- name: GetBoardRuleForUpdate :one
SELECT * FROM board_rules WHERE id = $1 FOR UPDATE;

-- name: GetBoardRuleWorkspace :one
-- The workspace of a rule (identity route resolution).
SELECT b.workspace_id FROM board_rules r JOIN boards b ON b.id = r.board_id WHERE r.id = $1;

-- name: CountBoardRules :one
SELECT count(*)::integer FROM board_rules WHERE board_id = $1;

-- name: BoardRuleCounts :many
SELECT board_id, count(*)::integer AS rules FROM board_rules
WHERE board_id = ANY(sqlc.arg('board_ids')::uuid[]) GROUP BY board_id;

-- name: CreateBoardRule :one
INSERT INTO board_rules (board_id, name, enabled, position, trigger_kind, trigger, condition, actions, created_by)
VALUES (sqlc.arg('board_id'), sqlc.arg('name'), sqlc.arg('enabled'),
        (SELECT coalesce(max(position) + 1, 0) FROM board_rules WHERE board_id = sqlc.arg('board_id')),
        sqlc.arg('trigger_kind'), sqlc.arg('trigger'), sqlc.narg('condition'), sqlc.arg('actions'), sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateBoardRule :one
UPDATE board_rules SET name = sqlc.arg('name'), enabled = sqlc.arg('enabled'), trigger_kind = sqlc.arg('trigger_kind'),
    trigger = sqlc.arg('trigger'), condition = sqlc.narg('condition'), actions = sqlc.arg('actions'), updated_at = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetBoardRulePosition :exec
UPDATE board_rules SET position = $2 WHERE id = $1;

-- name: DeleteBoardRule :execrows
DELETE FROM board_rules WHERE id = $1;

-- name: RecordBoardRuleRuns :one
-- After the runs of one transaction (once per rule, in rule id order): the counters and the
-- error state (last_error of the last run, '' when it was clean).
UPDATE board_rules SET runs_count = runs_count + sqlc.arg('runs')::integer, last_run_at = now(),
    last_error = sqlc.arg('last_error')
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: InsertBoardRuleRun :exec
INSERT INTO board_rule_runs (rule_id, task_id, trigger_kind, ok, error, actions_applied, sched_key)
VALUES (sqlc.arg('rule_id'), sqlc.narg('task_id'), sqlc.arg('trigger_kind'), sqlc.arg('ok'), sqlc.arg('error'),
        sqlc.arg('actions_applied'), sqlc.narg('sched_key'));

-- name: ClaimScheduledRuleRun :execrows
-- A scheduled trigger fires once per (rule, task, key date): the claim row is the run itself,
-- updated with the outcome in the same transaction.
INSERT INTO board_rule_runs (rule_id, task_id, trigger_kind, ok, sched_key)
VALUES (sqlc.arg('rule_id'), sqlc.arg('task_id'), sqlc.arg('trigger_kind'), true, sqlc.arg('sched_key'))
ON CONFLICT (rule_id, task_id, sched_key) WHERE sched_key IS NOT NULL DO NOTHING;

-- name: FinishScheduledRuleRun :exec
UPDATE board_rule_runs SET ok = sqlc.arg('ok'), error = sqlc.arg('error'), actions_applied = sqlc.arg('actions_applied')
WHERE rule_id = sqlc.arg('rule_id') AND task_id = sqlc.arg('task_id') AND sched_key = sqlc.arg('sched_key');

-- name: ListRuleRuns :many
SELECT * FROM board_rule_runs WHERE rule_id = $1 ORDER BY created_at DESC, id DESC LIMIT sqlc.arg('lim');

-- name: TrimRuleRuns :execrows
-- The sweeper: runs older than 90 days and all but the newest 100 of each rule.
DELETE FROM board_rule_runs WHERE id IN (
    SELECT x.id FROM (
        SELECT id, created_at, row_number() OVER (PARTITION BY rule_id ORDER BY created_at DESC, id DESC) AS n
        FROM board_rule_runs
    ) x WHERE x.n > 100 OR x.created_at < now() - interval '90 days'
    LIMIT 5000
);

-- name: ListScheduledRules :many
-- Enabled scheduled rules of live boards (board_rules_scheduled_idx).
SELECT r.* FROM board_rules r JOIN boards b ON b.id = r.board_id AND b.archived_at IS NULL
WHERE r.enabled AND r.trigger_kind IN ('due_in', 'overdue', 'stale')
ORDER BY r.board_id, r.position;

-- ---- Git ----

-- name: GetBoardGit :one
SELECT * FROM board_git WHERE board_id = $1;

-- name: UpsertBoardGit :one
INSERT INTO board_git (board_id, provider, secret_enc, created_by)
VALUES (sqlc.arg('board_id'), sqlc.arg('provider'), sqlc.arg('secret_enc'), sqlc.narg('created_by'))
ON CONFLICT (board_id) DO UPDATE SET provider = excluded.provider, secret_enc = excluded.secret_enc,
    created_by = excluded.created_by, created_at = now(), last_error = '', events_count = 0, last_event_at = NULL
RETURNING *;

-- name: DeleteBoardGit :execrows
DELETE FROM board_git WHERE board_id = $1;

-- name: RecordBoardGitEvent :exec
UPDATE board_git SET last_event_at = now(), events_count = events_count + 1, last_error = sqlc.arg('last_error')
WHERE board_id = sqlc.arg('board_id');

-- name: ListTaskGitLinks :many
SELECT * FROM task_git_links WHERE task_id = $1 ORDER BY updated_at DESC, id DESC;

-- name: GetTaskGitLink :one
SELECT * FROM task_git_links
WHERE task_id = $1 AND kind = $2 AND provider = $3 AND repo = $4 AND ref = $5;

-- name: UpsertTaskGitLink :one
INSERT INTO task_git_links (task_id, kind, provider, repo, ref, title, url, state, author)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (task_id, kind, provider, repo, ref) DO UPDATE SET title = excluded.title, url = excluded.url,
    state = excluded.state, author = CASE WHEN excluded.author = '' THEN task_git_links.author ELSE excluded.author END,
    updated_at = now()
RETURNING *;

-- name: TrimTaskGitLinks :execrows
-- ≤ 50 links per task: the oldest commits go first, then the oldest others.
DELETE FROM task_git_links d WHERE d.id IN (
    SELECT o.id FROM task_git_links o WHERE o.task_id = sqlc.arg('task_id')::uuid
    ORDER BY (o.kind = 'commit') DESC, o.updated_at, o.id
    LIMIT greatest((SELECT count(*) FROM task_git_links c WHERE c.task_id = sqlc.arg('task_id')::uuid) - 50, 0)
);
