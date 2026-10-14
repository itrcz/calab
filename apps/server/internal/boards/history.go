package boards

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Journal kinds of the comments of a task (ADR-0091 §3): the comments are messages of the task
// room; the journal keeps what they said, also after an edit or a deletion.
const (
	kindComment       = "comment"
	kindCommentEdit   = "comment_edit"
	kindCommentDelete = "comment_delete"
)

// isCommentKind: a comment entry — not a change of the task (no task.updated webhook, no
// notifications of a field change).
func isCommentKind(kind string) bool {
	return kind == kindComment || kind == kindCommentEdit || kind == kindCommentDelete
}

// Snapshots of values in journal entries (ADR-0091 §3): the history reads after the label, file,
// milestone or task it names is gone.

// filesSnap: [{file_id, name, size, mime}] of the files ids, in the order of ids.
func filesSnap(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) ([]any, error) {
	out := []any{}
	if len(ids) == 0 {
		return out, nil
	}
	fs, err := q.FilesByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	by := make(map[uuid.UUID]sqlc.FilesByIDRow, len(fs))
	for _, f := range fs {
		by[f.ID] = f
	}
	for _, id := range ids {
		if f, ok := by[id]; ok {
			out = append(out, fileSnap(f.ID, f.Name, f.Size, f.Mime))
		}
	}
	return out, nil
}

func fileSnap(id uuid.UUID, name string, size int64, mime string) map[string]any {
	return map[string]any{"file_id": id.String(), "name": name, "size": size, "mime": mime}
}

// attachmentsSnap: the files of a comment as its journal entries hold them.
func attachmentsSnap(rows []sqlc.ListAttachmentsRow) []any {
	out := make([]any, 0, len(rows))
	for _, r := range rows {
		out = append(out, fileSnap(r.File.ID, r.File.Name, r.File.Size, r.File.Mime))
	}
	return out
}

// taskRefs: key and title of tasks by id (missing ids: none).
func taskRefs(ctx context.Context, q *sqlc.Queries, ids ...*uuid.UUID) (map[uuid.UUID]sqlc.TaskRefsRow, error) {
	var want []uuid.UUID
	for _, id := range ids {
		if id != nil {
			want = append(want, *id)
		}
	}
	out := map[uuid.UUID]sqlc.TaskRefsRow{}
	if len(want) == 0 {
		return out, nil
	}
	rows, err := q.TaskRefs(ctx, want)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.ID] = r
	}
	return out, nil
}

// withRef adds key and title of the task id to m (nothing when there is none).
func withRef(m map[string]any, refs map[uuid.UUID]sqlc.TaskRefsRow, id *uuid.UUID) map[string]any {
	if id == nil {
		return m
	}
	if r, ok := refs[*id]; ok {
		m["key"], m["title"] = TaskKey(r.BoardKey, r.Number), r.Title
	}
	return m
}

// milestoneNames: the names of the board's milestones by id.
func milestoneNames(ctx context.Context, q *sqlc.Queries, boardID uuid.UUID) (map[uuid.UUID]string, error) {
	ms, err := q.ListBoardMilestones(ctx, []uuid.UUID{boardID})
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]string, len(ms))
	for _, m := range ms {
		out[m.ID] = m.Name
	}
	return out, nil
}

// withMilestone adds the name of the milestone id to m.
func withMilestone(m map[string]any, names map[uuid.UUID]string, id *uuid.UUID) map[string]any {
	if id != nil {
		if n, ok := names[*id]; ok {
			m["name"] = n
		}
	}
	return m
}

// commentSnap: a comment as its journal entries hold it — {message_id, text, attachments}.
func commentSnap(msg sqlc.Message, files []any) map[string]any {
	return map[string]any{"message_id": msg.ID.String(), "text": msg.Content, "attachments": files}
}

// labelsEntry: before / after of a "labels" entry — {label_ids, labels: [{id, name, color}]}.
func labelsEntry(it boardItems, ids []uuid.UUID) map[string]any {
	labels := make([]any, 0, len(ids))
	for _, id := range ids {
		if l, ok := it.labels[id]; ok {
			labels = append(labels, map[string]any{"id": id.String(), "name": l.Name, "color": color(l.Color)})
		}
	}
	return map[string]any{"label_ids": idsJSON(ids), "labels": labels}
}

// attachmentsEntry: before / after of an "attachments" entry — {file_ids, files: [{file_id,
// name, size, mime}]}.
func attachmentsEntry(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID) (map[string]any, error) {
	files, err := filesSnap(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	return map[string]any{"file_ids": idsJSON(ids), "files": files}, nil
}

// taskRefKinds: the journal kinds that name another task, with the key of its id in before /
// after; their snapshots carry its "key" and "title" (ADR-0091 §3).
var taskRefKinds = map[string]string{"relation": "related_id", "parent": "parent_id"}

// withoutTaskRef drops the key and title of the named task from one side of an entry of kind
// (as written before ADR-0091: the id alone). Used where the reader is not one user — the live
// TASK_ACTIVITY (one encoding for every viewer of the task) and the board webhook — since the
// named task may be on a board they do not see (ADR-0059).
func withoutTaskRef(kind string, raw []byte) []byte {
	if _, ok := taskRefKinds[kind]; !ok || len(raw) == 0 {
		return raw
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return raw
	}
	_, k := m["key"]
	_, t := m["title"]
	if !k && !t {
		return raw
	}
	delete(m, "key")
	delete(m, "title")
	b, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return b
}

// refSide is one side (before or after) of a journal entry, rewritten in place.
type refSide struct {
	kind string
	raw  *[]byte
}

// hideUnseenRefs drops the key and title of every task named by the entries' sides that the
// caller does not see (ADR-0059: a relation may cross boards, a task-scoped member sees only
// his tasks — the snapshot must not tell what GET /tasks/{id} hides). A task that is gone is not
// seen either.
func (s *Service) hideUnseenRefs(ctx context.Context, me uuid.UUID, sides []refSide) error {
	type hit struct {
		side refSide
		m    map[string]any
		id   uuid.UUID
	}
	var hits []hit
	var ids []uuid.UUID
	for _, sd := range sides {
		idKey, ok := taskRefKinds[sd.kind]
		if !ok || len(*sd.raw) == 0 {
			continue
		}
		var m map[string]any
		if json.Unmarshal(*sd.raw, &m) != nil {
			continue
		}
		_, k := m["key"]
		_, t := m["title"]
		if !k && !t {
			continue
		}
		id, _ := uuid.Parse(str(m, idKey)) // unparsable: uuid.Nil, never seen
		hits = append(hits, hit{sd, m, id})
		ids = append(ids, id)
	}
	if len(hits) == 0 {
		return nil
	}
	rows, err := queryTasks(ctx, s.db.Pool, "WHERE t.id = ANY($1)", ids)
	if err != nil {
		return err
	}
	vis, err := visibleTasks(ctx, s.db.Q, rows, me)
	if err != nil {
		return err
	}
	seen := make(map[uuid.UUID]bool, len(vis))
	for _, v := range vis {
		seen[v.ID] = true
	}
	for _, h := range hits {
		if seen[h.id] {
			continue
		}
		delete(h.m, "key")
		delete(h.m, "title")
		b, err := json.Marshal(h.m)
		if err != nil {
			return err
		}
		*h.side.raw = b
	}
	return nil
}
