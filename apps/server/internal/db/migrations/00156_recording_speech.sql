-- Speaker names in meeting transcripts (ADR-0169).
--
-- room_recording_speech             when each participant's microphone was on air during a
--                                   recording, as their own client reported it (RecordingSpeech
--                                   over the gateway); start_ms / end_ms from
--                                   room_recordings.started_at. Cleared with the recording's
--                                   result when the recording is deleted.
-- room_recordings.file_started_at   when the recorder's file starts (FileInfo.started_at of the
--                                   egress webhook); NULL = started_at.
-- room_recordings.speakers_json     the speaker numbers matched to people when the transcript
--                                   arrived: [{speaker, user_id?, name?}].

-- +goose Up
SET LOCAL lock_timeout = '10s';

CREATE TABLE room_recording_speech (
    recording_id uuid NOT NULL REFERENCES room_recordings (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    start_ms     integer NOT NULL CHECK (start_ms >= 0),
    end_ms       integer NOT NULL CHECK (end_ms > start_ms)
);
CREATE INDEX room_recording_speech_idx ON room_recording_speech (recording_id, user_id);

ALTER TABLE room_recordings
    ADD COLUMN file_started_at timestamptz,
    ADD COLUMN speakers_json jsonb;

-- +goose Down
SET LOCAL lock_timeout = '10s';

ALTER TABLE room_recordings DROP COLUMN speakers_json, DROP COLUMN file_started_at;
DROP TABLE room_recording_speech;
