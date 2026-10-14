-- Board intake forms and idempotency receipts (ADR-0059).
-- +goose Up
CREATE TABLE board_forms (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    code text NOT NULL UNIQUE CHECK (length(code) = 43),
    definition jsonb NOT NULL,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_forms_board_idx ON board_forms(board_id, created_at, id);
CREATE TABLE board_form_submissions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    form_id uuid NOT NULL REFERENCES board_forms(id) ON DELETE CASCADE,
    nonce uuid NOT NULL,
    request_hash bytea NOT NULL,
    actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (form_id, nonce)
);
CREATE INDEX board_form_submissions_task_idx ON board_form_submissions(task_id) WHERE task_id IS NOT NULL;

-- +goose Down
DROP TABLE board_form_submissions;
DROP TABLE board_forms;
