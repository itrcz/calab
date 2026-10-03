package search

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/searchq"
)

// Limits of GET /api/search.
const (
	SummaryLimit = 4  // hits per section in the summary (no type)
	FeedLimit    = 20 // hits per page of a section feed
	MaxLimit     = 20
)

// typeNames are the query-string names of SearchType, in the order of the response.
var typeNames = []struct {
	name string
	t    v1.SearchType
}{
	{"messages", v1.SearchType_SEARCH_TYPE_MESSAGES},
	{"task_comments", v1.SearchType_SEARCH_TYPE_TASK_COMMENTS},
	{"tasks", v1.SearchType_SEARCH_TYPE_TASKS},
	{"events", v1.SearchType_SEARCH_TYPE_EVENTS},
	{"files", v1.SearchType_SEARCH_TYPE_FILES},
	{"notes", v1.SearchType_SEARCH_TYPE_NOTES},
	{"transcripts", v1.SearchType_SEARCH_TYPE_TRANSCRIPTS},
}

func parseType(s string) (v1.SearchType, bool) {
	for _, n := range typeNames {
		if n.name == s {
			return n.t, true
		}
	}
	return 0, false
}

// request is a validated GET /api/search.
type request struct {
	raw   string // q, trimmed
	q     searchq.Query
	all   bool      // scope=all
	ws    uuid.UUID // scope=<workspace>
	types []v1.SearchType
	feed  bool // type=…: one section with a cursor
	limit int
	sort  v1.SearchSort
	cur   *cursor
	now   time.Time // the freshness reference (from the cursor on later pages)
	// explicitNotes: notes were asked for by type / types (not just "all types").
	explicitNotes bool
}

func (r *request) has(t v1.SearchType) bool {
	for _, x := range r.types {
		if x == t {
			return true
		}
	}
	return false
}

// relevance: the order of a section — the summary orders messages-like sections by recency and
// the others by relevance; a feed follows sort.
func (r *request) relevance(t v1.SearchType) bool {
	if r.feed {
		return r.sort != v1.SearchSort_SEARCH_SORT_NEW
	}
	switch t {
	case v1.SearchType_SEARCH_TYPE_MESSAGES, v1.SearchType_SEARCH_TYPE_TASK_COMMENTS, v1.SearchType_SEARCH_TYPE_NOTES:
		return false
	}
	return true
}

func parseRequest(r *http.Request, now time.Time) (*request, error) {
	v := r.URL.Query()
	req := &request{raw: strings.TrimSpace(v.Get("q")), now: now}
	if n := utf8.RuneCountInString(req.raw); n < 1 || n > searchq.MaxQuery {
		return nil, httpx.Validation("q", "search query must be 1..200 characters")
	}
	q, err := searchq.Parse(req.raw)
	if err != nil {
		return nil, httpx.Validation("q", "search query has no words")
	}
	req.q = q
	switch s := v.Get("scope"); s {
	case "all":
		req.all = true
	case "":
		return nil, httpx.BadRequest("scope must be a workspace id or all")
	default:
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, httpx.BadRequest("scope must be a workspace id or all")
		}
		req.ws = id
	}
	explicitNotes := false
	if s := v.Get("type"); s != "" {
		t, ok := parseType(s)
		if !ok {
			return nil, httpx.BadRequest("unknown type " + strconv.Quote(s))
		}
		req.feed, req.types, explicitNotes = true, []v1.SearchType{t}, t == v1.SearchType_SEARCH_TYPE_NOTES
	} else {
		want := map[v1.SearchType]bool{}
		if s := v.Get("types"); s != "" {
			for _, name := range strings.Split(s, ",") {
				t, ok := parseType(strings.TrimSpace(name))
				if !ok {
					return nil, httpx.BadRequest("unknown type " + strconv.Quote(name))
				}
				want[t] = true
			}
			explicitNotes = want[v1.SearchType_SEARCH_TYPE_NOTES]
		}
		for _, n := range typeNames {
			if len(want) == 0 || want[n.t] {
				req.types = append(req.types, n.t)
			}
		}
	}
	req.explicitNotes = explicitNotes
	req.limit = SummaryLimit
	if req.feed {
		req.limit = FeedLimit
	}
	if s := v.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > MaxLimit {
			return nil, httpx.BadRequest("limit must be 1..20")
		}
		req.limit = n
	}
	switch s := v.Get("sort"); s {
	case "", "relevance":
		req.sort = v1.SearchSort_SEARCH_SORT_RELEVANCE
	case "new":
		req.sort = v1.SearchSort_SEARCH_SORT_NEW
	default:
		return nil, httpx.BadRequest("sort must be relevance or new")
	}
	if s := v.Get("cursor"); s != "" {
		if !req.feed {
			return nil, httpx.BadRequest("cursor needs type")
		}
		c, err := decodeCursor(s, req)
		if err != nil {
			return nil, err
		}
		req.cur, req.now = c, time.UnixMilli(c.N)
	}
	return req, nil
}

// notesAllowed: the notes section is computed — the caller's own shelves, with scope=all or
// when asked for explicitly, never for bots (ADR-0062 §2). Otherwise the section stays in the
// response, empty, so that the client's layout does not depend on it.
func (r *request) notesAllowed(bot bool) bool {
	return !bot && (r.all || r.explicitNotes)
}

// ---- cursors ----

// cursor is the position after the last hit of a feed page: opaque to clients (base64 JSON),
// bound to the query, scope, type and sort it was made for.
type cursor struct {
	T int32   `json:"t"` // SearchType
	S int32   `json:"s"` // SearchSort
	H uint64  `json:"h"` // hash of q and scope
	N int64   `json:"n"` // freshness reference time, Unix ms (scores stay stable across pages)
	R float64 `json:"r"` // score of the last hit (relevance)
	I string  `json:"i"` // id of the last hit
}

func (r *request) hash() uint64 {
	scope := "all"
	if !r.all {
		scope = r.ws.String()
	}
	sum := sha256.Sum256([]byte(r.raw + "\x00" + scope))
	return binary.BigEndian.Uint64(sum[:8])
}

func (r *request) encodeCursor(t v1.SearchType, score float64, id uuid.UUID) string {
	b, _ := json.Marshal(cursor{T: int32(t), S: int32(r.sort), H: r.hash(), N: r.now.UnixMilli(), R: score, I: id.String()})
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeCursor(s string, r *request) (*cursor, error) {
	bad := httpx.BadRequest("invalid cursor")
	if len(s) > 512 {
		return nil, bad
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, bad
	}
	var c cursor
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, bad
	}
	if c.T != int32(r.types[0]) || c.S != int32(r.sort) || c.H != r.hash() ||
		math.IsNaN(c.R) || math.IsInf(c.R, 0) || c.R < 0 || c.N <= 0 {
		return nil, bad
	}
	if _, err := uuid.Parse(c.I); err != nil {
		return nil, bad
	}
	return &c, nil
}

func (c *cursor) id() uuid.UUID { return uuid.MustParse(c.I) }
