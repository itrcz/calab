-- Task history: the comments of a task in its journal (ADR-0091 §3).
--
-- uuidv7_at(ts)  a uuidv7 whose time is ts instead of now(): the RFC 9562 layout of uuidv7()
--                (48-bit Unix ms, version 7, a 12-bit sub-millisecond fraction in rand_a, the
--                variant and 62 random bits), so ids made from times sort as those times (to the
--                microsecond; equal times in random order). Plain SQL: PostgreSQL 17 and 18.
--
-- Backfill: a journal entry "comment" for every live message of a task room (no system messages:
-- the automation cards of rules are not comments, TaskHook never journals them), id from the
-- message's time, actor = author, after = {message_id, text, attachments: [{file_id, name, size,
-- mime}], reply_to_id?, forwarded}. Edits and deletions made before cannot be restored (no previous
-- text). Idempotent: a message that has its "comment" entry (written live by a newer server
-- meanwhile, or by a previous run) is skipped.
--
-- Safe on a populated database: one INSERT … SELECT into task_activity (no lock beyond its rows).

-- +goose Up
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.uuidv7_at(ts timestamptz) RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE
AS $$
    SELECT encode(overlay(uuid_send(gen_random_uuid())
        PLACING int8send(((((floor(extract(epoch FROM ts) * 1000000)::bigint) / 1000) << 16)
            | x'7000'::bigint
            | ((floor(extract(epoch FROM ts) * 1000000)::bigint) % 1000) * 4096 / 1000)) FROM 1 FOR 8), 'hex')::uuid
$$;
-- +goose StatementEnd

INSERT INTO task_activity (id, task_id, board_id, actor_id, kind, before, after, created_at)
SELECT public.uuidv7_at(m.created_at), t.id, t.board_id, m.author_id, 'comment', NULL,
    jsonb_strip_nulls(jsonb_build_object(
        'message_id', m.id::text,
        'text', m.content,
        'attachments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('file_id', f.id::text, 'name', f.name, 'size', f.size, 'mime', f.mime) ORDER BY ma.position)
            FROM message_attachments ma JOIN files f ON f.id = ma.file_id
            WHERE ma.message_id = m.id), '[]'::jsonb),
        'reply_to_id', m.reply_to_id::text,
        'forwarded', m.forwarded_from IS NOT NULL)),
    m.created_at
FROM tasks t
JOIN messages m ON m.room_id = t.room_id
WHERE m.deleted_at IS NULL AND m.kind <> 'system'
  AND NOT EXISTS (
    SELECT 1 FROM task_activity a
    WHERE a.task_id = t.id AND a.kind = 'comment' AND a.after->>'message_id' = m.id::text)
ORDER BY m.id;

-- +goose Down
-- The entries stay (the journal is never cleaned, ADR-0042 §1); only the helper goes.
DROP FUNCTION IF EXISTS public.uuidv7_at(timestamptz);
