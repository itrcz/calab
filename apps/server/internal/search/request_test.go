package search

import (
	"encoding/base64"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

func parse(t *testing.T, qs string) (*request, error) {
	t.Helper()
	return parseRequest(httptest.NewRequestWithContext(t.Context(), "GET", "/api/search?"+qs, nil), time.Unix(1_800_000_000, 0))
}

func status(err error) int {
	if e := httpx.AsError(err); e != nil {
		return e.Status
	}
	return 0
}

func TestParseRequest(t *testing.T) {
	ws := uuid.New().String()
	r, err := parse(t, "q=релиз&scope="+ws)
	if err != nil {
		t.Fatal(err)
	}
	if r.feed || r.limit != SummaryLimit || len(r.types) != len(typeNames) || r.notesAllowed(false) {
		t.Fatalf("summary defaults: %+v", r)
	}
	r, _ = parse(t, "q=x&scope=all")
	if !r.all || !r.notesAllowed(false) || r.notesAllowed(true) {
		t.Fatalf("scope=all: notes for people only")
	}
	r, _ = parse(t, "q=x&scope="+ws+"&types=notes,tasks")
	if len(r.types) != 2 || !r.notesAllowed(false) || r.notesAllowed(true) {
		t.Fatalf("explicit notes: %+v", r.types)
	}
	r, _ = parse(t, "q=x&scope="+ws+"&type=files&sort=new&limit=7")
	if !r.feed || r.limit != 7 || r.types[0] != v1.SearchType_SEARCH_TYPE_FILES || r.relevance(v1.SearchType_SEARCH_TYPE_FILES) {
		t.Fatalf("feed: %+v", r)
	}
	r, _ = parse(t, "q=x&scope="+ws+"&type=messages")
	if r.limit != FeedLimit || !r.relevance(v1.SearchType_SEARCH_TYPE_MESSAGES) {
		t.Fatalf("feed default: %+v", r)
	}
	r, _ = parse(t, "q=x&scope="+ws)
	if r.relevance(v1.SearchType_SEARCH_TYPE_MESSAGES) || !r.relevance(v1.SearchType_SEARCH_TYPE_TASKS) {
		t.Fatal("summary order: messages by recency, tasks by relevance")
	}

	for qs, want := range map[string]int{
		"scope=all":          422,
		"q=&scope=all":       422,
		"q=%20%20&scope=all": 422,
		"q=!!!&scope=all":    422,
		"q=-a&scope=all":     422,
		"q=" + strings.Repeat("a", 201) + "&scope=all": 422,
		"q=x":                                400,
		"q=x&scope=nope":                     400,
		"q=x&scope=all&type=chats":           400,
		"q=x&scope=all&types=messages,chats": 400,
		"q=x&scope=all&limit=0":              400,
		"q=x&scope=all&limit=21":             400,
		"q=x&scope=all&sort=old":             400,
		"q=x&scope=all&cursor=abc":           400, // cursor without type
		"q=x&scope=all&type=tasks&cursor=!":  400,
	} {
		if _, err := parse(t, qs); status(err) != want {
			t.Errorf("%s: %v, want %d", qs, err, want)
		}
	}
}

func TestCursor(t *testing.T) {
	ws := uuid.New().String()
	base := "q=" + url.QueryEscape("релиз") + "&scope=" + ws + "&type=tasks"
	r, err := parse(t, base)
	if err != nil {
		t.Fatal(err)
	}
	id := uuid.New()
	c := r.encodeCursor(v1.SearchType_SEARCH_TYPE_TASKS, 0.123456789012345, id)
	r2, err := parse(t, base+"&cursor="+c)
	if err != nil {
		t.Fatal(err)
	}
	if r2.cur.R != 0.123456789012345 || r2.cur.id() != id || !r2.now.Equal(r.now) {
		t.Fatalf("round trip: %+v", r2.cur)
	}
	// Bound to q, scope, type and sort.
	for _, qs := range []string{
		"q=other&scope=" + ws + "&type=tasks",
		"q=" + url.QueryEscape("релиз") + "&scope=all&type=tasks",
		"q=" + url.QueryEscape("релиз") + "&scope=" + ws + "&type=events",
		base + "&sort=new",
	} {
		if _, err := parse(t, qs+"&cursor="+c); status(err) != 400 {
			t.Errorf("%s: %v", qs, err)
		}
	}
	// The freshness reference stays near now: a forged or stale one is refused.
	for _, d := range []time.Duration{time.Hour, -8 * 24 * time.Hour, 1e6 * time.Hour} {
		f := *r
		f.now = r.now.Add(d)
		if _, err := parse(t, base+"&cursor="+f.encodeCursor(v1.SearchType_SEARCH_TYPE_TASKS, 0.1, id)); status(err) != 400 {
			t.Errorf("reference %v: %v", d, err)
		}
	}
	// Tampered or forged cursors.
	for _, bad := range []string{
		base64.RawURLEncoding.EncodeToString([]byte(`{"t":3,"s":1,"h":1,"n":1,"r":0,"i":"x"}`)),
		base64.RawURLEncoding.EncodeToString([]byte(`not json`)),
		strings.Repeat("A", 600),
		c[:len(c)-3],
	} {
		if _, err := parse(t, base+"&cursor="+bad); status(err) != 400 {
			t.Errorf("%q accepted: %v", bad, err)
		}
	}
}

func TestMarkWords(t *testing.T) {
	cases := map[string]string{
		"Отчёт за квартал.pdf": "\u0002Отчёт\u0003 за квартал.pdf",
		"report-report.txt":    "\u0002report\u0003-\u0002report\u0003.txt",
		"a\u0002b.txt":         "ab.txt",
	}
	words := []string{"отчёт", "report"}
	for in, want := range cases {
		if got := markWords(in, words); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}
