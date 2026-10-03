package boards

import (
	"bytes"
	"encoding/csv"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/perm"
)

// Feed limits.
const (
	feedDefault   = 50
	feedMax       = 100
	exportPage    = 1000
	exportMaxRows = 1_000_000
)

// taskActivity: GET /api/tasks/{id}/activity?before=&limit= — comments and journal entries
// newest first (both ids are uuidv7: their order is the time order).
func (s *Service) taskActivity(w http.ResponseWriter, r *http.Request) error {
	t, _, err := s.loadTask(r, s.db.Pool, false)
	if err != nil {
		return err
	}
	limit := feedDefault
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > feedMax {
			return httpx.BadRequest("limit must be 1..100")
		}
		limit = n
	}
	var before *uuid.UUID
	if b := r.URL.Query().Get("before"); b != "" {
		id, err := uuid.Parse(b)
		if err != nil {
			return httpx.BadRequest("before must be an item id")
		}
		before = &id
	}
	lim := int32(limit + 1) //nolint:gosec // ≤ 101
	ms, err := s.db.Q.ListTaskRoomMessages(r.Context(), sqlc.ListTaskRoomMessagesParams{RoomID: t.RoomID, Before: before, Lim: lim})
	if err != nil {
		return err
	}
	as, err := s.db.Q.ListTaskActivity(r.Context(), sqlc.ListTaskActivityParams{TaskID: t.ID, Before: before, Lim: lim})
	if err != nil {
		return err
	}
	msgs, err := messages.Details(r.Context(), s.db.Q, ms, uid(r))
	if err != nil {
		return err
	}
	out := &v1.TaskActivityPage{}
	i, j := 0, 0
	for len(out.Items) < limit && (i < len(msgs) || j < len(as)) {
		if j >= len(as) || (i < len(msgs) && bytes.Compare(ms[i].ID[:], as[j].ID[:]) > 0) {
			out.Items = append(out.Items, &v1.TaskActivityItem{Item: &v1.TaskActivityItem_Message{Message: msgs[i]}})
			i++
			continue
		}
		out.Items = append(out.Items, &v1.TaskActivityItem{Item: &v1.TaskActivityItem_Activity{Activity: activity(as[j])}})
		j++
	}
	out.HasMore = i < len(msgs) || j < len(as)
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// boardActivity: GET /api/boards/{id}/activity?since=&until=&actor=&kind=&cursor=&format=csv —
// the journal of a board, oldest first (MANAGE_BOARD or EDIT_TASKS on the board, or
// VIEW_JOURNALS of the workspace, ADR-0048 — always on a board the caller sees).
func (s *Service) boardActivity(w http.ResponseWriter, r *http.Request) error {
	id, acc, err := fullBoard(r, false) // not for task-scoped members, even with VIEW_JOURNALS (ADR-0059)
	if err != nil {
		return err
	}
	if !acc.Bits.Has(perm.ManageBoard) && !acc.Bits.Has(perm.EditTasks) && !acc.Member.Workspace().Has(perm.ViewJournals) {
		return httpx.Forbidden("MANAGE_BOARD, EDIT_TASKS or VIEW_JOURNALS required")
	}
	qs := r.URL.Query()
	p := sqlc.ListBoardActivityParams{BoardID: id, Lim: exportPage}
	for name, dst := range map[string]**time.Time{"since": &p.Since, "until": &p.Until} {
		if v := qs.Get(name); v != "" {
			t, err := time.Parse(time.RFC3339, v)
			if err != nil {
				return httpx.BadRequest(name + " must be RFC 3339")
			}
			*dst = &t
		}
	}
	if v := qs.Get("actor"); v != "" {
		a, err := uuid.Parse(v)
		if err != nil {
			return httpx.BadRequest("actor must be a user id")
		}
		p.Actor = &a
	}
	if v := qs.Get("kind"); v != "" {
		p.Kind = &v
	}
	if v := qs.Get("cursor"); v != "" {
		c, err := uuid.Parse(v)
		if err != nil {
			return httpx.BadRequest("invalid cursor")
		}
		p.AfterID = &c
	}
	if qs.Get("format") == "csv" {
		return s.exportCSV(w, r, p)
	}
	rows, err := s.db.Q.ListBoardActivity(r.Context(), p)
	if err != nil {
		return err
	}
	out := &v1.BoardActivityResponse{Activities: make([]*v1.TaskActivity, len(rows))}
	for i, a := range rows {
		out.Activities[i] = activity(sqlc.TaskActivity{ID: a.ID, TaskID: a.TaskID, BoardID: a.BoardID, ActorID: a.ActorID,
			Kind: a.Kind, Before: a.Before, After: a.After, CreatedAt: a.CreatedAt})
	}
	if len(rows) == exportPage {
		out.NextCursor = rows[len(rows)-1].ID.String()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (s *Service) exportCSV(w http.ResponseWriter, r *http.Request, p sqlc.ListBoardActivityParams) error {
	first, err := s.db.Q.ListBoardActivity(r.Context(), p)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="board-activity.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"id", "created_at", "task_key", "actor_id", "kind", "before", "after"})
	rows, n := first, 0
	for len(rows) > 0 && n < exportMaxRows {
		for _, a := range rows {
			_ = cw.Write([]string{a.ID.String(), a.CreatedAt.UTC().Format(time.RFC3339), TaskKey(a.BoardKey, a.TaskNumber),
				idp(a.ActorID), a.Kind, string(a.Before), string(a.After)})
		}
		n += len(rows)
		if len(rows) < exportPage {
			break
		}
		last := rows[len(rows)-1].ID
		p.AfterID = &last
		if rows, err = s.db.Q.ListBoardActivity(r.Context(), p); err != nil {
			break // headers are out: the file ends early
		}
	}
	cw.Flush()
	return nil
}
