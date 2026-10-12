package notifications

import (
	"encoding/json"
	"errors"
	"os"
	"slices"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

type vector struct {
	Name           string `json:"name"`
	DM             bool   `json:"dm"`
	Mention        bool   `json:"mention"`
	Room           string `json:"room"`
	Workspace      string `json:"workspace"`
	RoomMuted      bool   `json:"roomMuted"`
	WorkspaceMuted bool   `json:"workspaceMuted"`
	Effective      string `json:"effective"`
	Notifies       bool   `json:"notifies"`
	// ADR-0042: a task notification vector (the other fields unused).
	Task *struct {
		Kind           string `json:"kind"`
		Level          string `json:"level"`
		Subscribed     bool   `json:"subscribed"`
		Muted          bool   `json:"muted"`
		WorkspaceMuted bool   `json:"workspaceMuted"`
		Mandatory      bool   `json:"mandatory"`
		Off            bool   `json:"off"`
	} `json:"task"`
}

func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../proto/testdata/notifications.json")
	if err != nil {
		t.Fatal(err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatal(err)
	}
	if len(vs) < 50 {
		t.Fatalf("only %d vectors", len(vs))
	}
	lvl := func(s string) v1.NotificationLevel {
		return LevelFromDB(s, v1.NotificationLevel_NOTIFICATION_LEVEL_UNSPECIFIED)
	}
	tasks := 0
	for _, v := range vs {
		if tv := v.Task; tv != nil {
			tasks++
			f := TaskFacts{Kind: TaskKind(tv.Kind), Level: lvl(tv.Level), Subscribed: tv.Subscribed, Muted: tv.Muted, Workspace: tv.WorkspaceMuted, Mandatory: tv.Mandatory, Off: tv.Off}
			if got := TaskNotifies(f); got != v.Notifies {
				t.Errorf("%s: task notifies %v, want %v", v.Name, got, v.Notifies)
			}
			continue
		}
		if got := Effective(lvl(v.Room), lvl(v.Workspace), v.DM); got != lvl(v.Effective) {
			t.Errorf("%s: effective %v, want %s", v.Name, got, v.Effective)
		}
		f := Facts{DM: v.DM, Mention: v.Mention, Room: lvl(v.Room), Workspace: lvl(v.Workspace), RoomMuted: v.RoomMuted, WorkspaceMuted: v.WorkspaceMuted}
		if got := Notifies(f); got != v.Notifies {
			t.Errorf("%s: notifies %v, want %v", v.Name, got, v.Notifies)
		}
	}
	if tasks < 50 {
		t.Fatalf("only %d task vectors", tasks)
	}
}

func TestDefaults(t *testing.T) {
	u := v1.NotificationLevel_NOTIFICATION_LEVEL_UNSPECIFIED
	// No stored rows at all: «Только упоминания».
	if got := Effective(u, u, false); got != v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS {
		t.Fatalf("default effective = %v", got)
	}
	if Notifies(Facts{}) || !Notifies(Facts{Mention: true}) || !Notifies(Facts{DM: true}) {
		t.Fatal("defaults: only mentions and DMs notify")
	}
	if s, ok := RoomLevelToDB(u); !ok || s != DBInherit {
		t.Fatalf("room default %q", s)
	}
	if s, ok := WorkspaceLevelToDB(u); !ok || s != DBMentions {
		t.Fatalf("workspace default %q", s)
	}
	if _, ok := WorkspaceLevelToDB(v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT); ok {
		t.Fatal("workspace INHERIT accepted")
	}
	if _, ok := RoomLevelToDB(42); ok {
		t.Fatal("unknown level accepted")
	}
}

func TestParseMute(t *testing.T) {
	now := time.Now()
	if m, err := ParseMute(nil, now); m != nil || err != nil {
		t.Fatal("nil mute")
	}
	if m, err := ParseMute(timestamppb.New(now.Add(-time.Minute)), now); m != nil || err != nil {
		t.Fatal("past mute must be dropped")
	}
	if m, err := ParseMute(timestamppb.New(now.Add(time.Hour)), now); m == nil || err != nil {
		t.Fatal("future mute")
	}
	if _, err := ParseMute(timestamppb.New(now.Add(MaxMute+time.Hour)), now); !errors.Is(err, ErrMuteTooFar) {
		t.Fatal("too far")
	}
	if _, err := ParseMute(&timestamppb.Timestamp{Seconds: 1, Nanos: -1}, now); !errors.Is(err, ErrMuteInvalid) {
		t.Fatal("invalid")
	}
}

// Every wire kind has a TaskKind (a new TaskNoticeKind must be added to taskKinds).
func TestTaskKindsCoverWire(t *testing.T) {
	for n := range v1.TaskNoticeKind_name {
		if n == 0 {
			continue
		}
		k, ok := TaskKindOf(v1.TaskNoticeKind(n))
		if !ok || k.Notice() != v1.TaskNoticeKind(n) {
			t.Errorf("TaskNoticeKind %d has no TaskKind", n)
		}
	}
}

func TestTaskNotifyOff(t *testing.T) {
	got, err := TaskNotifyOff([]int32{
		int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED), int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVED),
		int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON), int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED),
		int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED), int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_REJECTED),
	})
	if err != nil || !slices.Equal(got, []string{"due_soon", "edited"}) {
		t.Fatalf("TaskNotifyOff = %v, %v", got, err)
	}
	wire := TaskNotifyOffWire(append(got, "from_the_future"))
	if !slices.Equal(wire, []int32{int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON), int32(v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED)}) {
		t.Fatalf("TaskNotifyOffWire = %v", wire)
	}
	for _, bad := range [][]int32{{0}, {999}, make([]int32, MaxTaskNotifyOff+1)} {
		if _, err := TaskNotifyOff(bad); err == nil {
			t.Errorf("TaskNotifyOff(%v): no error", bad)
		}
	}
}
