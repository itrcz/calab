package boards

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/searchq"
)

// Filter limits (ADR-0042 §3).
const (
	MaxConditions = 30
	MaxValues     = 100
	maxTextQuery  = 200
)

// Args collects positional SQL arguments: Add returns the placeholder of a new one.
type Args struct{ vals []any }

// Add appends v and returns its placeholder ($n).
func (a *Args) Add(v any) string {
	a.vals = append(a.vals, v)
	return "$" + strconv.Itoa(len(a.vals))
}

// Values returns the collected arguments.
func (a *Args) Values() []any { return a.vals }

// FilterEnv is what a filter is evaluated against: "me" and relative dates.
type FilterEnv struct {
	Viewer uuid.UUID
	Today  time.Time // the viewer's current date (midnight UTC of that calendar day)
}

// HasArchived reports whether the filter has an ARCHIVED condition: lists then do not add
// their own «live tasks only».
func HasArchived(f *v1.TaskFilter) bool {
	for _, c := range f.GetConditions() {
		if c.GetField() == v1.TaskField_TASK_FIELD_ARCHIVED {
			return true
		}
	}
	return false
}

func filterErr(i int, msg string) error {
	return httpx.Validation("filter", fmt.Sprintf("conditions[%d]: %s", i, msg))
}

// Translate turns a TaskFilter into one SQL boolean expression over the task row alias `t`
// (ADR-0042 §3: the only place filters meet SQL). Unsupported field / op pairs and malformed
// values are 422. An empty filter is "true".
func Translate(f *v1.TaskFilter, env FilterEnv, a *Args) (string, error) {
	cs := f.GetConditions()
	if len(cs) == 0 {
		return "true", nil
	}
	if len(cs) > MaxConditions {
		return "", httpx.Validation("filter", "at most 30 conditions")
	}
	parts := make([]string, 0, len(cs))
	for i, c := range cs {
		if len(c.GetValues()) > MaxValues {
			return "", filterErr(i, "at most 100 values")
		}
		s, err := condition(c, env, a)
		if err != nil {
			return "", filterErr(i, err.Error())
		}
		parts = append(parts, "("+s+")")
	}
	sep := " AND "
	if f.GetAny() {
		sep = " OR "
	}
	return "(" + strings.Join(parts, sep) + ")", nil
}

var errOp = fmt.Errorf("operation not supported for this field")

func condition(c *v1.TaskCondition, env FilterEnv, a *Args) (string, error) {
	op := c.GetOp()
	switch c.GetField() {
	case v1.TaskField_TASK_FIELD_STATUS:
		ids, err := uuids(c.GetValues(), env)
		if err != nil {
			return "", err
		}
		return inList("t.status_id", a.Add(ids)+"::uuid[]", op, false)
	case v1.TaskField_TASK_FIELD_STATUS_TYPE:
		types, err := statusTypes(c.GetValues())
		if err != nil {
			return "", err
		}
		sub := "t.status_id IN (SELECT st.id FROM board_statuses st WHERE st.board_id = t.board_id AND st.type = ANY(" + a.Add(types) + "::text[]))"
		switch op {
		case v1.TaskOp_TASK_OP_IS, v1.TaskOp_TASK_OP_ANY_OF:
			return sub, nil
		case v1.TaskOp_TASK_OP_IS_NOT, v1.TaskOp_TASK_OP_NONE_OF:
			return "NOT " + sub, nil
		}
		return "", errOp
	case v1.TaskField_TASK_FIELD_ASSIGNEE, v1.TaskField_TASK_FIELD_LEAD:
		lead := ""
		if c.GetField() == v1.TaskField_TASK_FIELD_LEAD {
			lead = " AND x.is_lead"
		}
		return exists("SELECT 1 FROM task_assignees x WHERE x.task_id = t.id"+lead, "x.user_id", c, env, a)
	case v1.TaskField_TASK_FIELD_SUBSCRIBER:
		return exists("SELECT 1 FROM task_subscribers x WHERE x.task_id = t.id AND NOT x.muted", "x.user_id", c, env, a)
	case v1.TaskField_TASK_FIELD_LABEL:
		if op == v1.TaskOp_TASK_OP_IS {
			ids, err := uuids(c.GetValues(), env)
			if err != nil {
				return "", err
			}
			if len(ids) == 0 {
				return "", fmt.Errorf("values required")
			}
			return "(SELECT count(*) FROM task_labels x WHERE x.task_id = t.id AND x.label_id = ANY(" + a.Add(ids) + "::uuid[])) = " + strconv.Itoa(len(ids)), nil
		}
		return exists("SELECT 1 FROM task_labels x WHERE x.task_id = t.id", "x.label_id", c, env, a)
	case v1.TaskField_TASK_FIELD_RELEASE: // board task #101
		return exists("SELECT 1 FROM task_releases x WHERE x.task_id = t.id", "x.release_id", c, env, a)
	case v1.TaskField_TASK_FIELD_BOARD:
		ids, err := uuids(c.GetValues(), env)
		if err != nil {
			return "", err
		}
		return inList("t.board_id", a.Add(ids)+"::uuid[]", op, false)
	case v1.TaskField_TASK_FIELD_CREATOR:
		ids, err := uuids(c.GetValues(), env)
		if err != nil {
			return "", err
		}
		return inList("t.created_by", a.Add(ids)+"::uuid[]", op, false)
	case v1.TaskField_TASK_FIELD_MILESTONE, v1.TaskField_TASK_FIELD_PARENT:
		col := "t.milestone_id"
		if c.GetField() == v1.TaskField_TASK_FIELD_PARENT {
			col = "t.parent_id"
		}
		switch op {
		case v1.TaskOp_TASK_OP_EMPTY:
			return col + " IS NULL", nil
		case v1.TaskOp_TASK_OP_NOT_EMPTY:
			return col + " IS NOT NULL", nil
		}
		ids, err := uuids(c.GetValues(), env)
		if err != nil {
			return "", err
		}
		return inList(col, a.Add(ids)+"::uuid[]", op, true)
	case v1.TaskField_TASK_FIELD_PRIORITY:
		return numeric("t.priority", "smallint", c, a, priorityValue)
	case v1.TaskField_TASK_FIELD_ESTIMATE:
		switch op {
		case v1.TaskOp_TASK_OP_EMPTY:
			return "t.estimate IS NULL", nil
		case v1.TaskOp_TASK_OP_NOT_EMPTY:
			return "t.estimate IS NOT NULL", nil
		}
		return numeric("t.estimate", "smallint", c, a, strconv.Atoi)
	case v1.TaskField_TASK_FIELD_RELATION:
		return relation(c, a)
	case v1.TaskField_TASK_FIELD_CREATED_AT, v1.TaskField_TASK_FIELD_UPDATED_AT:
		col := "t.created_at"
		if c.GetField() == v1.TaskField_TASK_FIELD_UPDATED_AT {
			col = "t.updated_at"
		}
		return timeRange(col, c, a)
	case v1.TaskField_TASK_FIELD_START_ON, v1.TaskField_TASK_FIELD_DUE_ON:
		col := "t.start_on"
		if c.GetField() == v1.TaskField_TASK_FIELD_DUE_ON {
			col = "t.due_on"
		}
		return dateRange(col, c, env, a)
	case v1.TaskField_TASK_FIELD_HAS_ATTACHMENTS:
		return flag("EXISTS (SELECT 1 FROM task_attachments x WHERE x.task_id = t.id)", c)
	case v1.TaskField_TASK_FIELD_HAS_COMMENTS:
		return flag("EXISTS (SELECT 1 FROM messages x WHERE x.room_id = t.room_id AND x.deleted_at IS NULL)", c)
	case v1.TaskField_TASK_FIELD_ARCHIVED:
		return flag("t.archived_at IS NOT NULL", c)
	case v1.TaskField_TASK_FIELD_APPROVAL_STATE:
		states, err := approvalStates(c.GetValues())
		if err != nil {
			return "", err
		}
		return inList(ApprovalStateSQL, a.Add(states)+"::text[]", op, false)
	case v1.TaskField_TASK_FIELD_APPROVER_PENDING:
		return exists("SELECT 1 FROM task_approvers x WHERE x.task_id = t.id AND x.state = 'pending'", "x.user_id", c, env, a)
	case v1.TaskField_TASK_FIELD_TEXT:
		if op != v1.TaskOp_TASK_OP_CONTAINS || len(c.GetValues()) == 0 {
			return "", errOp
		}
		q := strings.TrimSpace(c.GetValues()[0])
		if q == "" || len([]rune(q)) > maxTextQuery {
			return "", fmt.Errorf("text must be 1..200 characters")
		}
		return TextCondition(q, a), nil
	}
	return "", fmt.Errorf("unknown field")
}

// TextCondition matches words of the title / description, a title substring, or the task key
// (FNG-12 exactly, FNG as a board key prefix); «е» and «ё» alike (searchq.Fold).
func TextCondition(q string, a *Args) string {
	fq := searchq.Fold(q)
	like := a.Add("%" + escapeLike(fq) + "%")
	parts := []string{
		SearchVector + " @@ plainto_tsquery('simple', " + a.Add(fq) + ")",
		searchq.FoldSQL("t.title") + " ILIKE " + like,
	}
	if kq, ok := ParseLooseKey(q); ok {
		if len(kq.Prefixes) == 0 {
			parts = append(parts, "t.number = "+a.Add(kq.Number))
		} else {
			parts = append(parts, "(t.number = "+a.Add(kq.Number)+" AND t.board_id IN (SELECT kb.id FROM boards kb WHERE kb.key = ANY("+a.Add(kq.Prefixes)+"::text[])))")
		}
	} else if keyRE.MatchString(strings.ToUpper(q)) {
		parts = append(parts, "t.board_id IN (SELECT kb.id FROM boards kb WHERE kb.key LIKE "+a.Add(strings.ToUpper(q)+"%")+")")
	}
	return "(" + strings.Join(parts, " OR ") + ")"
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// inList: IS / ANY_OF in the list, IS_NOT / NONE_OF not in it (nullable: NULL counts as not in).
func inList(col, arr string, op v1.TaskOp, nullable bool) (string, error) {
	switch op {
	case v1.TaskOp_TASK_OP_IS, v1.TaskOp_TASK_OP_ANY_OF:
		return col + " = ANY(" + arr + ")", nil
	case v1.TaskOp_TASK_OP_IS_NOT, v1.TaskOp_TASK_OP_NONE_OF:
		return "NOT coalesce(" + col + " = ANY(" + arr + "), false)", nil
	case v1.TaskOp_TASK_OP_EMPTY:
		if nullable || col == "t.created_by" {
			return col + " IS NULL", nil
		}
	case v1.TaskOp_TASK_OP_NOT_EMPTY:
		if nullable || col == "t.created_by" {
			return col + " IS NOT NULL", nil
		}
	}
	return "", errOp
}

// exists: a related row set (assignees, labels, subscribers) of the task.
func exists(sub, col string, c *v1.TaskCondition, env FilterEnv, a *Args) (string, error) {
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_EMPTY:
		return "NOT EXISTS (" + sub + ")", nil
	case v1.TaskOp_TASK_OP_NOT_EMPTY:
		return "EXISTS (" + sub + ")", nil
	}
	ids, err := uuids(c.GetValues(), env)
	if err != nil {
		return "", err
	}
	q := "EXISTS (" + sub + " AND " + col + " = ANY(" + a.Add(ids) + "::uuid[]))"
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_IS, v1.TaskOp_TASK_OP_ANY_OF:
		return q, nil
	case v1.TaskOp_TASK_OP_IS_NOT, v1.TaskOp_TASK_OP_NONE_OF:
		return "NOT " + q, nil
	}
	return "", errOp
}

func numeric(col, typ string, c *v1.TaskCondition, a *Args, parse func(string) (int, error)) (string, error) {
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_GT:
		return col + " > " + a.Add(c.GetNumber()), nil
	case v1.TaskOp_TASK_OP_LT:
		return col + " < " + a.Add(c.GetNumber()), nil
	case v1.TaskOp_TASK_OP_EMPTY:
		if col == "t.priority" {
			return "t.priority = 0", nil
		}
	case v1.TaskOp_TASK_OP_NOT_EMPTY:
		if col == "t.priority" {
			return "t.priority <> 0", nil
		}
	case v1.TaskOp_TASK_OP_IS, v1.TaskOp_TASK_OP_ANY_OF, v1.TaskOp_TASK_OP_IS_NOT, v1.TaskOp_TASK_OP_NONE_OF:
		vals := make([]int16, 0, len(c.GetValues())+1)
		for _, s := range c.GetValues() {
			n, err := parse(strings.TrimSpace(s))
			if err != nil || n < 0 || n > 100 {
				return "", fmt.Errorf("invalid number %q", s)
			}
			vals = append(vals, int16(n)) //nolint:gosec // ≤ 100
		}
		if len(vals) == 0 {
			vals = append(vals, int16(max(min(c.GetNumber(), 100), 0))) //nolint:gosec // clamped
		}
		return inList(col, a.Add(vals)+"::"+typ+"[]", c.GetOp(), true)
	}
	return "", errOp
}

var priorityNames = map[string]int{"none": 0, "low": 1, "medium": 2, "high": 3, "urgent": 4}

func priorityValue(s string) (int, error) {
	l := strings.ToLower(strings.TrimPrefix(strings.ToUpper(s), "TASK_PRIORITY_"))
	if n, ok := priorityNames[l]; ok {
		return n, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 || n > 4 {
		return 0, fmt.Errorf("invalid priority")
	}
	return n, nil
}

var statusTypeNames = map[string]string{"backlog": "backlog", "unstarted": "unstarted", "todo": "unstarted",
	"started": "started", "completed": "completed", "done": "completed", "cancelled": "cancelled", "canceled": "cancelled"}

func statusTypes(vals []string) ([]string, error) {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		s := strings.ToLower(strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(v)), "BOARD_STATUS_TYPE_"))
		if n, err := strconv.Atoi(s); err == nil {
			s = StatusTypeToDB(v1.BoardStatusType(n)) //nolint:gosec // validated below
		}
		t, ok := statusTypeNames[s]
		if !ok {
			return nil, fmt.Errorf("invalid status type %q", v)
		}
		out = append(out, t)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("values required")
	}
	return out, nil
}

// ApprovalStateSQL is a task's derived approval state (ADR-0049; Tally.State in SQL): 'none' |
// 'rejected' | 'approved' | 'pending'.
const ApprovalStateSQL = `(SELECT CASE WHEN count(*) = 0 THEN 'none'
	WHEN count(*) FILTER (WHERE x.state = 'rejected') > 0 THEN 'rejected'
	WHEN count(*) FILTER (WHERE x.state = 'approved') >=
		CASE WHEN t.approval_required = 0 OR t.approval_required > count(*) THEN count(*) ELSE t.approval_required END THEN 'approved'
	ELSE 'pending' END FROM task_approvers x WHERE x.task_id = t.id)`

var approvalStateNames = map[string]string{"none": "none", "pending": "pending", "approved": "approved", "rejected": "rejected"}

func approvalStates(vals []string) ([]string, error) {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		s := strings.ToLower(strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(v)), "TASK_APPROVAL_STATE_"))
		if n, err := strconv.Atoi(s); err == nil {
			s = strings.ToLower(strings.TrimPrefix(v1.TaskApprovalState(n).String(), "TASK_APPROVAL_STATE_")) //nolint:gosec // validated below
		}
		st, ok := approvalStateNames[s]
		if !ok {
			return nil, fmt.Errorf("invalid approval state %q", v)
		}
		out = append(out, st)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("values required")
	}
	return out, nil
}

// uuids parses id values; "me" is the viewer.
func uuids(vals []string, env FilterEnv) ([]uuid.UUID, error) {
	out := make([]uuid.UUID, 0, len(vals))
	for _, v := range vals {
		if strings.EqualFold(strings.TrimSpace(v), "me") {
			out = append(out, env.Viewer)
			continue
		}
		id, err := uuid.Parse(strings.TrimSpace(v))
		if err != nil {
			return nil, fmt.Errorf("invalid id %q", v)
		}
		out = append(out, id)
	}
	return out, nil
}

func relation(c *v1.TaskCondition, a *Args) (string, error) {
	anyRel := "EXISTS (SELECT 1 FROM task_relations x WHERE x.task_id = t.id OR x.related_id = t.id)"
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_EMPTY:
		return "NOT " + anyRel, nil
	case v1.TaskOp_TASK_OP_NOT_EMPTY:
		return anyRel, nil
	}
	parts := make([]string, 0, len(c.GetValues()))
	for _, v := range c.GetValues() {
		switch strings.ToLower(strings.TrimSpace(v)) {
		case "blocks":
			parts = append(parts, "EXISTS (SELECT 1 FROM task_relations x WHERE x.task_id = t.id AND x.kind = 'blocks')")
		case "blocked":
			parts = append(parts, "EXISTS (SELECT 1 FROM task_relations x WHERE x.related_id = t.id AND x.kind = 'blocks')")
		case "relates", "duplicates":
			parts = append(parts, "EXISTS (SELECT 1 FROM task_relations x WHERE (x.task_id = t.id OR x.related_id = t.id) AND x.kind = "+
				a.Add(strings.ToLower(strings.TrimSpace(v)))+")")
		default:
			return "", fmt.Errorf("invalid relation %q", v)
		}
	}
	if len(parts) == 0 {
		return "", fmt.Errorf("values required")
	}
	q := "(" + strings.Join(parts, " OR ") + ")"
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_IS, v1.TaskOp_TASK_OP_ANY_OF:
		return q, nil
	case v1.TaskOp_TASK_OP_IS_NOT, v1.TaskOp_TASK_OP_NONE_OF:
		return "NOT " + q, nil
	}
	return "", errOp
}

func timeRange(col string, c *v1.TaskCondition, a *Args) (string, error) {
	from, to := c.GetFrom(), c.GetTo()
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_BEFORE:
		bound := to
		if bound == nil {
			bound = from
		}
		if bound == nil {
			return "", fmt.Errorf("to required")
		}
		return col + " < " + a.Add(bound.AsTime()), nil
	case v1.TaskOp_TASK_OP_AFTER:
		bound := from
		if bound == nil {
			bound = to
		}
		if bound == nil {
			return "", fmt.Errorf("from required")
		}
		return col + " >= " + a.Add(bound.AsTime()), nil
	case v1.TaskOp_TASK_OP_BETWEEN:
		if from == nil || to == nil {
			return "", fmt.Errorf("from and to required")
		}
		return col + " BETWEEN " + a.Add(from.AsTime()) + " AND " + a.Add(to.AsTime()), nil
	}
	return "", errOp
}

func dateRange(col string, c *v1.TaskCondition, env FilterEnv, a *Args) (string, error) {
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_EMPTY:
		return col + " IS NULL", nil
	case v1.TaskOp_TASK_OP_NOT_EMPTY:
		return col + " IS NOT NULL", nil
	}
	dates := make([]string, 0, 2)
	for _, v := range c.GetValues() {
		d, err := ResolveDate(v, env.Today)
		if err != nil {
			return "", err
		}
		dates = append(dates, d)
	}
	if len(dates) == 0 {
		for _, ts := range []interface {
			IsValid() bool
			AsTime() time.Time
		}{c.GetFrom(), c.GetTo()} {
			if ts.IsValid() {
				dates = append(dates, ts.AsTime().UTC().Format(time.DateOnly))
			}
		}
	}
	one := func() (string, error) {
		if len(dates) == 0 {
			return "", fmt.Errorf("a date is required")
		}
		return a.Add(dates[0]) + "::date", nil
	}
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_IS:
		d, err := one()
		return col + " = " + d, err
	case v1.TaskOp_TASK_OP_BEFORE:
		d, err := one()
		return col + " < " + d, err
	case v1.TaskOp_TASK_OP_AFTER:
		d, err := one()
		return col + " >= " + d, err
	case v1.TaskOp_TASK_OP_BETWEEN:
		if len(dates) < 2 {
			return "", fmt.Errorf("two dates required")
		}
		return col + " BETWEEN " + a.Add(dates[0]) + "::date AND " + a.Add(dates[1]) + "::date", nil
	}
	return "", errOp
}

func flag(expr string, c *v1.TaskCondition) (string, error) {
	switch c.GetOp() {
	case v1.TaskOp_TASK_OP_NOT_EMPTY:
		return expr, nil
	case v1.TaskOp_TASK_OP_EMPTY:
		return "NOT " + expr, nil
	case v1.TaskOp_TASK_OP_IS, v1.TaskOp_TASK_OP_IS_NOT:
		want := len(c.GetValues()) == 0 || strings.EqualFold(strings.TrimSpace(c.GetValues()[0]), "true")
		if len(c.GetValues()) > 0 && !want && !strings.EqualFold(strings.TrimSpace(c.GetValues()[0]), "false") {
			return "", fmt.Errorf("value must be true or false")
		}
		if c.GetOp() == v1.TaskOp_TASK_OP_IS_NOT {
			want = !want
		}
		if want {
			return expr, nil
		}
		return "NOT " + expr, nil
	}
	return "", errOp
}

var relDays = regexp.MustCompile(`^([+-])(\d{1,4})d$`)

// ResolveDate turns a filter date value into "YYYY-MM-DD": a date, or relative to today:
// "today", "week_start" / "week_end" (Monday..Sunday), "month_end", "-7d" / "+14d".
func ResolveDate(v string, today time.Time) (string, error) {
	v = strings.ToLower(strings.TrimSpace(v))
	d := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	wd := (int(d.Weekday()) + 6) % 7 // Monday = 0
	switch v {
	case "today":
	case "week_start":
		d = d.AddDate(0, 0, -wd)
	case "week_end":
		d = d.AddDate(0, 0, 6-wd)
	case "month_end":
		d = time.Date(d.Year(), d.Month()+1, 0, 0, 0, 0, 0, time.UTC)
	default:
		if m := relDays.FindStringSubmatch(v); m != nil {
			n, _ := strconv.Atoi(m[2])
			if m[1] == "-" {
				n = -n
			}
			d = d.AddDate(0, 0, n)
			break
		}
		t, err := time.Parse(time.DateOnly, v)
		if err != nil {
			return "", fmt.Errorf("invalid date %q", v)
		}
		d = t
	}
	return d.Format(time.DateOnly), nil
}
