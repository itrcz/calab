-- name: ListBoardForms :many
SELECT * FROM board_forms WHERE board_id = $1 ORDER BY created_at, id;

-- name: GetBoardForm :one
SELECT * FROM board_forms WHERE id = $1 AND board_id = $2;

-- name: GetBoardFormByCode :one
SELECT * FROM board_forms WHERE code = $1;

-- name: GetBoardFormWorkspace :one
SELECT b.workspace_id FROM board_forms f JOIN boards b ON b.id = f.board_id WHERE f.code = $1;

-- name: CountBoardForms :one
SELECT count(*) FROM board_forms WHERE board_id = $1;

-- name: InsertBoardForm :one
INSERT INTO board_forms (board_id, code, definition, created_by) VALUES ($1, $2, $3, $4) RETURNING *;

-- name: UpdateBoardForm :one
UPDATE board_forms SET definition = $3, revision = revision + 1, updated_at = now()
WHERE id = $1 AND board_id = $2 AND revision = $4 RETURNING *;

-- name: DeleteBoardForm :execrows
DELETE FROM board_forms WHERE id = $1 AND board_id = $2;

-- name: GetBoardFormSubmission :one
SELECT * FROM board_form_submissions WHERE form_id = $1 AND nonce = $2;

-- name: InsertBoardFormSubmission :one
INSERT INTO board_form_submissions (form_id, nonce, request_hash, actor_id, task_id)
VALUES ($1, $2, $3, $4, $5) RETURNING *;
