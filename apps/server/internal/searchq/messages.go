package searchq

import (
	"bytes"
	"context"
	"slices"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MessageVector is the tsvector of messages m; it must stay the expression of
// messages_search_idx (00003) so that the GIN index serves the match.
const MessageVector = "(to_tsvector('russian', m.content) || to_tsvector('simple', m.content))"

// TSQuery is the tsquery of a Query.TS placeholder for columns indexed with russian || simple.
func TSQuery(p string) string {
	return "(to_tsquery('russian', " + p + ") || to_tsquery('simple', " + p + "))"
}

// MessageMatch is the full-text condition over messages m for a Query.TS placeholder.
func MessageMatch(p string) string { return MessageVector + " @@ " + TSQuery(p) }

// MessageCap is how many matching messages a search considers: the candidates of a ranked feed
// and the bound of total counts.
const MessageCap = 1000

// MessageIDs returns the ids of live messages m matching where (which must contain
// MessageMatch and the room scope; args are its parameters), newest first.
//
// The plan matters on large rooms (lead's audit on PG17, a room of 1.5M messages): ORDER BY id
// DESC LIMIT n makes Postgres walk messages_pkey and recheck every row — 12.5 s for a word
// absent from the room — while the GIN index finds rare words in milliseconds but has to visit
// every match of a frequent one. So: first the GIN path (OFFSET 0 fence, no ORDER BY, at most
// MessageCap+1 rows); when the cap is hit the word is frequent and the newest `need` matches
// are read along the primary key instead (bitmap scans off), which stops early. Sequential
// scans are off throughout.
//
// capped reports that there are more than MessageCap matches; the result then holds the newest
// need (≤ MessageCap) matches only. tx must be a transaction (SET LOCAL).
func MessageIDs(ctx context.Context, tx pgx.Tx, where string, args []any, need int) (ids []uuid.UUID, capped bool, err error) {
	// A sequential scan would recompute the tsvector of every message (a planner misestimate
	// cost 14.8 s on 1.2M rows, docs/14): never.
	if _, err := tx.Exec(ctx, "SET LOCAL enable_seqscan = off"); err != nil {
		return nil, false, err
	}
	ids, err = collectIDs(ctx, tx, "SELECT c.id FROM (SELECT m.id FROM messages m WHERE "+where+
		" OFFSET 0) c LIMIT "+strconv.Itoa(MessageCap+1), args)
	if err != nil {
		return nil, false, err
	}
	if len(ids) <= MessageCap {
		slices.SortFunc(ids, func(a, b uuid.UUID) int { return bytes.Compare(b[:], a[:]) })
		return ids, false, nil
	}
	need = min(max(need, 1), MessageCap)
	if _, err := tx.Exec(ctx, "SET LOCAL enable_bitmapscan = off"); err != nil {
		return nil, false, err
	}
	ids, err = collectIDs(ctx, tx, "SELECT m.id FROM messages m WHERE "+where+
		" ORDER BY m.id DESC LIMIT "+strconv.Itoa(need), args)
	if err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, "SET LOCAL enable_bitmapscan = on"); err != nil {
		return nil, false, err
	}
	return ids, true, nil
}

func collectIDs(ctx context.Context, tx pgx.Tx, sql string, args []any) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
}

// Highlight markers of snippets (SearchHit.snippet): U+0002 starts and U+0003 ends a match.
const (
	MarkStart = "\u0002"
	MarkStop  = "\u0003"
)

// HeadlineOptions are the ts_headline options of every snippet (passed as a parameter).
const HeadlineOptions = "StartSel=\u0002, StopSel=\u0003, MaxFragments=1, MaxWords=18, MinWords=6, FragmentDelimiter=\" … \""

// Headline is ts_headline over text expression col (the markers are stripped from the source
// first) for the tsquery placeholder p and the options placeholder opts.
func Headline(col, p, opts string) string {
	return "ts_headline('russian', translate(" + col + ", E'\\x02\\x03', ''), " + TSQuery(p) + ", " + opts + ")"
}
