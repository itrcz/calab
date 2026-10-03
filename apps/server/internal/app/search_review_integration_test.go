//go:build integration

package app_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Security review of ADR-0062: no section reveals that an invisible object matches — neither
// by items nor by total_estimate, in the summary and in both feed orders.

// searchCount is (items, total_estimate) of a section for every way of asking: the summary, the
// feed by relevance and the feed newest first.
func searchCount(t *testing.T, u musty, qs string, typ v1.SearchType) [3][2]int {
	t.Helper()
	var name string
	for _, n := range []struct {
		s string
		t v1.SearchType
	}{{"messages", stMessages}, {"task_comments", stTaskComments}, {"tasks", stTasks}, {"events", stEvents}, {"files", stFiles}, {"notes", stNotes}, {"transcripts", stTranscripts}} {
		if n.t == typ {
			name = n.s
		}
	}
	var out [3][2]int
	for i, extra := range []string{"", "&type=" + name + "&sort=relevance", "&type=" + name + "&sort=new"} {
		s := section(t, doSearch(t, u, qs+extra), typ)
		out[i] = [2]int{len(s.GetItems()), int(s.GetTotalEstimate())}
	}
	return out
}

// noSearchLimit lifts the per-user search budget for the rest of the test (the matrices below
// make many more searches than a person's burst).
func noSearchLimit(t *testing.T) {
	limit := testApp.Search.Limit
	testApp.Search.Limit = nil
	t.Cleanup(func() { testApp.Search.Limit = limit })
}

func wantCount(t *testing.T, what string, u musty, qs string, typ v1.SearchType, n int) {
	t.Helper()
	got := searchCount(t, u, qs, typ)
	for _, g := range got {
		if g[0] != n || g[1] != n {
			t.Fatalf("%s: (items, total) %v, want %d everywhere", what, got, n)
		}
	}
}

// TestSearchNoLeakByExistence: restricted and private rooms, deleted messages and their files,
// archived rooms and boards, a card of a task-scoped board the caller is not invited on (and
// its comments), busy-only events, someone else's notes, a recording the caller may not see, a
// workspace the caller left.
func TestSearchNoLeakByExistence(t *testing.T) {
	f := setupRestricted(t)
	noSearchLimit(t)
	w := tag()
	scope := "&scope=" + f.wid
	// Restricted room: the admin without an override does not see it — not even its count.
	secret := sendRetry(t, f.o, f.rid, "секретный "+w)
	_, file, _ := upload(t, f.o, "/api/workspaces/"+f.wid+"/files", "secret_"+w+".txt", []byte("x"))
	f.o.must(201, "POST", "/api/rooms/"+f.rid+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{file.GetId()}, Nonce: uniq("f")}, nil)
	allowed := map[string]bool{"owner": true, "adminUser": true, "adminRole": true, "memberUser": true}
	for _, n := range f.names {
		want := 0
		if allowed[n] {
			want = 1
		}
		wantCount(t, n+" restricted message", f.actors[n], q(w)+scope, stMessages, want)
		wantCount(t, n+" restricted message, scope=all", f.actors[n], q(w)+"&scope=all", stMessages, want)
		wantCount(t, n+" restricted file", f.actors[n], q(w)+scope, stFiles, want)
	}
	_ = secret

	// A deleted message: nobody, not even its author.
	pub := textRoom(t, f.o, f.wid, "общий", false)
	w2 := tag()
	gone := send(t, f.o, pub, "удалено "+w2, "")
	f.o.must(204, "DELETE", "/api/messages/"+gone.GetId(), nil, nil)
	wantCount(t, "deleted message", f.o, q(w2)+scope, stMessages, 0)

	// An archived room.
	ctx := context.Background()
	w3 := tag()
	arch := textRoom(t, f.o, f.wid, "архив", false)
	send(t, f.o, arch, "архивное "+w3, "")
	if _, err := testDB.Pool.Exec(ctx, "UPDATE rooms SET archived_at = now() WHERE id = $1", arch); err != nil {
		t.Fatal(err)
	}
	wantCount(t, "archived room", f.member, q(w3)+scope, stMessages, 0)

	// Task-scoped board: invited on one card, the other card and its comments stay unseen.
	w4 := tag()
	board := createBoard(t, f.o, f.wid, &v1.CreateBoardRequest{Name: "Закрытая", Key: "SRV", IsPrivate: true}, 201)
	mine := createTask(t, f.o, board.GetId(), &v1.CreateTaskRequest{Title: "Моя " + w4}, 201)
	other := createTask(t, f.o, board.GetId(), &v1.CreateTaskRequest{Title: "Чужая " + w4}, 201)
	send(t, f.o, mine.GetRoomId(), "коммент "+w4, "")
	send(t, f.o, other.GetRoomId(), "коммент "+w4, "")
	f.o.must(200, "PUT", "/api/tasks/"+mine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: f.member.id}}}, nil)
	wantCount(t, "scoped tasks", f.member, q(w4)+scope, stTasks, 1)
	wantCount(t, "scoped comments", f.member, q(w4)+scope, stTaskComments, 1)
	wantCount(t, "scoped key of the other card", f.member, q("SRV-2")+scope, stTasks, 0)
	wantCount(t, "guest tasks", f.guest, q(w4)+scope, stTasks, 0)
	// An archived board: gone for everyone.
	if _, err := testDB.Pool.Exec(ctx, "UPDATE boards SET archived_at = now() WHERE id = $1", board.GetId()); err != nil {
		t.Fatal(err)
	}
	wantCount(t, "archived board tasks", f.member, q(w4)+scope, stTasks, 0)
	wantCount(t, "archived board comments", f.member, q(w4)+scope, stTaskComments, 0)

	// Someone else's notes.
	w5 := tag()
	shelf := createShelf(t, f.member, "Мои", "", 201).GetRoom().GetId()
	send(t, f.member, shelf, "заметка "+w5, "")
	wantCount(t, "own notes", f.member, q(w5)+"&scope=all", stNotes, 1)
	wantCount(t, "foreign notes", f.o, q(w5)+"&scope=all", stNotes, 0)
	wantCount(t, "foreign notes as messages", f.o, q(w5)+"&scope=all", stMessages, 0)

	// A recording of the restricted room: its transcript is not even counted for the admin.
	w6 := tag()
	card := sendRetry(t, f.o, f.rid, "карточка")
	if _, err := testDB.Pool.Exec(ctx, `INSERT INTO room_recordings (workspace_id, room_id, started_by, status, result_state, transcript_json, transcript_text, message_id)
		VALUES ($1, $2, $3, 'done', 'ready', $4::jsonb, $5, $6)`, f.wid, f.rid, f.o.id, `[{"start":1,"text":"итоги `+w6+`"}]`, "итоги "+w6, card.GetId()); err != nil {
		t.Fatal(err)
	}
	for _, n := range f.names {
		want := 0
		if allowed[n] {
			want = 1
		}
		got := searchCount(t, f.actors[n], q(w6)+scope, stTranscripts)
		for _, g := range got {
			if g[0] != want || (g[1] != want && g[1] != 0) { // later pages carry no total
				t.Fatalf("%s transcripts %v, want %d", n, got, want)
			}
		}
		if got[0][1] != want {
			t.Fatalf("%s transcripts total %v, want %d", n, got, want)
		}
	}

	// A workspace the caller left: out of scope=all, 404 by id.
	ws2 := createWorkspace(t, f.o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	f.member.must(200, "POST", "/api/invites/"+invite(t, f.o, ws2.GetId())+"/join", nil, nil)
	w7 := tag()
	send(t, f.o, textRoom(t, f.o, ws2.GetId(), "второй", false), "второе "+w7, "")
	wantCount(t, "member of ws2", f.member, q(w7)+"&scope=all", stMessages, 1)
	if st := f.o.do("DELETE", "/api/workspaces/"+ws2.GetId()+"/members/"+f.member.id, nil, nil); st != 200 && st != 204 {
		t.Fatalf("remove member: %d", st)
	}
	wantCount(t, "left ws2", f.member, q(w7)+"&scope=all", stMessages, 0)
	f.member.must(404, "GET", "/api/search?"+q(w7)+"&scope="+ws2.GetId(), nil, nil)
}

// TestSearchEventsNoCount: a busy-only meeting and a meeting in a private room the caller is
// not in are not counted either (title, description, attendee).
func TestSearchEventsNoCount(t *testing.T) {
	c := calSetup(t)
	noSearchLimit(t)
	wid := c.ws.GetId()
	w := tag()
	start := time.Now().Add(48 * time.Hour).Truncate(time.Minute)
	var cr v1.CreateRoomResponse
	c.o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "закрытая", IsPrivate: true}, &cr)
	priv := cr.GetRoom().GetId()
	createEvent(t, c.carol, wid, &v1.CreateCalendarEventRequest{Title: "Тайная " + w, Description: "бюджет " + w, StartsAt: ts(start),
		EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", Attendees: []*v1.CalendarEventAttendeeInput{att(c.o.id, true)}})
	createEvent(t, c.o, wid, &v1.CreateCalendarEventRequest{Title: "Комнатная " + w, StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "UTC", RoomId: priv})
	wantCount(t, "bob", c.bob, q(w)+"&scope="+wid, stEvents, 0)
	wantCount(t, "bob scope=all", c.bob, q(w)+"&scope=all", stEvents, 0)
	wantCount(t, "owner", c.o, q(w)+"&scope="+wid, stEvents, 2)
	wantCount(t, "guest", c.gus, q(w)+"&scope="+wid, stEvents, 0)
}

// TestSearchInputSafety: crafted queries never break the tsquery (no 500), cursors cannot be
// forged into another type, scope or an out-of-range position, parameters are bounded, the
// per-transaction settings never stay on pooled connections, and the rate limit holds.
func TestSearchInputSafety(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	room := textRoom(t, o, wid, "общий", false)
	w := tag()
	for i := range 3 {
		send(t, o, room, fmt.Sprintf("сообщение %s %d", w, i), "")
	}
	crafted := []string{
		`'&|!():*\`, `a:*`, `a:* & b`, `"`, `""`, `-`, `--a`, `-"x y" ` + w, `OR`, `a OR`, `OR a`, `a OR OR b`, `!a`, `(a | b)`,
		`a <-> b`, `'''`, `\'`, `a'b`, `x:*:*`, `и в на`, `the a`, "a\x00b", "\x00", `שלום عربي`, "e\u0301", "\u0301", "\u200d\u200c",
		"😀 " + w, strings.Repeat("я", 200), strings.Repeat("a ", 100), strings.Repeat(`"a `, 66), strings.Repeat("-a ", 66) + "b",
		`ABC-1`, `ABC-99999999999`, `ABC-0`, `ZZ`, `zz%`, `_%\`, `%`, `a_b%c`, `ﬀ İ ß`, "\u202eabc", `$1`, `);DROP TABLE messages;--`,
	}
	limit := testApp.Search.Limit
	testApp.Search.Limit = nil // the requests below are many more than the burst
	defer func() { testApp.Search.Limit = limit }()
	caller := bob
	for i, s := range crafted {
		if i > 0 && i%6 == 0 { // the older endpoints keep their own per-user budgets
			caller = register(t, invite(t, o, wid))
		}
		for _, u := range []string{"/api/search?" + q(s) + "&scope=all", "/api/search?" + q(s) + "&scope=" + wid + "&type=files&sort=relevance",
			"/api/workspaces/" + wid + "/messages/search?" + q(s), "/api/workspaces/" + wid + "/tasks/search?" + q(s)} {
			if st := caller.do("GET", u, nil, nil); st != 200 && st != 422 && st != 400 {
				t.Fatalf("%q at %s: %d", s, u, st)
			}
		}
	}
	bob.must(422, "GET", "/api/search?q="+url.QueryEscape(strings.Repeat("я", 201))+"&scope=all", nil, nil)

	// Parameters.
	for _, p := range []string{"&limit=0", "&limit=21", "&limit=-1", "&limit=x", "&types=messages,nope", "&type=nope", "&sort=x",
		"&cursor=abc"} {
		bob.must(400, "GET", "/api/search?"+q(w)+"&scope="+wid+p, nil, nil)
	}

	// Cursors: valid, then forged.
	base := q(w) + "&scope=" + wid + "&type=messages&limit=1&sort=relevance"
	cur := section(t, doSearch(t, bob, base), stMessages).GetNextCursor()
	if cur == "" {
		t.Fatal("no cursor")
	}
	raw, err := base64.RawURLEncoding.DecodeString(cur)
	if err != nil {
		t.Fatal(err)
	}
	var c map[string]any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // the hash is a uint64: float64 would change it
	if err := dec.Decode(&c); err != nil {
		t.Fatal(err)
	}
	forge := func(k string, v any) string {
		m := map[string]any{}
		for kk, vv := range c {
			m[kk] = vv
		}
		m[k] = v
		b, _ := json.Marshal(m)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	bob.must(200, "GET", "/api/search?"+base+"&cursor="+url.QueryEscape(cur), nil, nil)
	for name, bad := range map[string]string{
		"garbage":    "!!!",
		"other type": forge("t", float64(v1.SearchType_SEARCH_TYPE_TASKS)),
		"other hash": forge("h", float64(1)),
		"negative":   forge("r", -1.0),
		"bad id":     forge("i", "x"),
		"far future": forge("n", float64(9e15)),
		"zero time":  forge("n", float64(0)),
		"long":       strings.Repeat("A", 600),
	} {
		if st := bob.do("GET", "/api/search?"+base+"&cursor="+url.QueryEscape(bad), nil, nil); st != 400 {
			t.Fatalf("cursor %s: %d", name, st)
		}
	}
	// The cursor of this workspace does not work for another scope or type.
	bob.must(400, "GET", "/api/search?"+q(w)+"&scope=all&type=messages&limit=1&sort=relevance&cursor="+url.QueryEscape(cur), nil, nil)
	bob.must(400, "GET", "/api/search?"+q(w)+"&scope="+wid+"&type=files&limit=1&sort=relevance&cursor="+url.QueryEscape(cur), nil, nil)
	bob.must(400, "GET", "/api/search?"+q(w)+"&scope="+wid+"&cursor="+url.QueryEscape(cur), nil, nil)

	// SET LOCAL only: no pooled connection keeps the search settings.
	ctx := context.Background()
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() { _ = bob.do("GET", "/api/search?"+q(w)+"&scope=all", nil, nil) })
	}
	wg.Wait()
	checkPool(ctx, t, testDB.Pool)

	// Rate limit per user: a burst of 30, then 429.
	testApp.Search.Limit = limit
	carol := register(t, invite(t, o, wid))
	n429 := 0
	for range 35 {
		if carol.do("GET", "/api/search?"+q(w)+"&scope="+wid+"&types=messages", nil, nil) == 429 {
			n429++
		}
	}
	if n429 == 0 {
		t.Fatal("no rate limit on /api/search")
	}
	// The limit is taken before any work: a foreign workspace costs the budget too (no free probing).
	if st := carol.do("GET", "/api/search?"+q(w)+"&scope="+uuid.NewString(), nil, nil); st != 429 {
		t.Fatalf("limited user, foreign scope: %d", st)
	}
}

func checkPool(ctx context.Context, t *testing.T, p *pgxpool.Pool) {
	t.Helper()
	n := int(p.Stat().TotalConns())
	conns := make([]*pgxpool.Conn, 0, n)
	defer func() {
		for _, c := range conns {
			c.Release()
		}
	}()
	for range n {
		c, err := p.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
		var st, seq, bitmap string
		var trgm *string
		if err := c.QueryRow(ctx, "SELECT current_setting('statement_timeout'), current_setting('enable_seqscan'), current_setting('enable_bitmapscan'), "+
			"current_setting('pg_trgm.word_similarity_threshold', true)").Scan(&st, &seq, &bitmap, &trgm); err != nil {
			t.Fatal(err)
		}
		if st != "0" || seq != "on" || bitmap != "on" || (trgm != nil && *trgm != "0.6" && *trgm != "") {
			t.Fatalf("pooled connection keeps search settings: %s %s %s %q", st, seq, bitmap, *trgm)
		}
	}
}
