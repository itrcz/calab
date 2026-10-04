-- Board automations (ADR-0060): rules «Когда → Если → Тогда» and Git links of tasks.
--
-- board_rules          ≤ 20 per board (enforced by the server); trigger / condition / actions are
--                      protojson (RuleTrigger, TaskFilter, RuleAction[]); trigger_kind is the
--                      oneof name of the trigger (sweeper and matching without parsing).
-- board_rule_runs      the log of a rule (≤ 100 per rule, 90 days: the boards sweeper trims);
--                      sched_key makes a scheduled trigger fire once per (rule, task, key date).
-- board_git            the Git webhook of a board: provider and its sealed secret.
-- task_git_links       branches / pull requests / commits mentioning a task (≤ 50 per task).
-- task_activity.rule_id the rule that made a journal entry (actor_id NULL then); no foreign key:
--                      the journal outlives deleted rules and the column is added without a scan.
--
-- Safe on a populated database: task_activity only gets a nullable column without a default
-- (metadata only); every index is on a new, empty table.

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE board_rules (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id     uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    enabled      boolean NOT NULL DEFAULT true,
    position     integer NOT NULL DEFAULT 0,
    trigger_kind text NOT NULL,
    trigger      jsonb NOT NULL,
    condition    jsonb,
    actions      jsonb NOT NULL,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    runs_count   integer NOT NULL DEFAULT 0,
    last_run_at  timestamptz,
    last_error   text NOT NULL DEFAULT ''
);
CREATE INDEX board_rules_board_idx ON board_rules (board_id, position);
CREATE INDEX board_rules_enabled_idx ON board_rules (board_id) WHERE enabled;
CREATE INDEX board_rules_scheduled_idx ON board_rules (trigger_kind)
    WHERE enabled AND trigger_kind IN ('due_in', 'overdue', 'stale');
CREATE INDEX board_rules_created_by_idx ON board_rules (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE board_rule_runs (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    rule_id         uuid NOT NULL REFERENCES board_rules (id) ON DELETE CASCADE,
    task_id         uuid REFERENCES tasks (id) ON DELETE SET NULL,
    trigger_kind    text NOT NULL,
    ok              boolean NOT NULL,
    error           text NOT NULL DEFAULT '',
    actions_applied smallint NOT NULL DEFAULT 0,
    sched_key       date,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_rule_runs_rule_idx ON board_rule_runs (rule_id, created_at DESC);
CREATE INDEX board_rule_runs_task_idx ON board_rule_runs (task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX board_rule_runs_sched_idx ON board_rule_runs (rule_id, task_id, sched_key)
    WHERE sched_key IS NOT NULL;
CREATE INDEX board_rule_runs_created_idx ON board_rule_runs (created_at);

CREATE TABLE board_git (
    board_id      uuid PRIMARY KEY REFERENCES boards (id) ON DELETE CASCADE,
    provider      text NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea')),
    secret_enc    bytea NOT NULL,
    created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_event_at timestamptz,
    last_error    text NOT NULL DEFAULT '',
    events_count  integer NOT NULL DEFAULT 0
);
CREATE INDEX board_git_created_by_idx ON board_git (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE task_git_links (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    task_id    uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('branch', 'pr', 'commit')),
    provider   text NOT NULL CHECK (provider IN ('github', 'gitlab', 'gitea')),
    repo       text NOT NULL CHECK (char_length(repo) BETWEEN 1 AND 300),
    ref        text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 300),
    title      text NOT NULL DEFAULT '' CHECK (char_length(title) <= 200),
    url        text NOT NULL DEFAULT '' CHECK (char_length(url) <= 2048),
    state      text NOT NULL DEFAULT '' CHECK (state IN ('open', 'merged', 'closed', '')),
    author     text NOT NULL DEFAULT '' CHECK (char_length(author) <= 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- also the index of a task's links (task_id leads)
    UNIQUE (task_id, kind, provider, repo, ref)
);

ALTER TABLE task_activity ADD COLUMN rule_id uuid;

-- +goose Down
ALTER TABLE task_activity DROP COLUMN rule_id;
DROP TABLE task_git_links;
DROP TABLE board_git;
DROP TABLE board_rule_runs;
DROP TABLE board_rules;
