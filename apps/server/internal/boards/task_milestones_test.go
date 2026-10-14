package boards

import "testing"

// ADR-0063 §2: progress over linked subtasks — cancelled ones leave the total, completed ones are
// done; the server owns the completion only while something is counted.
func TestMilestoneProgress(t *testing.T) {
	for _, c := range []struct {
		name            string
		types           []string
		done, total     int
		completed, auto bool
	}{
		{"no subtasks: the person's toggle", nil, 0, 0, false, false},
		{"open", []string{"unstarted", "started"}, 0, 2, false, true},
		{"half", []string{"completed", "started"}, 1, 2, false, true},
		{"all done", []string{"completed", "completed"}, 2, 2, true, true},
		{"cancelled leaves the total", []string{"completed", "cancelled"}, 1, 1, true, true},
		{"only cancelled: the person's toggle", []string{"cancelled", "cancelled"}, 0, 0, false, false},
		{"backlog counts as open", []string{"backlog", "completed"}, 1, 2, false, true},
	} {
		done, total := MilestoneProgress(c.types)
		if done != c.done || total != c.total {
			t.Errorf("%s: progress %d/%d, want %d/%d", c.name, done, total, c.done, c.total)
		}
		completed, auto := AutoCompleted(done, total)
		if completed != c.completed || auto != c.auto {
			t.Errorf("%s: completed %v auto %v, want %v %v", c.name, completed, auto, c.completed, c.auto)
		}
	}
}
