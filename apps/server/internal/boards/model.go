package boards

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgtype"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Limits (ADR-0042 §6).
const (
	MaxBoards         = 50 // per workspace, live and archived
	MaxStatuses       = 20
	MaxLabels         = 50
	MaxMilestones     = 50
	MaxViews          = 30
	MaxTasks          = 5000 // live tasks per board
	MaxSubtasks       = 200
	MaxAssignees      = 10
	MaxRelations      = 50 // per task and kind side, a sanity bound
	MaxAttachments    = 20
	MaxTitle          = 200
	MaxDescription    = 20000
	MaxBoardName      = 60
	MaxBoardDesc      = 2000
	MaxStatusName     = 32
	MaxLabelName      = 32
	MaxMilestoneName  = 60
	MaxViewName       = 40
	MaxNote           = 120
	MaxEstimate       = 21
	MaxAutoArchive    = 3650
	PageSize          = 500
	MyTasksPage       = 200
	DefaultSearchSize = 20
	MaxSearchSize     = 50
)

// Reasons of 409 CONFLICT (ApiError.reason).
const (
	ReasonBoardLimit     = "BOARD_LIMIT"      // 50 boards per workspace
	ReasonBoardTaskLimit = "BOARD_TASK_LIMIT" // 5000 live tasks per board
	// ReasonFeatureDisabled: a write sets a field of a board feature that is switched off
	// (ADR-0058 §3); ApiError.field names the field.
	ReasonFeatureDisabled = "FEATURE_DISABLED"
	// ReasonBoardCategoryLimit: the 51st board category of a workspace (ADR-0058 §1).
	ReasonBoardCategoryLimit = "BOARD_CATEGORY_LIMIT"
)

// MaxBoardCategories / MaxCategoryName: board categories (ADR-0058 §1).
const (
	MaxBoardCategories = 50
	MaxCategoryName    = 100
)

// ---- board features (ADR-0058 §3) ----

// featureBit is the bit of a feature in boards.disabled_features (bit = the enum value).
func featureBit(f v1.BoardFeature) int64 { return 1 << uint(f) } //nolint:gosec // 1..16

// Disabled reports whether feature f is switched off in a disabled_features mask.
func Disabled(mask int64, f v1.BoardFeature) bool { return mask&featureBit(f) != 0 }

// FeatureMask converts a requested disabled set to the stored mask: UNSPECIFIED and unknown
// values are 422.
func FeatureMask(fs []v1.BoardFeature) (int64, error) {
	var m int64
	for _, f := range fs {
		if _, ok := v1.BoardFeature_name[int32(f)]; !ok || f == v1.BoardFeature_BOARD_FEATURE_UNSPECIFIED {
			return 0, httpx.Validation("disabledFeatures", "unknown board feature")
		}
		m |= featureBit(f)
	}
	return m, nil
}

// FeaturesProto lists the features of a mask, ascending (Board.disabled_features).
func FeaturesProto(mask int64) []v1.BoardFeature {
	var out []v1.BoardFeature
	for f := v1.BoardFeature(1); f < 63; f++ {
		if Disabled(mask, f) {
			out = append(out, f)
		}
	}
	return out
}

// CommentsOff reports whether a board (broadcast form) has the feature COMMENTS switched off:
// its task rooms are read-only (the gateway's taskRoomBits).
func CommentsOff(b *v1.Board) bool {
	return slices.Contains(b.GetDisabledFeatures(), v1.BoardFeature_BOARD_FEATURE_COMMENTS)
}

// requireFeature is the one feature check of every task write (ADR-0058 §3): a request that
// sets a field of feature f to a new non-empty value (sets) on a board where f is switched off
// is 409 CONFLICT FEATURE_DISABLED with field = the JSON name of the request field. Clearing the
// field and repeating its current value pass, so clients and bots that send them do not break.
func requireFeature(disabled int64, f v1.BoardFeature, field string, sets bool) error {
	if !sets || !Disabled(disabled, f) {
		return nil
	}
	e := httpx.Conflict("the board feature "+strings.TrimPrefix(f.String(), "BOARD_FEATURE_")+" is switched off").
		WithDetails(ReasonFeatureDisabled, 0, 0)
	e.Field = field
	return e
}

var estimateScales = map[v1.EstimateScale]string{
	v1.EstimateScale_ESTIMATE_SCALE_FIBONACCI: "fibonacci",
	v1.EstimateScale_ESTIMATE_SCALE_LINEAR:    "linear",
	v1.EstimateScale_ESTIMATE_SCALE_TSHIRT:    "tshirt",
}

// EstimateScaleFromDB maps a stored scale (fibonacci for an unknown one).
func EstimateScaleFromDB(s string) v1.EstimateScale {
	for k, v := range estimateScales {
		if v == s {
			return k
		}
	}
	return v1.EstimateScale_ESTIMATE_SCALE_FIBONACCI
}

// scaleValues are the estimates of each stored scale (T-shirt: XS = 1, S = 2, M = 3, L = 5,
// XL = 8).
var scaleValues = map[string][]int16{
	"fibonacci": {1, 2, 3, 5, 8, 13, 21},
	"linear":    {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
	"tshirt":    {1, 2, 3, 5, 8},
}

// InScale reports whether estimate n belongs to the stored scale (fibonacci when unknown).
func InScale(scale string, n int16) bool {
	vs, ok := scaleValues[scale]
	if !ok {
		vs = scaleValues["fibonacci"]
	}
	return slices.Contains(vs, n)
}

// SearchVector is the indexed text of a task (migration 00046, tasks_search_idx).
const SearchVector = "to_tsvector('simple', t.title || ' ' || t.description)"

var statusTypeDB = map[v1.BoardStatusType]string{
	v1.BoardStatusType_BOARD_STATUS_TYPE_BACKLOG:   "backlog",
	v1.BoardStatusType_BOARD_STATUS_TYPE_UNSTARTED: "unstarted",
	v1.BoardStatusType_BOARD_STATUS_TYPE_STARTED:   "started",
	v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED: "completed",
	v1.BoardStatusType_BOARD_STATUS_TYPE_CANCELLED: "cancelled",
}

// StatusTypeToDB maps a status type; "" for UNSPECIFIED / unknown.
func StatusTypeToDB(t v1.BoardStatusType) string { return statusTypeDB[t] }

// StatusTypeFromDB maps a stored status type.
func StatusTypeFromDB(s string) v1.BoardStatusType {
	for k, v := range statusTypeDB {
		if v == s {
			return k
		}
	}
	return v1.BoardStatusType_BOARD_STATUS_TYPE_UNSPECIFIED
}

// Finished reports a completed / cancelled status type.
func Finished(t string) bool { return t == "completed" || t == "cancelled" }

var viewKinds = map[v1.BoardViewKind]string{
	v1.BoardViewKind_BOARD_VIEW_KIND_KANBAN:   "kanban",
	v1.BoardViewKind_BOARD_VIEW_KIND_LIST:     "list",
	v1.BoardViewKind_BOARD_VIEW_KIND_TIMELINE: "timeline",
}

func viewKindFromDB(s string) v1.BoardViewKind {
	for k, v := range viewKinds {
		if v == s {
			return k
		}
	}
	return v1.BoardViewKind_BOARD_VIEW_KIND_KANBAN
}

var relationKinds = map[v1.TaskRelationKind]string{
	v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS:     "blocks",
	v1.TaskRelationKind_TASK_RELATION_KIND_RELATES:    "relates",
	v1.TaskRelationKind_TASK_RELATION_KIND_DUPLICATES: "duplicates",
}

func relationFromDB(s string) v1.TaskRelationKind {
	for k, v := range relationKinds {
		if v == s {
			return k
		}
	}
	return v1.TaskRelationKind_TASK_RELATION_KIND_UNSPECIFIED
}

var keyRE = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,5}$`)

// ValidKey reports a board key: 2..6 of A–Z0–9 starting with a letter.
func ValidKey(k string) bool { return keyRE.MatchString(k) }

// DeriveKey proposes a key from a board name: the initials of its words (up to 6), or the first
// three letters of a single word (Cyrillic transliterated), "TASK" as a fallback.
func DeriveKey(name string) string {
	var words []string
	for _, w := range strings.FieldsFunc(name, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if t := translit(w); t != "" {
			words = append(words, t)
		}
	}
	var k string
	switch {
	case len(words) >= 2:
		for _, w := range words[:min(len(words), 6)] {
			k += w[:1]
		}
	case len(words) == 1:
		k = words[0][:min(len(words[0]), 3)]
	}
	if ValidKey(k) {
		return k
	}
	return "TASK"
}

var cyr = map[rune]string{'А': "A", 'Б': "B", 'В': "V", 'Г': "G", 'Д': "D", 'Е': "E", 'Ё': "E", 'Ж': "ZH", 'З': "Z", 'И': "I",
	'Й': "Y", 'К': "K", 'Л': "L", 'М': "M", 'Н': "N", 'О': "O", 'П': "P", 'Р': "R", 'С': "S", 'Т': "T", 'У': "U", 'Ф': "F",
	'Х': "H", 'Ц': "C", 'Ч': "CH", 'Ш': "SH", 'Щ': "SCH", 'Ы': "Y", 'Э': "E", 'Ю': "YU", 'Я': "YA"}

func translit(w string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(w) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteString(cyr[r])
		}
	}
	s := b.String()
	for s != "" && s[0] >= '0' && s[0] <= '9' {
		s = s[1:]
	}
	return s
}

var taskKeyRE = regexp.MustCompile(`^([A-Za-z][A-Za-z0-9]{1,5})-(\d{1,9})$`)

// ParseKey splits a task key "FNG-12" into the board key and the number.
func ParseKey(s string) (string, int32, bool) {
	m := taskKeyRE.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return "", 0, false
	}
	n, err := strconv.ParseInt(m[2], 10, 32)
	if err != nil || n < 1 {
		return "", 0, false
	}
	return strings.ToUpper(m[1]), int32(n), true
}

// TaskKey is the key of a task.
func TaskKey(boardKey string, number int32) string {
	return boardKey + "-" + strconv.Itoa(int(number))
}

// ---- positions (fractional order within a status) ----

// PositionStep is the gap between neighbours after a renormalisation and at the end.
const PositionStep = 1024.0

// minGap: a new position closer than this to a neighbour triggers a renormalisation.
const minGap = 1e-6

// Between returns a position between prev and next (nil = none on that side) and whether the
// column must be renormalised first (the gap is exhausted).
func Between(prev, next *float64) (float64, bool) {
	switch {
	case prev == nil && next == nil:
		return PositionStep, false
	case prev == nil:
		return *next - PositionStep, false
	case next == nil:
		return *prev + PositionStep, false
	}
	p := (*prev + *next) / 2
	if *next-*prev < 2*minGap || p <= *prev || p >= *next || math.IsNaN(p) {
		return p, true
	}
	return p, false
}

// Renormalised returns evenly spaced positions for n tasks in their current order.
func Renormalised(n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = float64(i+1) * PositionStep
	}
	return out
}

// ---- dates ----

// ParseDate parses "YYYY-MM-DD" ("" = none).
func ParseDate(s string) (pgtype.Date, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return pgtype.Date{}, true
	}
	t, err := time.Parse(time.DateOnly, s)
	if err != nil || t.Year() < 1970 || t.Year() > 2200 {
		return pgtype.Date{}, false
	}
	return pgtype.Date{Time: t, Valid: true}, true
}

// DateString formats a date ("" = none).
func DateString(d pgtype.Date) string {
	if !d.Valid {
		return ""
	}
	return d.Time.Format(time.DateOnly)
}
