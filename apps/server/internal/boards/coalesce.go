package boards

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// CoalesceWindow is how recent the last journal entry of a field must be for a change of it by
// the same user to merge into that entry (ADR-0081).
const CoalesceWindow = 5 * time.Minute

// valueKey: how two values of a field compare when deciding whether merged changes cancel out.
type valueKey struct {
	key   string
	asSet bool // an array compared regardless of order
}

// coalescable lists the journal kinds a repeated change merges into one entry, with the keys
// of before/after that make the field's value (ADR-0081). nil keys: the entry does not carry
// the value (description: only its length), so a merge never turns into a no-op.
var coalescable = map[string][]valueKey{
	"status":      {{key: "status_id"}},
	"assignees":   {{key: "assignees", asSet: true}},
	"priority":    {{key: "priority"}},
	"labels":      {{key: "label_ids", asSet: true}},
	"dates":       {{key: "start_on"}, {key: "due_on"}},
	"estimate":    {{key: "estimate"}},
	"title":       {{key: "title"}},
	"description": nil,
	"milestone":   {{key: "milestone_id"}},
	"parent":      {{key: "parent_id"}},
	"approvers":   {{key: "user_ids", asSet: true}, {key: "required"}, {key: "approval_state"}},
	"watchers":    {{key: "user_ids", asSet: true}},
	"attachments": {{key: "file_ids"}}, // the order is the gallery's order: a reorder is a change
}

// journalEntry is what the transaction did to the stored journal, for TASK_ACTIVITY: row was
// inserted (nil: nothing, the merged entry was removed); replaced: the entry it supersedes.
type journalEntry struct {
	task, board uuid.UUID
	row         *sqlc.TaskActivity
	replaced    uuid.UUID
}

// journalOf: the entries of one task.
func journalOf(js []journalEntry, taskID uuid.UUID) []journalEntry {
	var out []journalEntry
	for _, j := range js {
		if j.task == taskID {
			out = append(out, j)
		}
	}
	return out
}

// event is the TASK_ACTIVITY of the entry.
func (j journalEntry) event(ws uuid.UUID) *v1.DispatchEvent {
	ev := &v1.TaskActivityAppend{WorkspaceId: ws.String(), TaskId: j.task.String()}
	if j.row != nil {
		ev.Activity = activity(*j.row)
	}
	if j.replaced != uuid.Nil {
		ev.ReplacedId = j.replaced.String()
	}
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_TaskActivity{TaskActivity: ev}}
}

// mergeTarget finds and removes the entry a change of kind by actor merges into: the newest
// entry of that kind of the task, by the same actor (not a rule), within CoalesceWindow. The
// task row is locked by the caller's write; the delete re-checks that no concurrent writer
// merged it first. Returns the removed entry's id and its before.
func mergeTarget(ctx context.Context, q *sqlc.Queries, taskID uuid.UUID, actor *uuid.UUID, rule *uuid.UUID, kind string) (uuid.UUID, []byte, bool, error) {
	if _, ok := coalescable[kind]; !ok || actor == nil || rule != nil {
		return uuid.Nil, nil, false, nil
	}
	prev, err := q.LastTaskActivityOfKind(ctx, sqlc.LastTaskActivityOfKindParams{
		WindowSecs: CoalesceWindow.Seconds(), TaskID: taskID, Kind: kind})
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil, false, nil
	}
	if err != nil {
		return uuid.Nil, nil, false, err
	}
	if !prev.Recent || prev.RuleID != nil || prev.ActorID == nil || *prev.ActorID != *actor {
		return uuid.Nil, nil, false, nil
	}
	if _, err := q.DeleteTaskActivity(ctx, prev.ID); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, nil, false, nil
	} else if err != nil {
		return uuid.Nil, nil, false, err
	}
	return prev.ID, prev.Before, true, nil
}

// noOp: the merged entry's before and after hold the same value of the field.
func noOp(kind string, before, after []byte) bool {
	keys := coalescable[kind]
	if len(keys) == 0 {
		return false
	}
	var b, a map[string]any
	if json.Unmarshal(orNull(before), &b) != nil || json.Unmarshal(orNull(after), &a) != nil {
		return false
	}
	for _, k := range keys {
		if !sameValue(b[k.key], a[k.key], k.asSet) {
			return false
		}
	}
	return true
}

func orNull(b []byte) []byte {
	if len(b) == 0 {
		return []byte("null")
	}
	return b
}

func sameValue(x, y any, asSet bool) bool {
	xs, xok := x.([]any)
	ys, yok := y.([]any)
	if asSet && xok && yok {
		return slices.Equal(canonSorted(xs), canonSorted(ys))
	}
	return canon(x) == canon(y)
}

// canon: a JSON value as text with sorted object keys (encoding/json sorts map keys).
func canon(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(b)
}

func canonSorted(vs []any) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = canon(v)
	}
	slices.Sort(out)
	return out
}
