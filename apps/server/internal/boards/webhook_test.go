package boards

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/webhook"
)

// UPDATE_GOLDEN=1 rewrites testdata golden files.
var updateGolden = os.Getenv("UPDATE_GOLDEN") == "1"

func jsonKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func sorted(s ...string) []string { slices.Sort(s); return s }

// The body of a delivery: the ADR-0058 §4 payload — its field names (snake_case), "version": 1,
// "sequence" as a JSON number, "actor": null for the server's own changes, task without the
// recipient's attachments / checklists — byte-for-byte stable against testdata.
func TestWebhookPayloadGolden(t *testing.T) {
	at := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	before, _ := structpb.NewStruct(map[string]any{"status_id": "s1", "status_type": "unstarted"})
	after, _ := structpb.NewStruct(map[string]any{"status_id": "s2", "status_type": "started"})
	ev := &v1.BoardWebhookEvent{
		Id: "0192a000-0000-7000-8000-000000000001", Version: webhookVersion, Type: evTaskUpdated, Sequence: 42,
		OccurredAt: timestamppb.New(at), WorkspaceId: "0192a000-0000-7000-8000-0000000000aa",
		Board: &v1.BoardWebhookEvent_BoardRef{Id: "0192a000-0000-7000-8000-0000000000bb", Key: "FNG", Name: "Финансы"},
		Actor: &v1.BoardWebhookEvent_Actor{Id: "0192a000-0000-7000-8000-0000000000cc", Name: "Анна", IsBot: false},
		Task: &v1.Task{Id: "0192a000-0000-7000-8000-0000000000dd", BoardId: "0192a000-0000-7000-8000-0000000000bb", Number: 12,
			Key: "FNG-12", Title: "Отчёт", StatusId: "s2", Priority: v1.TaskPriority_TASK_PRIORITY_HIGH, Estimate: 3,
			CreatedAt: timestamppb.New(at), UpdatedAt: timestamppb.New(at), ChecklistTotal: 7, ChecklistDone: 3},
		TaskUrl: "https://app.example.com/t/FNG-12",
		Changes: []*v1.BoardWebhookEvent_Change{{Field: "status", Before: before, After: after}},
		Comment: &v1.BoardWebhookEvent_Comment{Id: "m1", AuthorId: "u1", Text: "готово",
			Attachments: []*v1.BoardWebhookEvent_CommentAttachment{{Name: "a.pdf", Size: 1024, Mime: "application/pdf"}}, CreatedAt: timestamppb.New(at)},
	}
	body, err := webhookJSON.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	// The ADR example's fields and, additive in version 1, the acting rule (ADR-0060; null here).
	if k := jsonKeys(got); !reflect.DeepEqual(k, sorted("id", "version", "type", "sequence", "occurred_at", "workspace_id", "board",
		"actor", "task", "task_url", "changes", "comment", "rule")) {
		t.Fatalf("top-level keys %v", k)
	}
	if got["rule"] != nil {
		t.Fatalf("rule of a person's change: %v", got["rule"])
	}
	if k := jsonKeys(got["board"].(map[string]any)); !reflect.DeepEqual(k, sorted("id", "key", "name")) {
		t.Fatalf("board keys %v", k)
	}
	if k := jsonKeys(got["actor"].(map[string]any)); !reflect.DeepEqual(k, sorted("id", "name", "is_bot")) {
		t.Fatalf("actor keys %v", k)
	}
	if k := jsonKeys(got["changes"].([]any)[0].(map[string]any)); !reflect.DeepEqual(k, sorted("field", "before", "after")) {
		t.Fatalf("change keys %v", k)
	}
	c := got["comment"].(map[string]any)
	if k := jsonKeys(c); !reflect.DeepEqual(k, sorted("id", "author_id", "text", "attachments", "created_at", "edited_at")) {
		t.Fatalf("comment keys %v", k)
	}
	if k := jsonKeys(c["attachments"].([]any)[0].(map[string]any)); !reflect.DeepEqual(k, sorted("name", "size", "mime")) {
		t.Fatalf("attachment keys %v", k)
	}
	if got["version"] != float64(1) || got["sequence"] != float64(42) || got["task"].(map[string]any)["checklist_total"] != float64(7) {
		t.Fatalf("numbers: version %v sequence %v", got["version"], got["sequence"])
	}
	// Server changes: "actor": null; a ping has no task.
	ev.Actor, ev.Task, ev.Comment = nil, nil, nil
	nb, _ := webhookJSON.Marshal(ev)
	var noActor map[string]any
	_ = json.Unmarshal(nb, &noActor)
	if v, ok := noActor["actor"]; !ok || v != nil {
		t.Fatalf("actor: %v (present %v), want null", v, ok)
	}

	path := filepath.Join("testdata", "webhook_event.json")
	pretty, _ := json.MarshalIndent(got, "", "  ")
	pretty = append(pretty, '\n')
	if updateGolden {
		if err := os.WriteFile(path, pretty, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path) //nolint:gosec // a fixed testdata path
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != string(pretty) {
		t.Fatalf("payload differs from %s:\n%s", path, pretty)
	}
}

// Which events one transaction's journal entries of a task make.
func TestTaskEvents(t *testing.T) {
	src, dst := uuid.New(), uuid.New()
	act := func(kind string, board uuid.UUID, before string) sqlc.TaskActivity {
		return sqlc.TaskActivity{Kind: kind, BoardID: board, Before: []byte(before)}
	}
	for name, c := range map[string]struct {
		as   []sqlc.TaskActivity
		want []boardEvent
	}{
		"fields":   {[]sqlc.TaskActivity{act("title", src, ""), act("priority", src, "")}, []boardEvent{{src, evTaskUpdated}}},
		"created":  {[]sqlc.TaskActivity{act("created", src, "")}, []boardEvent{{src, evTaskCreated}}},
		"archived": {[]sqlc.TaskActivity{act("archived", src, "")}, []boardEvent{{src, evTaskArchived}}},
		"restored": {[]sqlc.TaskActivity{act("restored", src, "")}, []boardEvent{{src, evTaskRestored}}},
		"moved": {[]sqlc.TaskActivity{act("title", src, ""), act("moved_board", dst, `{"board_id":"`+src.String()+`"}`)},
			[]boardEvent{{src, evTaskMovedOut}, {dst, evTaskMovedIn}}},
	} {
		if got := taskEvents(c.as); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %v, want %v", name, got, c.want)
		}
	}
}

// The board queue signs v1 over the timestamp and the body, with the documented headers.
func TestBoardWebhookHeaders(t *testing.T) {
	d := webhook.Delivery{ID: uuid.New(), Event: evTaskCreated, Payload: []byte(`{"type":"task.created"}`)}
	now := time.Now()
	h := boardQueue{}.Headers(d, webhook.Target{Secret: []byte("board-secret-0123456789")}, now)
	if err := webhook.Verify([]byte("board-secret-0123456789"), h, d.Payload, now); err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{"User-Agent": "Calab-Webhook/1.0", "X-Calab-Webhook-Version": "1",
		"X-Calab-Event": "task.created", "X-Calab-Delivery": d.ID.String()} {
		if h.Get(k) != v {
			t.Errorf("%s = %q, want %q", k, h.Get(k), v)
		}
	}
}
