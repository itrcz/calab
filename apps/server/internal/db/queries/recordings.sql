-- ADR-0025: GPTunneL integration and meeting recordings.

-- name: GetIntegration :one
SELECT * FROM workspace_integrations WHERE workspace_id = $1 AND kind = $2;

-- name: PutIntegration :one
INSERT INTO workspace_integrations (workspace_id, kind, token_enc, device_id, device_name, account, web_url, paired_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (workspace_id, kind) DO UPDATE
SET token_enc = excluded.token_enc, device_id = excluded.device_id, device_name = excluded.device_name,
    account = excluded.account, web_url = excluded.web_url, paired_by = excluded.paired_by,
    paired_at = now(), revoked_at = NULL
RETURNING *;

-- name: RevokeIntegration :execrows
-- Forgets the token. token_enc = the token being revoked (NULL = any): a token paired again
-- meanwhile is not dropped because the old one was rejected.
UPDATE workspace_integrations SET token_enc = NULL, revoked_at = now()
WHERE workspace_id = $1 AND kind = $2 AND token_enc IS NOT NULL
  AND (sqlc.narg('token_enc')::bytea IS NULL OR token_enc = sqlc.narg('token_enc')::bytea);

-- name: LockRecordings :exec
-- Serializes starts: the concurrent-recordings limit is counted under this lock.
SELECT pg_advisory_xact_lock(hashtext('room_recordings.start'));

-- name: CountActiveRecordings :one
SELECT count(*) FROM room_recordings WHERE status IN ('pending', 'recording');

-- name: InsertRecording :one
INSERT INTO room_recordings (id, workspace_id, room_id, started_by, file)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetRecording :one
SELECT * FROM room_recordings WHERE id = $1;

-- name: GetRecordingByEgress :one
SELECT * FROM room_recordings WHERE egress_id = $1;

-- name: GetActiveRecording :one
SELECT * FROM room_recordings WHERE room_id = $1 AND status IN ('pending', 'recording');

-- name: ListActiveRecordings :many
-- Recordings in progress: all (workspace_id NULL) or of one workspace.
SELECT * FROM room_recordings
WHERE status IN ('pending', 'recording')
  AND (sqlc.narg('workspace_id')::uuid IS NULL OR workspace_id = sqlc.narg('workspace_id')::uuid)
ORDER BY id;

-- name: MarkRecordingStarted :one
UPDATE room_recordings SET status = 'recording', egress_id = $2, started_at = now(), updated_at = now()
WHERE id = $1 AND status = 'pending'
RETURNING *;

-- name: MarkRecordingStopRequested :one
-- The stop is on its way to the recorder; the row stays 'recording' until the recorder ends
-- (webhook / reconcile) and reports the file.
UPDATE room_recordings SET stopped_at = coalesce(stopped_at, now()), stop_reason = CASE WHEN stop_reason = '' THEN $2 ELSE stop_reason END,
    stopped_by = coalesce(stopped_by, sqlc.narg('stopped_by')::uuid), updated_at = now()
WHERE id = $1 AND status IN ('pending', 'recording')
RETURNING *;

-- name: SetRecordingEmptySince :exec
UPDATE room_recordings SET empty_since = $2 WHERE id = $1 AND status = 'recording';

-- name: MarkRecordingEnded :one
-- The recorder finished with a file: queue the upload.
UPDATE room_recordings SET status = 'uploading', size_bytes = $2, duration_sec = $3,
    stopped_at = coalesce(stopped_at, now()), stop_reason = CASE WHEN stop_reason = '' THEN $4 ELSE stop_reason END,
    next_at = now(), attempts = 0, error = '', updated_at = now()
WHERE id = $1 AND status IN ('pending', 'recording')
RETURNING *;

-- name: MarkRecordingFailed :one
-- Terminal failure at any stage (the file, if any, is removed by the janitor).
UPDATE room_recordings SET status = 'failed', error = $2, next_at = NULL,
    stopped_at = coalesce(stopped_at, now()), stop_reason = CASE WHEN stop_reason = '' THEN sqlc.arg('stop_reason')::text ELSE stop_reason END,
    updated_at = now()
WHERE id = $1 AND status NOT IN ('done', 'failed')
RETURNING *;

-- name: ClaimRecordingJobs :many
-- Due uploads / status polls; claimed rows are leased (next_at moves one lease ahead), so a
-- crashed worker's jobs are retried later and a second worker skips them.
UPDATE room_recordings SET next_at = now() + sqlc.arg('lease')::interval
WHERE id IN (
    SELECT r.id FROM room_recordings r
    WHERE r.status IN ('uploading', 'processing') AND r.next_at <= now() AND r.deleted_at IS NULL
    ORDER BY r.next_at
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: SetRecordingGptunnelID :exec
UPDATE room_recordings SET gptunnel_id = $2, updated_at = now() WHERE id = $1;

-- name: RetryRecording :exec
UPDATE room_recordings SET attempts = attempts + 1, next_at = $2, error = $3, updated_at = now()
WHERE id = $1 AND status IN ('uploading', 'processing');

-- name: MarkRecordingProcessing :one
UPDATE room_recordings SET status = 'processing', gptunnel_id = $2, web_url = $3, next_at = $4,
    attempts = 0, error = '', processing_since = now(), updated_at = now()
WHERE id = $1 AND status = 'uploading'
RETURNING *;

-- name: PollRecordingLater :exec
UPDATE room_recordings SET next_at = $2, web_url = CASE WHEN sqlc.arg('web_url')::text <> '' THEN sqlc.arg('web_url')::text ELSE web_url END, updated_at = now()
WHERE id = $1 AND status = 'processing';

-- name: MarkRecordingDone :one
-- Done in GPTunneL: queue the result job (keep the audio, fetch the summary and transcript).
UPDATE room_recordings SET status = 'done', web_url = CASE WHEN sqlc.arg('web_url')::text <> '' THEN sqlc.arg('web_url')::text ELSE web_url END,
    next_at = NULL, error = '', done_at = now(), result_state = 'pending', result_attempts = 0, result_next_at = now(),
    updated_at = now()
WHERE id = sqlc.arg('id') AND status = 'processing'
RETURNING *;

-- name: RecheckRecording :one
-- «Проверить снова»: a failed recording that reached GPTunneL's processing is polled again,
-- the poll window starting now.
UPDATE room_recordings SET status = 'processing', processing_since = now(), next_at = now(),
    attempts = 0, error = '', updated_at = now()
WHERE id = $1 AND status = 'failed' AND gptunnel_id <> '' AND processing_since IS NOT NULL AND deleted_at IS NULL
RETURNING *;

-- name: ReuploadRecording :one
-- «Отправить снова»: a failed recording whose upload did not complete and whose file is still
-- here is uploaded again as a new GPTunneL recording (a partial one there is abandoned).
UPDATE room_recordings SET status = 'uploading', gptunnel_id = '', web_url = '',
    next_at = now(), attempts = 0, error = '', reuploads = reuploads + 1, reupload_at = now(), updated_at = now()
WHERE id = $1 AND status = 'failed' AND processing_since IS NULL
  AND file <> '' AND file_deleted_at IS NULL AND size_bytes > 0 AND deleted_at IS NULL
RETURNING *;

-- name: SetRecordingMessage :exec
UPDATE room_recordings SET message_id = $2 WHERE id = $1;

-- name: ListRecordingFilesToDelete :many
-- Local files no longer needed: done (once its audio was attached or given up), deleted, or
-- failed / stuck and stopped (or last sent again) before `before` (7 days).
SELECT * FROM room_recordings
WHERE file <> '' AND file_deleted_at IS NULL
  AND ((status = 'done' AND result_state <> 'pending') OR deleted_at IS NOT NULL
       OR (status NOT IN ('pending', 'recording') AND coalesce(reupload_at, stopped_at) < sqlc.arg('before')))
ORDER BY id
LIMIT 100;

-- name: MarkRecordingFileDeleted :exec
UPDATE room_recordings SET file_deleted_at = now() WHERE id = $1;

-- name: ClaimRecordingResults :many
-- Due result jobs of done recordings (attach the audio, fetch the summary / transcript), leased
-- like ClaimRecordingJobs.
UPDATE room_recordings SET result_next_at = now() + sqlc.arg('lease')::interval
WHERE id IN (
    SELECT r.id FROM room_recordings r
    WHERE r.result_state = 'pending' AND r.result_next_at <= now() AND r.deleted_at IS NULL
    ORDER BY r.result_next_at
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: SetRecordingAudio :one
UPDATE room_recordings SET file_id = $2, updated_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: SetRecordingResult :one
-- The result job ended: ready (with whatever GPTunneL gave) or unavailable. transcript_text is
-- the segments' texts one per line (unified search, ADR-0062; same expression as
-- BackfillTranscriptText); NULL without a transcript.
UPDATE room_recordings SET summary = sqlc.arg('summary'), language = sqlc.arg('language'),
    transcript_json = sqlc.narg('transcript_json')::jsonb,
    transcript_text = CASE WHEN sqlc.narg('transcript_json')::jsonb IS NULL THEN NULL ELSE coalesce((
        SELECT string_agg(s.seg->>'text', E'\n' ORDER BY s.ord)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sqlc.narg('transcript_json')::jsonb) = 'array'
                                       THEN sqlc.narg('transcript_json')::jsonb ELSE '[]'::jsonb END)
             WITH ORDINALITY AS s (seg, ord)), '') END,
    result_state = sqlc.arg('result_state'), result_next_at = NULL, updated_at = now()
WHERE id = sqlc.arg('id') AND result_state = 'pending' AND deleted_at IS NULL
RETURNING *;

-- name: BackfillTranscriptText :execrows
-- One batch of the transcript_text backfill (00064): results stored before the column existed.
-- SKIP LOCKED: replicas share the work; a row is never converted twice (transcript_text IS NULL).
UPDATE room_recordings r SET transcript_text = coalesce((
        SELECT string_agg(s.seg->>'text', E'\n' ORDER BY s.ord)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.transcript_json) = 'array'
                                       THEN r.transcript_json ELSE '[]'::jsonb END)
             WITH ORDINALITY AS s (seg, ord)), '')
WHERE r.id IN (
    SELECT x.id FROM room_recordings x
    WHERE x.transcript_json IS NOT NULL AND x.transcript_text IS NULL
    ORDER BY x.id
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
);

-- name: RetryRecordingResult :exec
UPDATE room_recordings SET result_attempts = result_attempts + 1, result_next_at = $2, updated_at = now()
WHERE id = $1 AND result_state = 'pending';

-- name: GetRecordingTranscript :one
SELECT language, transcript_json FROM room_recordings
WHERE id = $1 AND room_id = $2 AND deleted_at IS NULL AND transcript_json IS NOT NULL;

-- name: ListExpiredRecordingAudio :many
-- Audio attachments of done recordings older than RECORDING_KEEP_DAYS.
SELECT * FROM room_recordings
WHERE file_id IS NOT NULL AND done_at < sqlc.arg('before')
ORDER BY done_at
LIMIT 100;

-- name: ClearRecordingAudio :one
UPDATE room_recordings SET file_id = NULL, updated_at = now()
WHERE id = $1 AND file_id = $2
RETURNING *;

-- name: DeleteRecording :one
-- «Удалить запись» (docs/09 #50): the row stays for its card; the result, the audio link and any
-- pending work go. An upload / poll in flight is ended as failed ('deleted').
UPDATE room_recordings SET deleted_at = now(), deleted_by = sqlc.narg('deleted_by')::uuid,
    status = CASE WHEN status IN ('uploading', 'processing') THEN 'failed' ELSE status END,
    error = CASE WHEN status IN ('uploading', 'processing') THEN 'deleted' ELSE error END,
    next_at = NULL, summary = '', language = '', transcript_json = NULL, transcript_text = NULL,
    result_state = CASE WHEN result_state = 'pending' THEN 'unavailable' ELSE result_state END,
    result_next_at = NULL, file_id = NULL, updated_at = now()
WHERE id = $1 AND deleted_at IS NULL AND status NOT IN ('pending', 'recording')
RETURNING *;

-- name: ListStalePendingRecordings :many
-- Rows whose recorder never started (the server died between insert and StartEgress).
SELECT * FROM room_recordings WHERE status = 'pending' AND started_at < sqlc.arg('before');

-- name: InsertSystemMessage :one
INSERT INTO messages (room_id, author_id, content, kind, payload)
VALUES ($1, $2, '', 'system', $3)
RETURNING *;

-- name: UpdateSystemMessage :one
UPDATE messages SET payload = $2 WHERE id = $1 AND kind = 'system' AND deleted_at IS NULL
RETURNING *;

-- name: UpdateForwardedSystemMessages :many
-- The live forwarded copies of a recording card follow it (ADR-0033 §4).
UPDATE messages SET payload = $2
WHERE forwarded_from = $1 AND kind = 'system' AND deleted_at IS NULL
RETURNING *;

-- name: RoomAudience :one
-- Who gets a room's events outside a request: its workspace, or a DM's (a shelf's) members.
SELECT r.workspace_id, (r.workspace_id IS NULL)::boolean AS dm,
    array(SELECT d.user_id FROM dm_members d WHERE d.room_id = r.id ORDER BY d.user_id)::uuid[] AS dm_members
FROM rooms r WHERE r.id = $1;

-- name: AttachToForwardedCopies :exec
-- The audio arrives after the card may have been forwarded: its live copies get it too.
INSERT INTO message_attachments (message_id, file_id, position, forwarded)
SELECT m.id, sqlc.arg('file_id')::uuid, 0, true FROM messages m
WHERE m.forwarded_from = sqlc.arg('message_id')::uuid AND m.deleted_at IS NULL
ON CONFLICT DO NOTHING;
