// Package notifications holds the notification-level rules (docs/05 «Уведомления», docs/09
// item 22): a per-user level for every workspace (default MENTIONS) and for every room
// (default INHERIT: follow the workspace), temporary mutes of either, and a DM that notifies
// like a mention. Notifications themselves are shown by the client; the server stores and
// syncs the settings. Effective / Notifies are mirrored by the client
// (packages/protocol/src/notifications.ts) and tested against the shared vectors in
// proto/testdata/notifications.json. Keep them in sync.
package notifications

import (
	"errors"
	"slices"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Level values as stored in the database.
const (
	DBAll      = "all"
	DBMentions = "mentions"
	DBNone     = "none"
	DBInherit  = "inherit" // rooms only
)

// MaxMute bounds muted_until; «forever» is level NONE.
const MaxMute = 366 * 24 * time.Hour

var toDB = map[v1.NotificationLevel]string{
	v1.NotificationLevel_NOTIFICATION_LEVEL_ALL:      DBAll,
	v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS: DBMentions,
	v1.NotificationLevel_NOTIFICATION_LEVEL_NONE:     DBNone,
	v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT:  DBInherit,
}

// RoomLevelToDB maps a requested room level to its DB text; UNSPECIFIED is the default INHERIT.
func RoomLevelToDB(l v1.NotificationLevel) (string, bool) {
	if l == v1.NotificationLevel_NOTIFICATION_LEVEL_UNSPECIFIED {
		return DBInherit, true
	}
	s, ok := toDB[l]
	return s, ok
}

// WorkspaceLevelToDB maps a requested workspace level to its DB text; UNSPECIFIED is the
// default MENTIONS, INHERIT has nothing to inherit from.
func WorkspaceLevelToDB(l v1.NotificationLevel) (string, bool) {
	switch l {
	case v1.NotificationLevel_NOTIFICATION_LEVEL_UNSPECIFIED:
		return DBMentions, true
	case v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT:
		return "", false
	}
	s, ok := toDB[l]
	return s, ok
}

// LevelFromDB maps stored text back to the level; unknown text is def.
func LevelFromDB(s string, def v1.NotificationLevel) v1.NotificationLevel {
	for l, v := range toDB {
		if v == s {
			return l
		}
	}
	return def
}

// ErrMuteTooFar is returned for a muted_until more than MaxMute ahead.
var ErrMuteTooFar = errors.New("mutedUntil must be within a year; use level NONE to mute forever")

// ErrMuteInvalid is returned for an unparsable muted_until.
var ErrMuteInvalid = errors.New("invalid timestamp")

// ParseMute validates a requested muted_until. A mute in the past (or none) is nil.
func ParseMute(ts *timestamppb.Timestamp, now time.Time) (*time.Time, error) {
	if ts == nil {
		return nil, nil
	}
	if err := ts.CheckValid(); err != nil {
		return nil, ErrMuteInvalid
	}
	t := ts.AsTime()
	if t.After(now.Add(MaxMute)) {
		return nil, ErrMuteTooFar
	}
	if !t.After(now) {
		return nil, nil
	}
	return &t, nil
}

func orDefault(l, def v1.NotificationLevel) v1.NotificationLevel {
	if l == v1.NotificationLevel_NOTIFICATION_LEVEL_UNSPECIFIED {
		return def
	}
	return l
}

// Effective is the level that decides for a room: its own unless INHERIT, else the
// workspace's (default MENTIONS). A DM has no workspace: every message notifies (ALL)
// unless the DM is set to NONE.
func Effective(room, workspace v1.NotificationLevel, dm bool) v1.NotificationLevel {
	room = orDefault(room, v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT)
	if dm {
		if room == v1.NotificationLevel_NOTIFICATION_LEVEL_NONE {
			return room
		}
		return v1.NotificationLevel_NOTIFICATION_LEVEL_ALL
	}
	if room == v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT {
		workspace = orDefault(workspace, v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS)
		if workspace == v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT {
			return v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS
		}
		return workspace
	}
	return room
}

// TaskLevelToDB maps a requested «Задачи» level (ADR-0042 §4) to its DB text; UNSPECIFIED is
// the default ALL, INHERIT has nothing to inherit from.
func TaskLevelToDB(l v1.NotificationLevel) (string, bool) {
	switch l {
	case v1.NotificationLevel_NOTIFICATION_LEVEL_UNSPECIFIED:
		return DBAll, true
	case v1.NotificationLevel_NOTIFICATION_LEVEL_INHERIT:
		return "", false
	}
	s, ok := toDB[l]
	return s, ok
}

// TaskKind is what happened in a task, as far as notifications are concerned.
type TaskKind string

// Task notification kinds (ADR-0042 §4).
const (
	TaskAssigned  TaskKind = "assigned"  // the recipient was added to the assignees or made the lead
	TaskMentioned TaskKind = "mentioned" // @<recipient> in the description or a comment
	TaskComment   TaskKind = "comment"   // a comment in a task the recipient is subscribed to
	TaskStatus    TaskKind = "status"    // the status of a task the recipient is subscribed to changed
	// Approvals (ADR-0049 §5).
	TaskApprovalRequested TaskKind = "approval_requested" // the recipient's vote is asked for: always notifies
	TaskApproved          TaskKind = "approved"           // the quorum was reached
	TaskRejected          TaskKind = "rejected"           // an approver rejected
	// TaskRule: an automation rule's «notify» action addressed the recipient (ADR-0060); like an
	// assignment.
	TaskRule TaskKind = "rule"
	// ADR-0089, addressed to the recipient («Мне лично»).
	TaskUnassigned   TaskKind = "unassigned"    // removed from the assignees or from the lead by someone else
	TaskWatcherAdded TaskKind = "watcher_added" // made a watcher by someone else (not by a mention)
	TaskDueSoon      TaskKind = "due_soon"      // due tomorrow or today (the due sweep)
	TaskOverdue      TaskKind = "overdue"       // past due (the due sweep, once)
	// ADR-0089, to subscribers («Задачи, в которых участвую»).
	TaskDueChanged TaskKind = "due_changed" // the due date was set, moved or removed
	TaskPriority   TaskKind = "priority"
	TaskMilestone  TaskKind = "milestone"
	TaskMoved      TaskKind = "moved"      // moved to another board
	TaskEdited     TaskKind = "edited"     // the title or the description (once per coalesced journal entry)
	TaskAttachment TaskKind = "attachment" // a file was attached
	TaskArchived   TaskKind = "archived"
)

// taskKinds maps every kind to its wire value (TaskNoticeKind).
var taskKinds = map[TaskKind]v1.TaskNoticeKind{
	TaskAssigned:          v1.TaskNoticeKind_TASK_NOTICE_KIND_ASSIGNED,
	TaskMentioned:         v1.TaskNoticeKind_TASK_NOTICE_KIND_MENTIONED,
	TaskComment:           v1.TaskNoticeKind_TASK_NOTICE_KIND_COMMENT,
	TaskStatus:            v1.TaskNoticeKind_TASK_NOTICE_KIND_STATUS,
	TaskApprovalRequested: v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVAL_REQUESTED,
	TaskApproved:          v1.TaskNoticeKind_TASK_NOTICE_KIND_APPROVED,
	TaskRejected:          v1.TaskNoticeKind_TASK_NOTICE_KIND_REJECTED,
	TaskRule:              v1.TaskNoticeKind_TASK_NOTICE_KIND_RULE,
	TaskUnassigned:        v1.TaskNoticeKind_TASK_NOTICE_KIND_UNASSIGNED,
	TaskWatcherAdded:      v1.TaskNoticeKind_TASK_NOTICE_KIND_WATCHER_ADDED,
	TaskDueSoon:           v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_SOON,
	TaskOverdue:           v1.TaskNoticeKind_TASK_NOTICE_KIND_OVERDUE,
	TaskDueChanged:        v1.TaskNoticeKind_TASK_NOTICE_KIND_DUE_CHANGED,
	TaskPriority:          v1.TaskNoticeKind_TASK_NOTICE_KIND_PRIORITY,
	TaskMilestone:         v1.TaskNoticeKind_TASK_NOTICE_KIND_MILESTONE,
	TaskMoved:             v1.TaskNoticeKind_TASK_NOTICE_KIND_MOVED,
	TaskEdited:            v1.TaskNoticeKind_TASK_NOTICE_KIND_EDITED,
	TaskAttachment:        v1.TaskNoticeKind_TASK_NOTICE_KIND_ATTACHMENT,
	TaskArchived:          v1.TaskNoticeKind_TASK_NOTICE_KIND_ARCHIVED,
}

// Notice is the wire value of k (UNSPECIFIED for an unknown kind).
func (k TaskKind) Notice() v1.TaskNoticeKind { return taskKinds[k] }

// TaskKindOf is the kind of a wire value; false for UNSPECIFIED and unknown values.
func TaskKindOf(n v1.TaskNoticeKind) (TaskKind, bool) {
	for k, v := range taskKinds {
		if v == n {
			return k, true
		}
	}
	return "", false
}

// Mandatory reports whether k may never be switched off (ADR-0089 §2): approval requests and
// their outcome (for the creator and the lead; others get those by their level).
func (k TaskKind) Mandatory() bool {
	return k == TaskApprovalRequested || k == TaskApproved || k == TaskRejected
}

// direct reports whether k is addressed to the recipient («Мне лично», ADR-0089 §1): it
// notifies with task level ALL and MENTIONS, with or without a subscription.
func (k TaskKind) direct() bool {
	switch k {
	case TaskAssigned, TaskMentioned, TaskRule, TaskUnassigned, TaskWatcherAdded, TaskDueSoon, TaskOverdue:
		return true
	}
	return false
}

// TaskFacts are one task change by someone else, as seen by one recipient.
type TaskFacts struct {
	Kind       TaskKind
	Level      v1.NotificationLevel // the workspace's task level; UNSPECIFIED = ALL
	Subscribed bool                 // the recipient has a subscription row
	Muted      bool                 // «Отписаться»
	Workspace  bool                 // the workspace is muted (muted_until in the future)
	// Mandatory: an APPROVED / REJECTED notice to the task's creator or lead assignee (ADR-0049
	// §5) — delivered whatever the level, the task's «Отписаться» and a muted workspace.
	Mandatory bool
	// Off: the recipient switched this kind off (users.task_notify_off, ADR-0089 §2); no effect
	// on mandatory notices.
	Off bool
}

// TaskNotifies reports whether a task change notifies the recipient (the unread badge of the
// boards icon and a system notification). Approvals (ADR-0049 §5) are mandatory like a direct
// mention, bypassing levels, mutes and Off: APPROVAL_REQUESTED always, APPROVED / REJECTED for
// the creator and the lead (Mandatory). Otherwise nothing for a kind switched off (ADR-0089),
// with level NONE or a muted workspace; the kinds addressed to the recipient (assigned,
// mentioned, rule, unassigned, watcher_added, due_soon, overdue) with ALL and MENTIONS, even
// when unsubscribed; the rest (comments, status, the other approvals, field changes) with ALL
// only, to subscribers who did not mute the task.
func TaskNotifies(f TaskFacts) bool {
	if f.Kind == TaskApprovalRequested || (f.Mandatory && (f.Kind == TaskApproved || f.Kind == TaskRejected)) {
		return true
	}
	level := orDefault(f.Level, v1.NotificationLevel_NOTIFICATION_LEVEL_ALL)
	if f.Off || f.Workspace || level == v1.NotificationLevel_NOTIFICATION_LEVEL_NONE {
		return false
	}
	if _, known := taskKinds[f.Kind]; !known {
		return false
	}
	if f.Kind.direct() {
		return level == v1.NotificationLevel_NOTIFICATION_LEVEL_ALL || level == v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS
	}
	return level == v1.NotificationLevel_NOTIFICATION_LEVEL_ALL && f.Subscribed && !f.Muted
}

// MaxTaskNotifyOff bounds users.task_notify_off.
const MaxTaskNotifyOff = 64

// ErrTaskNotifyOff is returned for an UNSPECIFIED or unknown kind, or too many.
var ErrTaskNotifyOff = errors.New("task notification kinds must be known TaskNoticeKind values, at most 64")

// TaskNotifyOff validates a requested list of switched-off kinds (UpdateMeRequest
// .task_notify_off) and returns it as stored: distinct names, the mandatory kinds dropped.
func TaskNotifyOff(in []int32) ([]string, error) {
	if len(in) > MaxTaskNotifyOff {
		return nil, ErrTaskNotifyOff
	}
	out := make([]string, 0, len(in))
	for _, n := range in {
		k, ok := TaskKindOf(v1.TaskNoticeKind(n))
		if !ok {
			return nil, ErrTaskNotifyOff
		}
		if !k.Mandatory() && !slices.Contains(out, string(k)) {
			out = append(out, string(k))
		}
	}
	slices.Sort(out)
	return out, nil
}

// TaskNotifyOffWire is the stored list as wire values (UserSettings.task_notify_off); names
// this version does not know are left out.
func TaskNotifyOffWire(stored []string) []int32 {
	out := make([]int32, 0, len(stored))
	for _, s := range stored {
		if n := TaskKind(s).Notice(); n != v1.TaskNoticeKind_TASK_NOTICE_KIND_UNSPECIFIED {
			out = append(out, int32(n))
		}
	}
	slices.Sort(out)
	return out
}

// Facts about one incoming message from someone else, as seen by one recipient.
type Facts struct {
	DM             bool
	Mention        bool // @<user_id>, or an @everyone / @here the author may use
	Room           v1.NotificationLevel
	Workspace      v1.NotificationLevel
	RoomMuted      bool // room muted_until in the future
	WorkspaceMuted bool // workspace muted_until in the future (no effect on a DM)
}

// Notifies reports whether the message may make a sound or a notification. Unread and
// mention counters do not depend on it; «не беспокоить» and per-device toggles are applied
// on top by the client.
func Notifies(f Facts) bool {
	if f.RoomMuted || (!f.DM && f.WorkspaceMuted) {
		return false
	}
	switch Effective(f.Room, f.Workspace, f.DM) {
	case v1.NotificationLevel_NOTIFICATION_LEVEL_ALL:
		return true
	case v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS:
		return f.Mention
	default:
		return false
	}
}
