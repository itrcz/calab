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
)

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
}

// TaskNotifies reports whether a task change notifies the recipient (the unread badge of the
// boards icon and a system notification): nothing with level NONE or a muted workspace;
// assignments and mentions with ALL and MENTIONS, even when unsubscribed; comments and
// status changes with ALL only, to subscribers who did not mute the task. Approvals (ADR-0049
// §5) are mandatory like a direct mention, bypassing levels and mutes: APPROVAL_REQUESTED
// always, APPROVED / REJECTED for the creator and the lead (Mandatory); others get those like
// a status change.
func TaskNotifies(f TaskFacts) bool {
	if f.Kind == TaskApprovalRequested || (f.Mandatory && (f.Kind == TaskApproved || f.Kind == TaskRejected)) {
		return true
	}
	level := orDefault(f.Level, v1.NotificationLevel_NOTIFICATION_LEVEL_ALL)
	if f.Workspace || level == v1.NotificationLevel_NOTIFICATION_LEVEL_NONE {
		return false
	}
	switch f.Kind {
	case TaskAssigned, TaskMentioned, TaskRule:
		return level == v1.NotificationLevel_NOTIFICATION_LEVEL_ALL || level == v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS
	case TaskComment, TaskStatus, TaskApproved, TaskRejected:
		return level == v1.NotificationLevel_NOTIFICATION_LEVEL_ALL && f.Subscribed && !f.Muted
	}
	return false
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
