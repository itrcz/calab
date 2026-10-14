package boards

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

var env = FilterEnv{Viewer: uuid.MustParse("00000000-0000-0000-0000-00000000000a"), Today: time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC)}

func cond(f v1.TaskField, op v1.TaskOp, vals ...string) *v1.TaskCondition {
	return &v1.TaskCondition{Field: f, Op: op, Values: vals}
}

// Every field / op the translator supports produces SQL with its arguments; unsupported pairs
// and bad values are 422.
func TestTranslateFields(t *testing.T) {
	id := uuid.NewString()
	ts := timestamppb.New(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	cases := []struct {
		name string
		c    *v1.TaskCondition
		sql  string
		args int
	}{
		{"status is", cond(v1.TaskField_TASK_FIELD_STATUS, v1.TaskOp_TASK_OP_IS, id), "t.status_id = ANY($1::uuid[])", 1},
		{"status none of", cond(v1.TaskField_TASK_FIELD_STATUS, v1.TaskOp_TASK_OP_NONE_OF, id), "NOT coalesce(t.status_id = ANY($1::uuid[]), false)", 1},
		{"status type", cond(v1.TaskField_TASK_FIELD_STATUS_TYPE, v1.TaskOp_TASK_OP_ANY_OF, "started", "BOARD_STATUS_TYPE_COMPLETED"), "st.type = ANY($1::text[])", 1},
		{"status type not", cond(v1.TaskField_TASK_FIELD_STATUS_TYPE, v1.TaskOp_TASK_OP_IS_NOT, "done"), "NOT t.status_id IN", 1},
		{"assignee me", cond(v1.TaskField_TASK_FIELD_ASSIGNEE, v1.TaskOp_TASK_OP_IS, "me"), "x.user_id = ANY($1::uuid[])", 1},
		{"assignee none", cond(v1.TaskField_TASK_FIELD_ASSIGNEE, v1.TaskOp_TASK_OP_EMPTY), "NOT EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id)", 0},
		{"assignee none of", cond(v1.TaskField_TASK_FIELD_ASSIGNEE, v1.TaskOp_TASK_OP_NONE_OF, id), "NOT EXISTS", 1},
		{"lead", cond(v1.TaskField_TASK_FIELD_LEAD, v1.TaskOp_TASK_OP_ANY_OF, id), "AND x.is_lead AND x.user_id", 1},
		{"creator", cond(v1.TaskField_TASK_FIELD_CREATOR, v1.TaskOp_TASK_OP_IS, "me"), "t.created_by = ANY($1::uuid[])", 1},
		{"subscriber", cond(v1.TaskField_TASK_FIELD_SUBSCRIBER, v1.TaskOp_TASK_OP_IS, "me"), "task_subscribers x WHERE x.task_id = t.id AND NOT x.muted", 1},
		{"priority names", cond(v1.TaskField_TASK_FIELD_PRIORITY, v1.TaskOp_TASK_OP_ANY_OF, "high", "4"), "t.priority = ANY($1::smallint[])", 1},
		{"priority gt", &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_PRIORITY, Op: v1.TaskOp_TASK_OP_GT, Number: 2}, "t.priority > $1", 1},
		{"priority empty", cond(v1.TaskField_TASK_FIELD_PRIORITY, v1.TaskOp_TASK_OP_EMPTY), "t.priority = 0", 0},
		{"estimate lt", &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_ESTIMATE, Op: v1.TaskOp_TASK_OP_LT, Number: 5}, "t.estimate < $1", 1},
		{"estimate empty", cond(v1.TaskField_TASK_FIELD_ESTIMATE, v1.TaskOp_TASK_OP_EMPTY), "t.estimate IS NULL", 0},
		{"estimate is", cond(v1.TaskField_TASK_FIELD_ESTIMATE, v1.TaskOp_TASK_OP_IS, "3"), "t.estimate = ANY($1::smallint[])", 1},
		{"label any", cond(v1.TaskField_TASK_FIELD_LABEL, v1.TaskOp_TASK_OP_ANY_OF, id), "task_labels x WHERE x.task_id = t.id AND x.label_id = ANY($1::uuid[])", 1},
		{"label all", cond(v1.TaskField_TASK_FIELD_LABEL, v1.TaskOp_TASK_OP_IS, id, uuid.NewString()), "= 2", 1},
		{"label empty", cond(v1.TaskField_TASK_FIELD_LABEL, v1.TaskOp_TASK_OP_EMPTY), "NOT EXISTS (SELECT 1 FROM task_labels", 0},
		{"milestone", cond(v1.TaskField_TASK_FIELD_MILESTONE, v1.TaskOp_TASK_OP_IS, id), "t.milestone_id = ANY($1::uuid[])", 1},
		{"milestone empty", cond(v1.TaskField_TASK_FIELD_MILESTONE, v1.TaskOp_TASK_OP_EMPTY), "t.milestone_id IS NULL", 0},
		{"parent set", cond(v1.TaskField_TASK_FIELD_PARENT, v1.TaskOp_TASK_OP_NOT_EMPTY), "t.parent_id IS NOT NULL", 0},
		{"parent is", cond(v1.TaskField_TASK_FIELD_PARENT, v1.TaskOp_TASK_OP_IS_NOT, id), "NOT coalesce(t.parent_id = ANY($1::uuid[]), false)", 1},
		{"relation blocked", cond(v1.TaskField_TASK_FIELD_RELATION, v1.TaskOp_TASK_OP_ANY_OF, "blocked"), "x.related_id = t.id AND x.kind = 'blocks'", 0},
		{"relation relates", cond(v1.TaskField_TASK_FIELD_RELATION, v1.TaskOp_TASK_OP_NONE_OF, "relates"), "NOT (EXISTS", 1},
		{"relation empty", cond(v1.TaskField_TASK_FIELD_RELATION, v1.TaskOp_TASK_OP_EMPTY), "NOT EXISTS (SELECT 1 FROM task_relations", 0},
		{"created before", &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_CREATED_AT, Op: v1.TaskOp_TASK_OP_BEFORE, To: ts}, "t.created_at < $1", 1},
		{"updated after", &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_UPDATED_AT, Op: v1.TaskOp_TASK_OP_AFTER, From: ts}, "t.updated_at >= $1", 1},
		{"created between", &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_CREATED_AT, Op: v1.TaskOp_TASK_OP_BETWEEN, From: ts, To: ts}, "t.created_at BETWEEN $1 AND $2", 2},
		{"due overdue", cond(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_BEFORE, "today"), "t.due_on < $1::date", 1},
		{"due this week", cond(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_BETWEEN, "week_start", "week_end"), "t.due_on BETWEEN $1::date AND $2::date", 2},
		{"due none", cond(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_EMPTY), "t.due_on IS NULL", 0},
		{"start is", &v1.TaskCondition{Field: v1.TaskField_TASK_FIELD_START_ON, Op: v1.TaskOp_TASK_OP_IS, From: ts}, "t.start_on = $1::date", 1},
		{"start after", cond(v1.TaskField_TASK_FIELD_START_ON, v1.TaskOp_TASK_OP_AFTER, "2026-10-01"), "t.start_on >= $1::date", 1},
		{"attachments", cond(v1.TaskField_TASK_FIELD_HAS_ATTACHMENTS, v1.TaskOp_TASK_OP_IS, "true"), "EXISTS (SELECT 1 FROM task_attachments", 0},
		{"no comments", cond(v1.TaskField_TASK_FIELD_HAS_COMMENTS, v1.TaskOp_TASK_OP_IS, "false"), "NOT EXISTS (SELECT 1 FROM messages", 0},
		{"comments set", cond(v1.TaskField_TASK_FIELD_HAS_COMMENTS, v1.TaskOp_TASK_OP_NOT_EMPTY), "EXISTS (SELECT 1 FROM messages", 0},
		{"archived", cond(v1.TaskField_TASK_FIELD_ARCHIVED, v1.TaskOp_TASK_OP_IS, "true"), "t.archived_at IS NOT NULL", 0},
		{"approval state", cond(v1.TaskField_TASK_FIELD_APPROVAL_STATE, v1.TaskOp_TASK_OP_ANY_OF, "pending", "TASK_APPROVAL_STATE_REJECTED", "3"), "FROM task_approvers x WHERE x.task_id = t.id) = ANY($1::text[])", 1},
		{"approval state not", cond(v1.TaskField_TASK_FIELD_APPROVAL_STATE, v1.TaskOp_TASK_OP_IS_NOT, "none"), "NOT coalesce((SELECT CASE", 1},
		{"approver pending me", cond(v1.TaskField_TASK_FIELD_APPROVER_PENDING, v1.TaskOp_TASK_OP_IS, "me"), "task_approvers x WHERE x.task_id = t.id AND x.state = 'pending' AND x.user_id = ANY($1::uuid[])", 1},
		{"approver pending any", cond(v1.TaskField_TASK_FIELD_APPROVER_PENDING, v1.TaskOp_TASK_OP_NOT_EMPTY), "EXISTS (SELECT 1 FROM task_approvers x WHERE x.task_id = t.id AND x.state = 'pending')", 0},
		{"text", cond(v1.TaskField_TASK_FIELD_TEXT, v1.TaskOp_TASK_OP_CONTAINS, "login bug"), "plainto_tsquery('simple', $2)", 2},
		{"text key", cond(v1.TaskField_TASK_FIELD_TEXT, v1.TaskOp_TASK_OP_CONTAINS, "fng-12"), "t.number = $3 AND t.board_id IN (SELECT kb.id FROM boards kb WHERE kb.key = $4)", 4},
		{"text key prefix", cond(v1.TaskField_TASK_FIELD_TEXT, v1.TaskOp_TASK_OP_CONTAINS, "FNG"), "kb.key LIKE $3", 3},
	}
	for _, c := range cases {
		var a Args
		got, err := Translate(&v1.TaskFilter{Conditions: []*v1.TaskCondition{c.c}}, env, &a)
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if !strings.Contains(got, c.sql) || len(a.Values()) != c.args {
			t.Errorf("%s: %s (%d args), want %q (%d args)", c.name, got, len(a.Values()), c.sql, c.args)
		}
	}
}

func TestTranslateAnyAndErrors(t *testing.T) {
	var a Args
	got, err := Translate(&v1.TaskFilter{Any: true, Conditions: []*v1.TaskCondition{
		cond(v1.TaskField_TASK_FIELD_ASSIGNEE, v1.TaskOp_TASK_OP_EMPTY),
		cond(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_EMPTY),
	}}, env, &a)
	if err != nil || !strings.Contains(got, ") OR (") {
		t.Fatalf("any: %s %v", got, err)
	}
	if got, _ := Translate(&v1.TaskFilter{}, env, &a); got != "true" {
		t.Fatalf("empty filter: %s", got)
	}
	bad := []*v1.TaskCondition{
		cond(v1.TaskField_TASK_FIELD_STATUS, v1.TaskOp_TASK_OP_IS, "not-a-uuid"),
		cond(v1.TaskField_TASK_FIELD_STATUS, v1.TaskOp_TASK_OP_CONTAINS, uuid.NewString()),
		cond(v1.TaskField_TASK_FIELD_TEXT, v1.TaskOp_TASK_OP_IS, "x"),
		cond(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_BEFORE, "tomorrowish"),
		cond(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_BETWEEN, "today"),
		cond(v1.TaskField_TASK_FIELD_PRIORITY, v1.TaskOp_TASK_OP_IS, "extreme"),
		cond(v1.TaskField_TASK_FIELD_RELATION, v1.TaskOp_TASK_OP_ANY_OF, "parent"),
		cond(v1.TaskField_TASK_FIELD_STATUS_TYPE, v1.TaskOp_TASK_OP_IS, "doing"),
		cond(v1.TaskField_TASK_FIELD_ARCHIVED, v1.TaskOp_TASK_OP_IS, "maybe"),
		cond(v1.TaskField_TASK_FIELD_APPROVAL_STATE, v1.TaskOp_TASK_OP_IS, "halfway"),
		cond(v1.TaskField_TASK_FIELD_APPROVAL_STATE, v1.TaskOp_TASK_OP_EMPTY),
		cond(v1.TaskField_TASK_FIELD_APPROVER_PENDING, v1.TaskOp_TASK_OP_IS, "nobody"),
		cond(v1.TaskField_TASK_FIELD_UNSPECIFIED, v1.TaskOp_TASK_OP_IS),
		{Field: v1.TaskField_TASK_FIELD_CREATED_AT, Op: v1.TaskOp_TASK_OP_BETWEEN},
	}
	for i, c := range bad {
		if _, err := Translate(&v1.TaskFilter{Conditions: []*v1.TaskCondition{c}}, env, &Args{}); err == nil {
			t.Errorf("bad[%d] %v accepted", i, c)
		}
	}
	many := &v1.TaskFilter{}
	for range 31 {
		many.Conditions = append(many.Conditions, cond(v1.TaskField_TASK_FIELD_DUE_ON, v1.TaskOp_TASK_OP_EMPTY))
	}
	if _, err := Translate(many, env, &Args{}); err == nil {
		t.Fatal("31 conditions accepted")
	}
	if !HasArchived(&v1.TaskFilter{Conditions: []*v1.TaskCondition{cond(v1.TaskField_TASK_FIELD_ARCHIVED, v1.TaskOp_TASK_OP_IS, "true")}}) {
		t.Fatal("HasArchived")
	}
}

func TestResolveDate(t *testing.T) {
	today := time.Date(2026, 9, 30, 0, 0, 0, 0, time.UTC) // a Wednesday
	for in, want := range map[string]string{"today": "2026-09-30", "week_start": "2026-09-28", "week_end": "2026-10-04",
		"month_end": "2026-09-30", "-7d": "2026-09-23", "+14d": "2026-10-14", "2026-01-05": "2026-01-05"} {
		if got, err := ResolveDate(in, today); err != nil || got != want {
			t.Errorf("%s: %s %v, want %s", in, got, err, want)
		}
	}
}

func TestPositions(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	if p, r := Between(nil, nil); p != PositionStep || r {
		t.Fatal("empty column")
	}
	if p, _ := Between(f(1024), nil); p != 2048 {
		t.Fatal("last")
	}
	if p, _ := Between(nil, f(1024)); p != 0 {
		t.Fatal("first")
	}
	if p, r := Between(f(1024), f(2048)); p != 1536 || r {
		t.Fatal("middle")
	}
	// Halving 60 times exhausts the gap: renormalise.
	lo, hi := 1024.0, 2048.0
	renorm := false
	for range 80 {
		p, r := Between(&lo, &hi)
		if r {
			renorm = true
			break
		}
		hi = p
	}
	if !renorm {
		t.Fatal("gap never exhausted")
	}
	if ps := Renormalised(3); ps[0] != 1024 || ps[2] != 3072 {
		t.Fatalf("renormalised %v", ps)
	}
}

func TestKeys(t *testing.T) {
	for name, want := range map[string]string{"Fintech Next Gen": "FNG", "Финансы": "FIN", "Design": "DES", "Мобильное приложение": "MP",
		"x": "TASK", "2026 Q4 Plan": "QP"} {
		if got := DeriveKey(name); got != want {
			t.Errorf("DeriveKey(%q) = %q, want %q", name, got, want)
		}
	}
	for _, k := range []string{"FNG", "A1", "ABCDEF"} {
		if !ValidKey(k) {
			t.Errorf("%s invalid", k)
		}
	}
	for _, k := range []string{"F", "1AB", "ABCDEFG", "fng", "F-G"} {
		if ValidKey(k) {
			t.Errorf("%s valid", k)
		}
	}
	if k, n, ok := ParseKey("fng-12"); !ok || k != "FNG" || n != 12 {
		t.Fatalf("ParseKey %s %d %v", k, n, ok)
	}
	if _, _, ok := ParseKey("FNG-0"); ok {
		t.Fatal("number 0")
	}
	if TaskKey("FNG", 7) != "FNG-7" {
		t.Fatal("TaskKey")
	}
}

// ADR-0042 §1: started_at on the first move into STARTED, completed_at / completed_by while
// finished, cleared when reopened.
func TestFinishFields(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	now := time.Now()
	var tr taskRow
	finishFields(&tr, "started", a, now)
	if tr.StartedAt == nil || tr.CompletedAt != nil {
		t.Fatal("started")
	}
	first := *tr.StartedAt
	finishFields(&tr, "completed", a, now.Add(time.Hour))
	if tr.CompletedAt == nil || *tr.CompletedBy != a || *tr.StartedAt != first {
		t.Fatal("completed")
	}
	finishFields(&tr, "cancelled", b, now.Add(2*time.Hour))
	if *tr.CompletedBy != a {
		t.Fatal("finished → finished keeps the first completion")
	}
	finishFields(&tr, "unstarted", b, now)
	if tr.CompletedAt != nil || tr.CompletedBy != nil || tr.StartedAt == nil {
		t.Fatal("reopened")
	}
}

func TestReorder(t *testing.T) {
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	if got := reorder([]uuid.UUID{a, b, c}, c, 0); got[0] != c || got[1] != a || got[2] != b {
		t.Fatalf("%v", got)
	}
	if got := reorder([]uuid.UUID{a, b, c}, a, 99); got[2] != a {
		t.Fatalf("%v", got)
	}
}

// Board features (ADR-0058 §3): the stored mask round-trips, unknown values are 422, the check
// passes clearing / repeats and refuses a new value with reason FEATURE_DISABLED and the field.
func TestFeatureMask(t *testing.T) {
	all := make([]v1.BoardFeature, 0, 16)
	for f := v1.BoardFeature_BOARD_FEATURE_ESTIMATE; f <= v1.BoardFeature_BOARD_FEATURE_GIT_LINKS; f++ {
		all = append(all, f)
	}
	m, err := FeatureMask(all)
	if err != nil || m != 0x1FFFE {
		t.Fatalf("mask %x %v", m, err)
	}
	if got := FeaturesProto(m); len(got) != 16 || got[0] != v1.BoardFeature_BOARD_FEATURE_ESTIMATE || got[15] != v1.BoardFeature_BOARD_FEATURE_GIT_LINKS {
		t.Fatalf("features %v", got)
	}
	if FeaturesProto(0) != nil {
		t.Fatal("no features")
	}
	for _, bad := range []v1.BoardFeature{0, 17, 99} {
		if _, err := FeatureMask([]v1.BoardFeature{bad}); err == nil {
			t.Fatalf("feature %d accepted", bad)
		}
	}
	d := featureBit(v1.BoardFeature_BOARD_FEATURE_DUE_DATE)
	if requireFeature(d, v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "dueOn", false) != nil ||
		requireFeature(d, v1.BoardFeature_BOARD_FEATURE_ESTIMATE, "estimate", true) != nil {
		t.Fatal("clearing or another feature refused")
	}
	e := httpx.AsError(requireFeature(d, v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "dueOn", true))
	if e == nil || e.Status != 409 || e.Reason != ReasonFeatureDisabled || e.Field != "dueOn" || e.Proto().GetReason() != ReasonFeatureDisabled {
		t.Fatalf("refusal %+v", e)
	}
	if !CommentsOff(&v1.Board{DisabledFeatures: []v1.BoardFeature{v1.BoardFeature_BOARD_FEATURE_COMMENTS}}) || CommentsOff(&v1.Board{}) {
		t.Fatal("CommentsOff")
	}
}

func TestEstimateScales(t *testing.T) {
	cases := []struct {
		scale string
		in    []int16
		out   []int16
	}{
		{"fibonacci", []int16{1, 2, 3, 5, 8, 13, 21}, []int16{4, 6, 10, 20}},
		{"linear", []int16{1, 4, 7, 10}, []int16{11, 13, 21}},
		{"tshirt", []int16{1, 2, 3, 5, 8}, []int16{4, 13, 21}},
	}
	for _, c := range cases {
		for _, n := range c.in {
			if !InScale(c.scale, n) {
				t.Errorf("%s: %d refused", c.scale, n)
			}
		}
		for _, n := range c.out {
			if InScale(c.scale, n) {
				t.Errorf("%s: %d accepted", c.scale, n)
			}
		}
	}
	for k, v := range estimateScales {
		if EstimateScaleFromDB(v) != k {
			t.Errorf("scale %s", v)
		}
	}
	if EstimateScaleFromDB("") != v1.EstimateScale_ESTIMATE_SCALE_FIBONACCI {
		t.Error("default scale")
	}
}
