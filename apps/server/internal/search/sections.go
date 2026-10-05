package search

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/recording"
	"github.com/calaba/calaba/server/internal/searchq"
)

// candidateCap bounds what a section considers: ranking happens among at most this many matches
// (key matches first, then the newest), and total_estimate counts up to it.
const candidateCap = searchq.MessageCap

// transcriptCandidates: transcripts are ordered by recency (ranking long texts would mean
// parsing each of them per query).
const transcriptCandidates = 200

// fresh is the freshness factor 1 / (1 + days / 30) of timestamp column col at reference now.
func fresh(col, now string) string {
	return "(1.0 / (1.0 + greatest(0, extract(epoch FROM (" + now + "::timestamptz - " + col + ")))::float8 / 2592000.0))"
}

// keyset adds the cursor condition and order of a page over inner (columns id and score) and
// returns the page SQL (limit+1 rows: one more tells there is a next page).
func keyset(inner string, rel bool, req *request, a *boards.Args) string {
	sql := "SELECT * FROM (" + inner + ") c"
	if req.cur != nil {
		if rel {
			r := a.Add(req.cur.R)
			sql += " WHERE (c.score < " + r + "::float8 OR (c.score = " + r + "::float8 AND c.id < " + a.Add(req.cur.id()) + "::uuid))"
		} else {
			sql += " WHERE c.id < " + a.Add(req.cur.id()) + "::uuid"
		}
	}
	return sql + order(rel, "c") + " LIMIT " + strconv.Itoa(req.limit+1)
}

func order(rel bool, alias string) string {
	if rel {
		return " ORDER BY " + alias + ".score DESC, " + alias + ".id DESC"
	}
	return " ORDER BY " + alias + ".id DESC"
}

// newer is the "newest first" cursor condition on the id column col ("" otherwise).
func newer(col string, rel bool, req *request, a *boards.Args) string {
	if rel || req.cur == nil {
		return ""
	}
	return " AND " + col + " < " + a.Add(req.cur.id()) + "::uuid"
}

// ranked is the page query of a section over capped candidates. cands is a complete SELECT
// (with an id column) whose rows are taken in the order first, at most candidateCap; score is
// computed over them as alias (relevance only: callers build score only then, so that no
// parameter is left unused); the result has the candidates' columns, score and total (the
// number of candidates), keyset-paged.
func ranked(cands, first, alias, score string, rel bool, req *request, a *boards.Args) string {
	if !rel {
		score = "0::float8"
	}
	return "WITH c AS MATERIALIZED (" + cands + " ORDER BY " + first + " LIMIT " + strconv.Itoa(candidateCap) + "), " +
		"s AS (SELECT " + alias + ".*, " + score + " AS score, (SELECT count(*) FROM c) AS total FROM c AS " + alias + ") " +
		keyset("SELECT * FROM s", rel, req, a)
}

// page trims rows to the limit and sets the section's next cursor (feeds only).
func page[T any](req *request, sec *v1.SearchSection, rows []T, key func(T) (float64, uuid.UUID)) []T {
	if len(rows) <= req.limit {
		return rows
	}
	rows = rows[:req.limit]
	if req.feed {
		score, id := key(rows[len(rows)-1])
		sec.NextCursor = req.encodeCursor(sec.Type, score, id)
	}
	return rows
}

// total sets total_estimate on the first page.
func total(req *request, sec *v1.SearchSection, n int64) {
	if req.cur == nil {
		sec.TotalEstimate = uint32(min(n, candidateCap)) //nolint:gosec // ≤ candidateCap
	}
}

func ts(t time.Time) *timestamppb.Timestamp { return timestamppb.New(t) }

func str(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

// ---- messages, task comments, notes ----

// msgScope is the SQL condition over messages m of a messages-like section ("" = nothing to
// search): the rooms the caller views and their DMs (after their «Удалить чат» mark), the task
// rooms of the tasks they see (TaskBits != 0), their own notes shelves. Always a room_id = ANY
// list, so that the room index can narrow the full-text index (BitmapAnd).
func (sc *scope) msgScope(ctx context.Context, tx pgx.Tx, t v1.SearchType, a *boards.Args) (string, error) {
	var rooms []uuid.UUID
	extra := ""
	switch t {
	case v1.SearchType_SEARCH_TYPE_MESSAGES:
		var cr, cs []uuid.UUID
		for _, sp := range sc.wss {
			rooms = append(rooms, sp.rooms...)
		}
		for _, d := range sc.dms {
			rooms = append(rooms, d.id)
			if d.since != nil {
				cr, cs = append(cr, d.id), append(cs, *d.since)
			}
		}
		if len(cr) > 0 {
			extra = " AND NOT EXISTS (SELECT 1 FROM unnest(" + a.Add(cr) + "::uuid[], " + a.Add(cs) + "::uuid[]) AS x (r, s) WHERE x.r = m.room_id AND m.id <= x.s)"
		}
	case v1.SearchType_SEARCH_TYPE_TASK_COMMENTS:
		var b boards.Args
		var vis []string
		for _, sp := range sc.wss {
			if !sp.boards.Empty() {
				vis = append(vis, sp.boards.Cond(&b))
			}
		}
		if len(vis) == 0 {
			return "", nil
		}
		rows, err := tx.Query(ctx, "SELECT t.room_id FROM tasks t WHERE "+strings.Join(vis, " OR "), b.Values()...)
		if err != nil {
			return "", err
		}
		if rooms, err = pgx.CollectRows(rows, pgx.RowTo[uuid.UUID]); err != nil {
			return "", err
		}
	case v1.SearchType_SEARCH_TYPE_NOTES:
		rooms = sc.notes
	}
	if len(rooms) == 0 {
		return "", nil
	}
	return "m.room_id = ANY(" + a.Add(rooms) + "::uuid[])" + extra, nil
}

type msgRow struct {
	id, room            uuid.UUID
	author              uuid.UUID
	at                  time.Time
	score               float64
	ws                  *uuid.UUID
	snippet             string
	taskID              *uuid.UUID
	boardKey, taskTitle *string
	taskNumber          *int32
}

// messages runs a messages-like section (messages, task comments, notes): the candidates come
// from searchq.MessageIDs (GIN first, the primary key for frequent words), the page is ranked
// (relevance: ts_rank_cd × freshness among the newest MessageCap matches) or newest first.
func (s *Service) messages(ctx context.Context, tx pgx.Tx, req *request, sc *scope, sec *v1.SearchSection) error {
	t := sec.Type
	var a boards.Args
	cond, err := sc.msgScope(ctx, tx, t, &a)
	if err != nil || cond == "" {
		return err
	}
	where := cond + " AND m.deleted_at IS NULL AND " + searchq.MessageMatch(a.Add(req.q.TS))
	rel := req.relevance(t)
	need := req.limit + 1
	if rel {
		need = searchq.MessageCap
	}
	where += newer("m.id", rel, req, &a)
	ids, capped, err := searchq.MessageIDs(ctx, tx, where, a.Values(), need)
	if err != nil {
		return err
	}
	if capped {
		total(req, sec, candidateCap)
	} else {
		total(req, sec, int64(len(ids)))
	}
	if len(ids) == 0 {
		return nil
	}
	if !rel && len(ids) > req.limit+1 {
		ids = ids[:req.limit+1]
	}
	var b boards.Args
	tsq := b.Add(req.q.TS)
	score := "0::float8"
	if rel {
		score = "(ts_rank_cd(" + searchq.MessageVector + ", " + searchq.TSQuery(tsq) + ") * " + fresh("m.created_at", b.Add(req.now)) + ")::float8"
	}
	inner := "SELECT m.id, m.room_id, m.author_id, m.created_at, m.content, " + score + " AS score FROM messages m WHERE m.id = ANY(" + b.Add(ids) + "::uuid[]) AND m.deleted_at IS NULL" // deleted meanwhile (read committed)
	task := "NULL::uuid, NULL::text, NULL::integer, NULL::text"
	join := ""
	if t == v1.SearchType_SEARCH_TYPE_TASK_COMMENTS {
		task = "t.id, bd.key, t.number, t.title"
		join = " LEFT JOIN tasks t ON t.room_id = p.room_id LEFT JOIN boards bd ON bd.id = t.board_id"
	}
	sql := "SELECT p.id, p.room_id, p.author_id, p.created_at, p.score, r.workspace_id, " +
		searchq.Headline("p.content", tsq, b.Add(searchq.HeadlineOptions)) + ", " + task +
		" FROM (" + keyset(inner, rel, req, &b) + ") p LEFT JOIN rooms r ON r.id = p.room_id" + join + order(rel, "p")
	rows, err := tx.Query(ctx, sql, b.Values()...)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (msgRow, error) {
		var m msgRow
		err := row.Scan(&m.id, &m.room, &m.author, &m.at, &m.score, &m.ws, &m.snippet, &m.taskID, &m.boardKey, &m.taskNumber, &m.taskTitle)
		return m, err
	})
	if err != nil {
		return err
	}
	for _, m := range page(req, sec, list, func(m msgRow) (float64, uuid.UUID) { return m.score, m.id }) {
		h := &v1.SearchHit{Snippet: m.snippet, WorkspaceId: str(m.ws), At: ts(m.at), AuthorId: m.author.String()}
		ref := &v1.SearchMessageRef{MessageId: m.id.String(), RoomId: m.room.String()}
		switch t {
		case v1.SearchType_SEARCH_TYPE_TASK_COMMENTS:
			c := &v1.SearchTaskCommentRef{MessageId: ref.MessageId, RoomId: ref.RoomId, TaskId: str(m.taskID)}
			if m.boardKey != nil && m.taskNumber != nil {
				c.TaskKey = boards.TaskKey(*m.boardKey, *m.taskNumber)
			}
			if m.taskTitle != nil {
				c.TaskTitle = *m.taskTitle
			}
			h.Ref = &v1.SearchHit_TaskComment{TaskComment: c}
		case v1.SearchType_SEARCH_TYPE_NOTES:
			h.Ref = &v1.SearchHit_Note{Note: ref}
		default:
			h.Ref = &v1.SearchHit_Message{Message: ref}
		}
		sec.Items = append(sec.Items, h)
	}
	return nil
}

// ---- tasks ----

func (s *Service) tasks(ctx context.Context, tx pgx.Tx, req *request, sc *scope, sec *v1.SearchSection) error {
	var a boards.Args
	var vis []string
	for _, sp := range sc.wss {
		if !sp.boards.Empty() {
			vis = append(vis, sp.boards.Cond(&a))
		}
	}
	if len(vis) == 0 {
		return nil
	}
	rel := req.relevance(sec.Type)
	cond, key, rank := boards.SearchMatch(req.q, req.raw, &a)
	cands := "SELECT t.id, t.board_id, b.key, t.number, t.title, t.description, t.created_by, t.updated_at, b.workspace_id, t.status_id, " +
		key + " AS key_match FROM tasks t JOIN boards b ON b.id = t.board_id WHERE (" + strings.Join(vis, " OR ") +
		") AND t.archived_at IS NULL AND " + cond + newer("t.id", rel, req, &a)
	first := "t.id DESC"
	if rel {
		first = "key_match DESC, t.id DESC"
	}
	score := "" // relevance only: a parameter added but not used is an error
	if rel {
		score = "(CASE WHEN t.key_match THEN 10 ELSE 0 END + " + rank() + " * " + fresh("t.updated_at", a.Add(req.now)) + ")::float8"
	}
	tsq := a.Add(req.q.TS)
	sql := "SELECT p.id, p.board_id, p.key, p.number, p.title, p.created_by, p.updated_at, p.workspace_id, st.type, p.key_match, p.score, p.total, " +
		searchq.Headline("coalesce(nullif(p.description, ''), p.title)", tsq, a.Add(searchq.HeadlineOptions)) +
		" FROM (" + ranked(cands, first, "t", score, rel, req, &a) + ") p JOIN board_statuses st ON st.id = p.status_id" + order(rel, "p")
	type row struct {
		id, board, ws uuid.UUID
		key, title    string
		number        int32
		creator       *uuid.UUID
		at            time.Time
		status        string
		keyMatch      bool
		score         float64
		total         int64
		snippet       string
	}
	rows, err := tx.Query(ctx, sql, a.Values()...)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		err := r.Scan(&x.id, &x.board, &x.key, &x.number, &x.title, &x.creator, &x.at, &x.ws, &x.status, &x.keyMatch, &x.score, &x.total, &x.snippet)
		return x, err
	})
	if err != nil {
		return err
	}
	if len(list) > 0 {
		total(req, sec, list[0].total)
	}
	for _, x := range page(req, sec, list, func(x row) (float64, uuid.UUID) { return x.score, x.id }) {
		sec.Items = append(sec.Items, &v1.SearchHit{Snippet: x.snippet, Title: x.title, WorkspaceId: x.ws.String(), At: ts(x.at),
			AuthorId: str(x.creator), Ref: &v1.SearchHit_Task{Task: &v1.SearchTaskRef{TaskId: x.id.String(), BoardId: x.board.String(),
				Key: boards.TaskKey(x.key, x.number), StatusType: boards.StatusTypeFromDB(x.status), KeyMatch: x.keyMatch}}})
	}
	return nil
}

// ---- events ----

// eventVector must stay the expression of events_search_idx (00064).
const eventVector = "(to_tsvector('russian', e.title || ' ' || e.description) || to_tsvector('simple', e.title || ' ' || e.description))"

func (s *Service) events(ctx context.Context, tx pgx.Tx, req *request, sc *scope, sec *v1.SearchSection) error {
	var a boards.Args
	viewers := map[uuid.UUID]*calendar.SearchViewer{}
	var vis []string
	for _, sp := range sc.wss {
		if sp.events != nil {
			viewers[sp.id] = sp.events
			vis = append(vis, "(e.workspace_id = "+a.Add(sp.id)+" AND "+sp.events.Cond(a.Add)+")")
		}
	}
	if len(vis) == 0 {
		return nil
	}
	rel := req.relevance(sec.Type)
	tsq := a.Add(req.q.TS) + "::text"
	cands := "SELECT e.id, e.workspace_id, e.title, e.description, e.updated_at FROM events e WHERE e.cancelled_at IS NULL AND " + orJoin(vis) +
		" AND (" + eventVector + " @@ " + searchq.TSQuery(tsq) + " OR " + searchq.TitleMatch("e.title", req.q, a.Add) + ")" + newer("e.id", rel, req, &a)
	score := ""
	if rel {
		score = "((greatest(ts_rank_cd(" + eventVector + ", " + searchq.TSQuery(tsq) + "), word_similarity(" + a.Add(req.q.Text) + "::text, e.title))) * " +
			fresh("e.updated_at", a.Add(req.now)) + ")::float8"
	}
	sql := "SELECT p.id, p.workspace_id, p.score, p.total, " + searchq.Headline("coalesce(nullif(p.description, ''), p.title)", tsq, a.Add(searchq.HeadlineOptions)) +
		" FROM (" + ranked(cands, "e.id DESC", "e", score, rel, req, &a) + ") p" + order(rel, "p")
	type row struct {
		id, ws  uuid.UUID
		score   float64
		total   int64
		snippet string
	}
	rows, err := tx.Query(ctx, sql, a.Values()...)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		err := r.Scan(&x.id, &x.ws, &x.score, &x.total, &x.snippet)
		return x, err
	})
	if err != nil {
		return err
	}
	if len(list) > 0 {
		total(req, sec, list[0].total)
	}
	list = page(req, sec, list, func(x row) (float64, uuid.UUID) { return x.score, x.id })
	// The SQL above is the calendar's rule; Hits applies the rule itself (viewer.sees) and finds
	// the occurrence to show.
	q := s.db.Q.WithTx(tx)
	hits := map[uuid.UUID]calendar.SearchHit{}
	byWS := map[uuid.UUID][]uuid.UUID{}
	for _, x := range list {
		byWS[x.ws] = append(byWS[x.ws], x.id)
	}
	for ws, ids := range byWS {
		hs, err := viewers[ws].Hits(ctx, q, ids, s.Now())
		if err != nil {
			return err
		}
		for _, h := range hs {
			hits[h.Event.ID] = h
		}
	}
	for _, x := range list {
		h, ok := hits[x.id]
		if !ok {
			continue
		}
		sec.Items = append(sec.Items, &v1.SearchHit{Snippet: x.snippet, Title: h.Event.Title, WorkspaceId: x.ws.String(), At: ts(h.Start),
			AuthorId: h.Event.OrganizerID.String(), Ref: &v1.SearchHit_Event{Event: &v1.SearchEventRef{EventId: x.id.String(),
				OccurrenceStart: ts(h.Start), OccurrenceEnd: ts(h.End), RoomId: str(h.Event.RoomID), Recurring: h.Recurring}}})
	}
	return nil
}

func orJoin(parts []string) string {
	if len(parts) == 1 {
		return parts[0]
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

// ---- files ----

func (s *Service) files(ctx context.Context, tx pgx.Tx, req *request, sc *scope, sec *v1.SearchSection) error {
	var a boards.Args
	var parts []string
	for _, t := range []v1.SearchType{v1.SearchType_SEARCH_TYPE_MESSAGES, v1.SearchType_SEARCH_TYPE_TASK_COMMENTS, v1.SearchType_SEARCH_TYPE_NOTES} {
		c, err := sc.msgScope(ctx, tx, t, &a)
		if err != nil {
			return err
		}
		if c != "" {
			parts = append(parts, "("+c+")")
		}
	}
	if len(parts) == 0 {
		return nil
	}
	wsCond := "f.workspace_id = ANY(" + a.Add(sc.workspaceIDs()) + "::uuid[])"
	if len(sc.dms) > 0 || len(sc.notes) > 0 {
		wsCond = "(" + wsCond + " OR f.workspace_id IS NULL)"
	}
	rel := req.relevance(sec.Type)
	// One hit per file: its newest live message among those the caller sees.
	cands := "SELECT f.id, f.name, f.mime, f.size, f.created_at, mm.id AS message_id, mm.room_id, mm.author_id FROM files f" +
		" CROSS JOIN LATERAL (SELECT m.id, m.room_id, m.author_id FROM message_attachments ma JOIN messages m ON m.id = ma.message_id" +
		" WHERE ma.file_id = f.id AND m.deleted_at IS NULL AND " + orJoin(parts) + " ORDER BY m.id DESC LIMIT 1) mm" +
		" WHERE " + wsCond + " AND " + searchq.TitleMatch("f.name", req.q, a.Add) + newer("f.id", rel, req, &a)
	score := ""
	if rel {
		score = "((CASE WHEN f.name ILIKE " + a.Add(searchq.Like(req.q.Text)) + "::text THEN 1.0 ELSE word_similarity(" + a.Add(req.q.Text) +
			"::text, f.name) END) * " + fresh("f.created_at", a.Add(req.now)) + ")::float8"
	}
	sql := "SELECT p.id, p.name, p.mime, p.size, p.created_at, p.message_id, p.room_id, p.author_id, p.score, p.total, r.workspace_id FROM (" +
		ranked(cands, "f.id DESC", "f", score, rel, req, &a) + ") p LEFT JOIN rooms r ON r.id = p.room_id" + order(rel, "p")
	type row struct {
		id, msg, room, author uuid.UUID
		name, mime            string
		size                  int64
		at                    time.Time
		score                 float64
		total                 int64
		ws                    *uuid.UUID
	}
	rows, err := tx.Query(ctx, sql, a.Values()...)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		err := r.Scan(&x.id, &x.name, &x.mime, &x.size, &x.at, &x.msg, &x.room, &x.author, &x.score, &x.total, &x.ws)
		return x, err
	})
	if err != nil {
		return err
	}
	if len(list) > 0 {
		total(req, sec, list[0].total)
	}
	for _, x := range page(req, sec, list, func(x row) (float64, uuid.UUID) { return x.score, x.id }) {
		sec.Items = append(sec.Items, &v1.SearchHit{Snippet: markWords(x.name, req.q.Words), Title: x.name, WorkspaceId: str(x.ws), At: ts(x.at),
			AuthorId: x.author.String(), Ref: &v1.SearchHit_File{File: &v1.SearchFileRef{FileId: x.id.String(), MessageId: x.msg.String(),
				RoomId: x.room.String(), Mime: x.mime, Size: x.size}}})
	}
	return nil
}

// markWords wraps the case-insensitive occurrences of words in s with the highlight markers
// (file names: trigram matches have no ts_headline).
func markWords(s string, words []string) string {
	s = strings.NewReplacer(searchq.MarkStart, "", searchq.MarkStop, "").Replace(s)
	rs := []rune(s)
	lower := []rune(strings.ToLower(s))
	if len(lower) != len(rs) { // a case mapping changed the length: no highlight
		return s
	}
	mark := make([]bool, len(rs))
	for _, w := range words {
		wr := []rune(w)
		if len(wr) == 0 {
			continue
		}
		for i := 0; i+len(wr) <= len(lower); i++ {
			if string(lower[i:i+len(wr)]) == w {
				for j := i; j < i+len(wr); j++ {
					mark[j] = true
				}
			}
		}
	}
	var b strings.Builder
	for i, r := range rs {
		if mark[i] && (i == 0 || !mark[i-1]) {
			b.WriteString(searchq.MarkStart)
		}
		b.WriteRune(r)
		if mark[i] && (i == len(rs)-1 || !mark[i+1]) {
			b.WriteString(searchq.MarkStop)
		}
	}
	return b.String()
}

// ---- transcripts ----

// transcriptVector must stay the expression of room_recordings_transcript_search_idx (00064).
const transcriptVector = "(to_tsvector('russian', rr.transcript_text) || to_tsvector('simple', rr.transcript_text))"

// transcripts: recordings whose card the caller sees (recording.VisibleSQL, the rule of the
// recording endpoints) in the rooms they view, their DMs and notes; newest first.
func (s *Service) transcripts(ctx context.Context, tx pgx.Tx, req *request, sc *scope, sec *v1.SearchSection) error {
	var roomIDs []uuid.UUID
	for _, sp := range sc.wss {
		roomIDs = append(roomIDs, sp.rooms...)
	}
	for _, d := range sc.dms {
		roomIDs = append(roomIDs, d.id)
	}
	roomIDs = append(roomIDs, sc.notes...)
	if len(roomIDs) == 0 {
		return nil
	}
	var a boards.Args
	p, tsq := a.Add(roomIDs), a.Add(req.q.TS)
	from := " FROM room_recordings rr WHERE rr.result_state = 'ready' AND rr.transcript_text IS NOT NULL AND " +
		transcriptVector + " @@ " + searchq.TSQuery(tsq) + " AND " + recording.VisibleSQL("rr", p)
	if req.cur == nil {
		var n int64
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM (SELECT 1"+from+" LIMIT "+strconv.Itoa(candidateCap)+") x", a.Values()...).Scan(&n); err != nil {
			return err
		}
		total(req, sec, n)
	}
	from += newer("rr.id", false, req, &a)
	opts := a.Add(searchq.HeadlineOptions)
	// The first segment matching on its own gives the offset and the snippet (a phrase across
	// segments: the start of the transcript).
	sql := "SELECT c.id, c.room_id, c.message_id, r.workspace_id, c.started_by, c.started_at, coalesce(seg.start, 0)::float8, " +
		searchq.Headline("coalesce(seg.text, left(c.transcript_text, 2000))", tsq, opts) +
		" FROM (SELECT rr.id, rr.started_by, rr.started_at, rr.transcript_json, rr.transcript_text, " + recording.VisibleRoomSQL("rr", p) + " AS room_id, " + recording.VisibleMessageSQL("rr", p) + " AS message_id" +
		from + " ORDER BY rr.id DESC LIMIT " + strconv.Itoa(min(req.limit+1, transcriptCandidates)) + ") c" +
		" LEFT JOIN rooms r ON r.id = c.room_id" +
		" LEFT JOIN LATERAL (SELECT (x.seg->>'start')::float8 AS start, x.seg->>'text' AS text" +
		" FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.transcript_json) = 'array' THEN c.transcript_json ELSE '[]'::jsonb END) WITH ORDINALITY AS x (seg, ord)" +
		" WHERE (to_tsvector('russian', x.seg->>'text') || to_tsvector('simple', x.seg->>'text')) @@ " + searchq.TSQuery(tsq) +
		" ORDER BY x.ord LIMIT 1) seg ON true ORDER BY c.id DESC"
	type row struct {
		id, room uuid.UUID
		msg      *uuid.UUID
		ws       *uuid.UUID
		by       *uuid.UUID
		at       time.Time
		start    float64
		snippet  string
	}
	rows, err := tx.Query(ctx, sql, a.Values()...)
	if err != nil {
		return err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (row, error) {
		var x row
		err := r.Scan(&x.id, &x.room, &x.msg, &x.ws, &x.by, &x.at, &x.start, &x.snippet)
		return x, err
	})
	if err != nil {
		return err
	}
	for _, x := range page(req, sec, list, func(x row) (float64, uuid.UUID) { return 0, x.id }) {
		sec.Items = append(sec.Items, &v1.SearchHit{Snippet: x.snippet, WorkspaceId: str(x.ws), At: ts(x.at), AuthorId: str(x.by),
			Ref: &v1.SearchHit_Transcript{Transcript: &v1.SearchTranscriptRef{RecordingId: x.id.String(), RoomId: x.room.String(),
				OffsetMs: int64(x.start * 1000), MessageId: str(x.msg)}}})
	}
	return nil
}
