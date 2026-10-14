package boards

import "testing"

func TestCoalesceNoOp(t *testing.T) {
	cases := []struct {
		kind, before, after string
		want                bool
	}{
		{"status", `{"status_id":"a","status_type":"unstarted","position":1}`, `{"status_id":"a","status_type":"unstarted","position":7}`, true},
		{"status", `{"status_id":"a"}`, `{"status_id":"b"}`, false},
		{"labels", `{"label_ids":["x","y"]}`, `{"label_ids":["y","x"]}`, true},
		{"labels", `{"label_ids":[]}`, `{"label_ids":["x"]}`, false},
		{"assignees", `{"assignees":[{"user_id":"u","is_lead":true,"note":""}]}`, `{"assignees":[{"note":"","is_lead":true,"user_id":"u"}]}`, true},
		{"assignees", `{"assignees":[{"user_id":"u","is_lead":true,"note":""}]}`, `{"assignees":[{"user_id":"u","is_lead":false,"note":""}]}`, false},
		{"attachments", `{"file_ids":["a","b"]}`, `{"file_ids":["b","a"]}`, false}, // a reorder is a change
		{"dates", `{"start_on":null,"due_on":"2026-10-01"}`, `{"start_on":null,"due_on":"2026-10-01"}`, true},
		{"dates", `{"start_on":null,"due_on":"2026-10-01"}`, `{"start_on":"2026-09-01","due_on":"2026-10-01"}`, false},
		{"estimate", `{"estimate":null}`, `{"estimate":null}`, true},
		{"approvers", `{"user_ids":["a"],"required":1}`, `{"user_ids":["a"],"required":1,"approval_state":"approved"}`, false},
		{"description", `{"length":3}`, `{"length":3}`, false}, // the text is not in the entry
		{"title", `{"title":"x"}`, `{"title":"x"}`, true},
		{"archived", ``, ``, false},
	}
	for _, c := range cases {
		if got := noOp(c.kind, []byte(c.before), []byte(c.after)); got != c.want {
			t.Errorf("noOp(%s, %s, %s) = %v", c.kind, c.before, c.after, got)
		}
	}
}
