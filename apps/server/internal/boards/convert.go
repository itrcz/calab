package boards

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

func tsp(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

func idp(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

func color(c int32) uint32 { return uint32(max(c, 0)) } //nolint:gosec // DB CHECK 0..0xFFFFFF

// BoardOverride converts a stored board override.
func BoardOverride(p sqlc.BoardPermission) *v1.RoomPermissionOverride {
	tt := v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
	if p.TargetType == "user" {
		tt = v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
	}
	return &v1.RoomPermissionOverride{TargetType: tt, TargetId: p.TargetID, Allow: uint64(p.Allow), Deny: uint64(p.Deny)} //nolint:gosec // bit masks
}

// OverrideTargets converts board overrides for perm.ComputeBoardIn.
func OverrideTargets(rows []sqlc.BoardPermission) []perm.OverrideTarget {
	out := make([]perm.OverrideTarget, len(rows))
	for i, p := range rows {
		out[i] = perm.OverrideTarget{TargetType: p.TargetType, TargetID: p.TargetID,
			Override: perm.Override{Allow: perm.Bits(uint64(p.Allow)), Deny: perm.Bits(uint64(p.Deny))}} //nolint:gosec // bit masks
	}
	return out
}

func status(s sqlc.BoardStatus) *v1.BoardStatus {
	return &v1.BoardStatus{Id: s.ID.String(), Name: s.Name, Type: StatusTypeFromDB(s.Type), Color: color(s.Color), Position: s.Position, IsDefault: s.IsDefault}
}

func label(l sqlc.BoardLabel) *v1.BoardLabel {
	return &v1.BoardLabel{Id: l.ID.String(), Name: l.Name, Color: color(l.Color), Position: l.Position}
}

func milestone(m sqlc.BoardMilestone) *v1.BoardMilestone {
	return &v1.BoardMilestone{Id: m.ID.String(), Name: m.Name, DueOn: DateString(m.DueOn), Position: m.Position}
}

// View converts a saved view.
func View(v sqlc.BoardView) *v1.BoardView {
	f := &v1.TaskFilter{}
	_ = protojson.Unmarshal(v.Filter, f) // stored by us; a bad row shows as no filter
	return &v1.BoardView{
		Id: v.ID.String(), BoardId: v.BoardID.String(), Name: v.Name, Kind: viewKindFromDB(v.Kind), Filter: f,
		GroupBy: v.GroupBy, Sort: v.Sort, Shared: v.Shared, CreatedBy: v.CreatedBy.String(), Position: v.Position,
	}
}

func filterJSON(f *v1.TaskFilter) []byte {
	if f == nil {
		f = &v1.TaskFilter{}
	}
	b, err := protojson.Marshal(f)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// boardParts are the sub-entities of a set of boards.
type boardParts struct {
	statuses   map[uuid.UUID][]sqlc.BoardStatus
	labels     map[uuid.UUID][]sqlc.BoardLabel
	milestones map[uuid.UUID][]sqlc.BoardMilestone
	views      map[uuid.UUID][]sqlc.BoardView
	overrides  map[uuid.UUID][]sqlc.BoardPermission
	open       map[uuid.UUID]int64
	mine       map[uuid.UUID]int64
	rules      map[uuid.UUID]int64 // automation rules (ADR-0060)
}

// loadParts loads statuses, labels, milestones, views (shared, plus viewer's own with
// personal), overrides and open-task counts (mine: assigned to viewer) of the boards.
func loadParts(ctx context.Context, q *sqlc.Queries, ids []uuid.UUID, viewer uuid.UUID, personal bool) (boardParts, error) {
	p := boardParts{statuses: map[uuid.UUID][]sqlc.BoardStatus{}, labels: map[uuid.UUID][]sqlc.BoardLabel{},
		milestones: map[uuid.UUID][]sqlc.BoardMilestone{}, views: map[uuid.UUID][]sqlc.BoardView{},
		overrides: map[uuid.UUID][]sqlc.BoardPermission{}, open: map[uuid.UUID]int64{}, mine: map[uuid.UUID]int64{}, rules: map[uuid.UUID]int64{}}
	if len(ids) == 0 {
		return p, nil
	}
	ss, err := q.ListBoardStatuses(ctx, ids)
	if err != nil {
		return p, err
	}
	for _, s := range ss {
		p.statuses[s.BoardID] = append(p.statuses[s.BoardID], s)
	}
	ls, err := q.ListBoardLabels(ctx, ids)
	if err != nil {
		return p, err
	}
	for _, l := range ls {
		p.labels[l.BoardID] = append(p.labels[l.BoardID], l)
	}
	ms, err := q.ListBoardMilestones(ctx, ids)
	if err != nil {
		return p, err
	}
	for _, m := range ms {
		p.milestones[m.BoardID] = append(p.milestones[m.BoardID], m)
	}
	var vuser *uuid.UUID
	if personal && viewer != uuid.Nil {
		vuser = &viewer
	}
	vs, err := q.ListBoardViews(ctx, sqlc.ListBoardViewsParams{BoardIds: ids, UserID: vuser})
	if err != nil {
		return p, err
	}
	for _, v := range vs {
		p.views[v.BoardID] = append(p.views[v.BoardID], v)
	}
	for _, id := range ids {
		ovs, err := q.ListBoardOverrides(ctx, id)
		if err != nil {
			return p, err
		}
		p.overrides[id] = ovs
	}
	counts, err := q.BoardOpenCounts(ctx, sqlc.BoardOpenCountsParams{UserID: viewer, BoardIds: ids})
	if err != nil {
		return p, err
	}
	for _, c := range counts {
		p.open[c.BoardID], p.mine[c.BoardID] = int64(c.Open), int64(c.Mine)
	}
	rc, err := q.BoardRuleCounts(ctx, ids)
	if err != nil {
		return p, err
	}
	for _, c := range rc {
		p.rules[c.BoardID] = int64(c.Rules)
	}
	return p, nil
}

// boardProto converts a board with its parts; bits = the viewer's (0 in broadcasts). scoped:
// the task-scoped form (ADR-0064) — no access overrides, no board-wide task count.
func boardProto(b sqlc.Board, p boardParts, bits perm.Bits, scoped bool) *v1.Board {
	out := &v1.Board{
		Id: b.ID.String(), WorkspaceId: b.WorkspaceID.String(), Name: b.Name, Key: b.Key, Emoji: b.Emoji,
		IconFileId: idp(b.IconFileID), Description: b.Description, IsPrivate: b.IsPrivate, Restricted: b.Restricted, Position: b.Position,
		AutoArchiveDays: uint32(max(b.AutoArchiveDays, 0)), Permissions: uint64(bits), //nolint:gosec // CHECK 0..3650
		OpenTasks: uint32(max(p.open[b.ID], 0)), MyOpenTasks: uint32(max(p.mine[b.ID], 0)), //nolint:gosec // counts
		CreatedBy: idp(b.CreatedBy), CreatedAt: timestamppb.New(b.CreatedAt), ArchivedAt: tsp(b.ArchivedAt),
		KeyLocked: b.NextNumber > 1, DefaultViewId: idp(b.DefaultViewID),
		CategoryId: idp(b.CategoryID), DisabledFeatures: FeaturesProto(b.DisabledFeatures), EstimateScale: EstimateScaleFromDB(b.EstimateScale),
		RulesCount: uint32(max(p.rules[b.ID], 0)), //nolint:gosec // ≤ 20
	}
	for _, s := range p.statuses[b.ID] {
		out.Statuses = append(out.Statuses, status(s))
	}
	for _, l := range p.labels[b.ID] {
		out.Labels = append(out.Labels, label(l))
	}
	for _, m := range p.milestones[b.ID] {
		out.Milestones = append(out.Milestones, milestone(m))
	}
	for _, v := range p.views[b.ID] {
		out.Views = append(out.Views, View(v))
	}
	for _, o := range p.overrides[b.ID] {
		out.PermissionOverrides = append(out.PermissionOverrides, BoardOverride(o))
	}
	if scoped {
		return ScopedForm(out)
	}
	return out
}

// ScopedForm turns a broadcast board into the form a task-scoped recipient gets (ADR-0064):
// permissions 0, no access overrides, no board-wide task count. b is modified.
func ScopedForm(b *v1.Board) *v1.Board {
	b.Permissions, b.TaskScoped, b.OpenTasks, b.PermissionOverrides = 0, true, 0, nil
	return b
}

// Category converts a board category.
func Category(c sqlc.BoardCategory) *v1.BoardCategory {
	return &v1.BoardCategory{Id: c.ID.String(), WorkspaceId: c.WorkspaceID.String(), Name: c.Name, Position: c.Position}
}

// Categories converts board categories.
func Categories(cs []sqlc.BoardCategory) []*v1.BoardCategory {
	out := make([]*v1.BoardCategory, len(cs))
	for i, c := range cs {
		out[i] = Category(c)
	}
	return out
}

// All returns every live board of a workspace in broadcast form (no bits, shared views): the
// gateway's state.
func All(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) ([]*v1.Board, error) {
	rows, err := q.ListBoards(ctx, sqlc.ListBoardsParams{WorkspaceID: wsID, Archived: false})
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, b := range rows {
		ids[i] = b.ID
	}
	p, err := loadParts(ctx, q, ids, uuid.Nil, false)
	if err != nil {
		return nil, err
	}
	out := make([]*v1.Board, len(rows))
	for i, b := range rows {
		out[i] = boardProto(b, p, 0, false)
	}
	return out, nil
}

// Snapshot returns the live boards member m sees in workspace wsID, with their bits and
// shared views (READY: WorkspaceSnapshot.boards) — task-scoped ones (ADR-0059) in their scoped
// form — and the ids of their unread tasks.
func Snapshot(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, m perm.Member) ([]*v1.Board, []string, error) {
	vis, err := VisibleBoards(ctx, q, wsID, m)
	if err != nil || vis.Empty() {
		return nil, nil, err
	}
	rows, err := q.ListBoards(ctx, sqlc.ListBoardsParams{WorkspaceID: wsID, Archived: false})
	if err != nil {
		return nil, nil, err
	}
	visible := make([]sqlc.Board, 0, len(rows))
	ids := make([]uuid.UUID, 0, len(rows))
	for _, b := range rows {
		if _, ok := vis.Full[b.ID]; ok || vis.Scoped[b.ID] {
			visible, ids = append(visible, b), append(ids, b.ID)
		}
	}
	me, err := uuid.Parse(m.UserID)
	if err != nil {
		return nil, nil, err
	}
	p, err := loadParts(ctx, q, ids, me, false)
	if err != nil {
		return nil, nil, err
	}
	out := make([]*v1.Board, len(visible))
	for i, b := range visible {
		out[i] = boardProto(b, p, vis.Full[b.ID], vis.Scoped[b.ID])
	}
	unread, err := q.UnreadTaskIDs(ctx, sqlc.UnreadTaskIDsParams{WorkspaceID: wsID, UserID: me})
	if err != nil {
		return nil, nil, err
	}
	var ur []string
	for _, u := range unread {
		if _, ok := vis.Full[u.BoardID]; ok || vis.Invited[u.ID] {
			ur = append(ur, u.ID.String())
		}
	}
	return out, ur, nil
}

// ---- tasks ----

// taskCols are the columns of taskRow, over tasks t JOIN boards b.
const taskCols = `t.id, t.board_id, t.number, t.title, t.description, t.status_id, t.priority, t.created_by,
	t.estimate, t.start_on, t.due_on, t.parent_id, t.milestone_id, t.position, t.room_id, t.created_at,
	t.updated_at, t.started_at, t.completed_at, t.completed_by, t.archived_at, b.key, b.workspace_id, t.approval_required,
	t.task_milestone_id`

// taskRow is a task with its board's key and workspace.
type taskRow struct {
	ID          uuid.UUID
	BoardID     uuid.UUID
	Number      int32
	Title       string
	Description string
	StatusID    uuid.UUID
	Priority    int16
	CreatedBy   *uuid.UUID
	Estimate    *int16
	StartOn     pgtype.Date
	DueOn       pgtype.Date
	ParentID    *uuid.UUID
	MilestoneID *uuid.UUID
	Position    float64
	RoomID      uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
	StartedAt   *time.Time
	CompletedAt *time.Time
	CompletedBy *uuid.UUID
	ArchivedAt  *time.Time
	BoardKey    string
	WorkspaceID uuid.UUID
	// ApprovalRequired: approvals needed, 0 = all (ADR-0049).
	ApprovalRequired int16
	// TaskMilestoneID: a subtask's milestone, one of its parent's (ADR-0063).
	TaskMilestoneID *uuid.UUID
}

func scanTasks(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close()
}) ([]taskRow, error) {
	defer rows.Close()
	var out []taskRow
	for rows.Next() {
		var t taskRow
		if err := rows.Scan(&t.ID, &t.BoardID, &t.Number, &t.Title, &t.Description, &t.StatusID, &t.Priority, &t.CreatedBy,
			&t.Estimate, &t.StartOn, &t.DueOn, &t.ParentID, &t.MilestoneID, &t.Position, &t.RoomID, &t.CreatedAt,
			&t.UpdatedAt, &t.StartedAt, &t.CompletedAt, &t.CompletedBy, &t.ArchivedAt, &t.BoardKey, &t.WorkspaceID, &t.ApprovalRequired,
			&t.TaskMilestoneID); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// queryTasks runs `SELECT taskCols FROM tasks t JOIN boards b … <tail>`.
func queryTasks(ctx context.Context, dbtx sqlc.DBTX, tail string, args ...any) ([]taskRow, error) {
	rows, err := dbtx.Query(ctx, "SELECT "+taskCols+" FROM tasks t JOIN boards b ON b.id = t.board_id "+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTasks(rows)
}

// taskByID loads one task row (pgx.ErrNoRows-free: ok=false when missing).
func taskByID(ctx context.Context, dbtx sqlc.DBTX, id uuid.UUID, lock bool) (taskRow, bool, error) {
	tail := "WHERE t.id = $1"
	if lock {
		// NO KEY UPDATE: writers of the task serialize, yet another transaction may still take
		// KEY SHARE (a journal entry or a milestone of this task, foreign keys) — a subtask's
		// transaction does so on its parent while the parent's own write (move to another board,
		// DetachSubtasks) waits for the subtask: FOR UPDATE would deadlock them (ADR-0063).
		tail += " FOR NO KEY UPDATE OF t"
	}
	ts, err := queryTasks(ctx, dbtx, tail, id)
	if err != nil || len(ts) == 0 {
		return taskRow{}, false, err
	}
	return ts[0], true, nil
}

// tasksProto converts rows with their assignees, labels, relations, counts and (viewer !=
// uuid.Nil) the viewer's subscription state.
func tasksProto(ctx context.Context, q *sqlc.Queries, ts []taskRow, viewer uuid.UUID) ([]*v1.Task, error) {
	out := make([]*v1.Task, len(ts))
	if len(ts) == 0 {
		return out, nil
	}
	ids := make([]uuid.UUID, len(ts))
	idx := make(map[uuid.UUID]int, len(ts))
	for i, t := range ts {
		ids[i], idx[t.ID] = t.ID, i
		out[i] = &v1.Task{
			Id: t.ID.String(), BoardId: t.BoardID.String(), WorkspaceId: t.WorkspaceID.String(), Number: uint32(max(t.Number, 0)), //nolint:gosec // ≥ 1
			Key: TaskKey(t.BoardKey, t.Number), Title: t.Title, Description: t.Description, StatusId: t.StatusID.String(),
			Priority: v1.TaskPriority(t.Priority), CreatedBy: idp(t.CreatedBy), StartOn: DateString(t.StartOn),
			DueOn: DateString(t.DueOn), ParentId: idp(t.ParentID), MilestoneId: idp(t.MilestoneID), Position: t.Position,
			RoomId: t.RoomID.String(), CreatedAt: timestamppb.New(t.CreatedAt), UpdatedAt: timestamppb.New(t.UpdatedAt),
			StartedAt: tsp(t.StartedAt), CompletedAt: tsp(t.CompletedAt), CompletedBy: idp(t.CompletedBy), ArchivedAt: tsp(t.ArchivedAt),
			TaskMilestoneId: idp(t.TaskMilestoneID),
		}
		if t.Estimate != nil {
			out[i].Estimate = uint32(max(*t.Estimate, 0)) //nolint:gosec // CHECK 1..21
		}
	}
	as, err := q.ListTaskAssignees(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, a := range as {
		t := out[idx[a.TaskID]]
		t.Assignees = append(t.Assignees, &v1.TaskAssignee{UserId: a.UserID.String(), IsLead: a.IsLead, Note: a.Note,
			AssignedBy: idp(a.AssignedBy), AssignedAt: timestamppb.New(a.AssignedAt)})
	}
	ls, err := q.ListTaskLabelIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, l := range ls {
		t := out[idx[l.TaskID]]
		t.LabelIds = append(t.LabelIds, l.LabelID.String())
	}
	rs, err := q.ListTaskRelations(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, r := range rs {
		rel := &v1.TaskRelation{TaskId: r.TaskID.String(), RelatedId: r.RelatedID.String(), Kind: relationFromDB(r.Kind)}
		for _, side := range []uuid.UUID{r.TaskID, r.RelatedID} {
			if i, ok := idx[side]; ok {
				out[i].Relations = append(out[i].Relations, rel)
			}
		}
	}
	// Approvals (ADR-0049): the votes of all tasks in one query; the state is derived here.
	aps, err := q.ListTaskApprovers(ctx, ids)
	if err != nil {
		return nil, err
	}
	states := make(map[uuid.UUID][]string, len(ts))
	for _, a := range aps {
		t := out[idx[a.TaskID]]
		t.Approvers = append(t.Approvers, approverProto(a))
		states[a.TaskID] = append(states[a.TaskID], a.State)
	}
	for i, t := range ts {
		out[i].ApprovalRequired = uint32(max(t.ApprovalRequired, 0)) //nolint:gosec // CHECK 0..10
		out[i].ApprovalState = TallyOf(states[t.ID], int(t.ApprovalRequired)).State()
	}
	cs, err := q.TaskCounts(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, c := range cs {
		t := out[idx[c.ID]]
		t.SubtaskCount, t.SubtaskDone = uint32(max(c.Subtasks, 0)), uint32(max(c.SubtasksDone, 0))            //nolint:gosec // counts
		t.CommentCount, t.AttachmentCount = uint32(max(c.Comments, 0)), uint32(max(c.Attachments, 0))         //nolint:gosec // counts
		t.ChecklistTotal, t.ChecklistDone = uint32(max(c.ChecklistTotal, 0)), uint32(max(c.ChecklistDone, 0)) //nolint:gosec // counts
		t.GitLinksCount = uint32(max(c.GitLinks, 0))                                                          //nolint:gosec // a count
	}
	if err := taskMilestones(ctx, q, ids, out, idx); err != nil {
		return nil, err
	}
	if viewer != uuid.Nil {
		subs, err := q.ListViewerSubscriptions(ctx, sqlc.ListViewerSubscriptionsParams{UserID: viewer, TaskIds: ids})
		if err != nil {
			return nil, err
		}
		for _, t := range out {
			t.ViewerState = true
		}
		for _, s := range subs {
			t := out[idx[s.TaskID]]
			t.Subscribed, t.Muted = true, s.Muted
			t.Unread = s.NotifiedAt != nil && (s.SeenAt == nil || s.NotifiedAt.After(*s.SeenAt))
		}
	}
	return out, nil
}

// activity converts a journal entry.
func activity(a sqlc.TaskActivity) *v1.TaskActivity {
	return &v1.TaskActivity{
		Id: a.ID.String(), TaskId: a.TaskID.String(), BoardId: a.BoardID.String(), ActorId: idp(a.ActorID), Kind: a.Kind,
		Before: jsonStruct(a.Before), After: jsonStruct(a.After), CreatedAt: timestamppb.New(a.CreatedAt), RuleId: idp(a.RuleID),
	}
}

func jsonStruct(b []byte) *structpb.Struct {
	if len(b) == 0 {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	s, err := structpb.NewStruct(m)
	if err != nil {
		return nil
	}
	return s
}

// files converts task attachments.
func files(fs []sqlc.File) []*v1.FileMeta {
	out := make([]*v1.FileMeta, len(fs))
	for i, f := range fs {
		out[i] = pbconv.File(f)
	}
	return out
}
