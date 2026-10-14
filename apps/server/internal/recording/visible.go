package recording

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// VisibleSQL is the rule of a recording's card (ADR-0033 §4) as SQL over room_recordings rr
// for the rooms p (a uuid[] placeholder) whose VIEW_ROOM the caller has: the recording's own
// room, or a room holding a live forwarded copy of its card. Deleted recordings never match.
// visibleRecording (the transcript / recording endpoints) and unified search (ADR-0062) both
// use it, so they cannot drift apart.
func VisibleSQL(rr, p string) string {
	return "(" + rr + ".deleted_at IS NULL AND (" + rr + ".room_id = ANY(" + p + "::uuid[]) OR (" + rr + ".message_id IS NOT NULL AND EXISTS (" +
		"SELECT 1 FROM messages fm WHERE fm.forwarded_from = " + rr + ".message_id AND fm.room_id = ANY(" + p + "::uuid[]) AND fm.deleted_at IS NULL))))"
}

// VisibleRoomSQL is the room where the card of rr is seen among the rooms p: its own room,
// else (the oldest) one holding a forwarded copy. Use with VisibleSQL.
func VisibleRoomSQL(rr, p string) string {
	return "(CASE WHEN " + rr + ".room_id = ANY(" + p + "::uuid[]) THEN " + rr + ".room_id ELSE (SELECT fm.room_id FROM messages fm WHERE fm.forwarded_from = " +
		rr + ".message_id AND fm.room_id = ANY(" + p + "::uuid[]) AND fm.deleted_at IS NULL ORDER BY fm.id LIMIT 1) END)"
}

// VisibleMessageSQL is the card message of rr in the room of VisibleRoomSQL: its own card,
// else (the oldest) live forwarded copy there. NULL when the card message is gone.
func VisibleMessageSQL(rr, p string) string {
	return "(CASE WHEN " + rr + ".room_id = ANY(" + p + "::uuid[]) THEN " + rr + ".message_id ELSE (SELECT fm.id FROM messages fm WHERE fm.forwarded_from = " +
		rr + ".message_id AND fm.room_id = ANY(" + p + "::uuid[]) AND fm.deleted_at IS NULL ORDER BY fm.id LIMIT 1) END)"
}

// visibleIn reports whether recording id is seen in roomID (VisibleSQL with that one room).
func visibleIn(ctx context.Context, d *db.DB, id, roomID uuid.UUID) (bool, error) {
	var ok bool
	err := d.ReadTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM room_recordings rr WHERE rr.id = $1 AND "+VisibleSQL("rr", "$2")+")",
			id, []uuid.UUID{roomID}).Scan(&ok)
	})
	return ok, err
}

// BackfillBatch is the size of one transcript_text backfill batch.
const BackfillBatch = 200

// BackfillTranscripts fills room_recordings.transcript_text of results stored before 00064 in
// batches of BackfillBatch until none is left (then returns). Idempotent and restart-safe: a
// batch converts rows whose transcript_text is still NULL, locked with SKIP LOCKED, so replicas
// share the work and a restart continues where it stopped. A failing batch is retried after a
// pause; ctx ends it.
func (s *Service) BackfillTranscripts(ctx context.Context) {
	ctx = db.WithoutAdmission(ctx)
	total := 0
	for ctx.Err() == nil {
		n, err := db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (int64, error) {
			return q.BackfillTranscriptText(ctx, BackfillBatch)
		})
		if err != nil {
			slog.WarnContext(ctx, "recording: transcript backfill", "err", err)
			select {
			case <-ctx.Done():
			case <-time.After(time.Minute):
			}
			continue
		}
		total += int(n)
		if n == 0 {
			if total > 0 {
				slog.InfoContext(ctx, "recording: transcript backfill done", "rows", total)
			}
			return
		}
	}
}
