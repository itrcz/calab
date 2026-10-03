//go:build integration

package app_test

import (
	"context"
	"crypto/rand"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Unified search (ADR-0062): run with -run 'TestSearch'.

// tag is a fresh word (latin letters only: one lexeme in both configs) that no other test uses.
func tag() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = 'a' + b[i]%26
	}
	return "zq" + string(b)
}

func doSearch(t *testing.T, u musty, qs string) *v1.SearchResponse {
	t.Helper()
	var r v1.SearchResponse
	u.must(200, "GET", "/api/search?"+qs, nil, &r)
	return &r
}

func q(s string) string { return "q=" + url.QueryEscape(s) }

func section(t *testing.T, r *v1.SearchResponse, typ v1.SearchType) *v1.SearchSection {
	t.Helper()
	for _, s := range r.GetSections() {
		if s.GetType() == typ {
			return s
		}
	}
	t.Fatalf("no section %v in %v", typ, r)
	return nil
}

// hitID is the id of the object a hit points to.
func hitID(h *v1.SearchHit) string {
	switch {
	case h.GetMessage() != nil:
		return h.GetMessage().GetMessageId()
	case h.GetNote() != nil:
		return h.GetNote().GetMessageId()
	case h.GetTaskComment() != nil:
		return h.GetTaskComment().GetMessageId()
	case h.GetTask() != nil:
		return h.GetTask().GetTaskId()
	case h.GetEvent() != nil:
		return h.GetEvent().GetEventId()
	case h.GetFile() != nil:
		return h.GetFile().GetFileId()
	case h.GetTranscript() != nil:
		return h.GetTranscript().GetRecordingId()
	}
	return ""
}

func hits(t *testing.T, u musty, qs string, typ v1.SearchType) map[string]*v1.SearchHit {
	t.Helper()
	out := map[string]*v1.SearchHit{}
	for _, h := range section(t, doSearch(t, u, qs), typ).GetItems() {
		out[hitID(h)] = h
	}
	return out
}

func wantHits(t *testing.T, what string, got map[string]*v1.SearchHit, want ...string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d hits, want %d (%v)", what, len(got), len(want), got)
	}
	for _, id := range want {
		if got[id] == nil {
			t.Fatalf("%s: %s missing in %v", what, id, got)
		}
	}
}

const (
	stMessages     = v1.SearchType_SEARCH_TYPE_MESSAGES
	stTaskComments = v1.SearchType_SEARCH_TYPE_TASK_COMMENTS
	stTasks        = v1.SearchType_SEARCH_TYPE_TASKS
	stEvents       = v1.SearchType_SEARCH_TYPE_EVENTS
	stFiles        = v1.SearchType_SEARCH_TYPE_FILES
	stNotes        = v1.SearchType_SEARCH_TYPE_NOTES
	stTranscripts  = v1.SearchType_SEARCH_TYPE_TRANSCRIPTS
)

// TestSearchMessagesAndFiles: rooms by VIEW_ROOM, private rooms, DMs (own only, scope=all only,
// after «Удалить чат»), files through visible live messages, notes only for their owner,
// prefix, highlight, validation.
func TestSearchMessagesAndFiles(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	pub := textRoom(t, o, wid, "общий", false)
	priv := textRoom(t, o, wid, "секрет", true)
	w := tag()

	m1 := send(t, o, pub, "Готовим релиз "+w+" к пятнице", "")
	mPriv := send(t, o, priv, "секретный релиз "+w, "")
	scope := "&scope=" + wid

	// Prefix «рел» → «релиз», highlight markers, the private room only for its viewer.
	got := hits(t, bob, q(w+" рел")+scope, stMessages)
	wantHits(t, "bob prefix", got, m1.GetId())
	h := got[m1.GetId()]
	if h.GetMessage().GetRoomId() != pub || h.GetWorkspaceId() != wid || h.GetAuthorId() != o.id ||
		h.GetSnippet() != "Готовим \u0002релиз\u0003 \u0002"+w+"\u0003 к пятнице" {
		t.Fatalf("hit %v", h)
	}
	wantHits(t, "owner", hits(t, o, q(w)+scope, stMessages), m1.GetId(), mPriv.GetId())
	// Exclusion and phrases.
	wantHits(t, "exclude", hits(t, o, q(w+" -секретный")+scope, stMessages), m1.GetId())
	wantHits(t, "phrase", hits(t, o, q(`"секретный релиз" `+w)+scope, stMessages), mPriv.GetId())

	// The old endpoints run the same matching (prefix too).
	var old v1.ListMessagesResponse
	bob.must(200, "GET", "/api/workspaces/"+wid+"/messages/search?"+q(w+" рел"), nil, &old)
	if len(old.GetMessages()) != 1 || old.GetMessages()[0].GetId() != m1.GetId() {
		t.Fatalf("old search %v", old.GetMessages())
	}
	bob.must(200, "GET", "/api/workspaces/"+wid+"/messages/search?q=!!!", nil, &old)
	if len(old.GetMessages()) != 0 {
		t.Fatal("punctuation-only query on the old endpoint")
	}

	// DMs: only with scope=all, only the participants; «Удалить чат» hides older ones.
	dm := openDM(t, bob, carol.id, 201).GetRoom().GetId()
	mDM := send(t, bob, dm, "личный "+w, "")
	wantHits(t, "dm scope=ws", hits(t, bob, q(w)+scope, stMessages), m1.GetId())
	wantHits(t, "dm scope=all bob", hits(t, bob, q(w)+"&scope=all", stMessages), m1.GetId(), mDM.GetId())
	wantHits(t, "dm scope=all carol", hits(t, carol, q(w)+"&scope=all", stMessages), m1.GetId(), mDM.GetId())
	wantHits(t, "dm scope=all owner", hits(t, o, q(w)+"&scope=all", stMessages), m1.GetId(), mPriv.GetId())
	if h := hits(t, bob, q(w)+"&scope=all", stMessages)[mDM.GetId()]; h.GetWorkspaceId() != "" || h.GetMessage().GetRoomId() != dm {
		t.Fatalf("dm hit %v", h)
	}
	carol.must(200, "PATCH", "/api/dms/"+dm+"/state", &v1.UpdateDmStateRequest{Cleared: true}, nil)
	wantHits(t, "cleared dm", hits(t, carol, q(w)+"&scope=all", stMessages), m1.GetId())
	wantHits(t, "cleared only for carol", hits(t, bob, q(w)+"&scope=all", stMessages), m1.GetId(), mDM.GetId())

	// Files: by name (typo, substring), through a visible live message only.
	fname := "Квартальный_отчёт_" + w + ".txt"
	_, fPub, _ := upload(t, o, "/api/workspaces/"+wid+"/files", fname, []byte("x"))
	var withFile v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+pub+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{fPub.GetId()}, Nonce: uniq("f")}, &withFile)
	_, fPriv, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "тайный_"+w+".txt", []byte("y"))
	o.must(201, "POST", "/api/rooms/"+priv+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{fPriv.GetId()}, Nonce: uniq("f")}, nil)
	f := hits(t, bob, q(w)+scope, stFiles)
	wantHits(t, "bob files", f, fPub.GetId())
	if h := f[fPub.GetId()]; h.GetFile().GetMessageId() != withFile.GetMessage().GetId() || h.GetFile().GetRoomId() != pub ||
		h.GetTitle() != fname || h.GetSnippet() != "Квартальный_отчёт_\u0002"+w+"\u0003.txt" {
		t.Fatalf("file hit %v", h)
	}
	wantHits(t, "owner files", hits(t, o, q(w)+scope, stFiles), fPub.GetId(), fPriv.GetId())
	wantHits(t, "file typo", hits(t, bob, q("Квартальнй "+w)+scope, stFiles), fPub.GetId())
	o.must(204, "DELETE", "/api/messages/"+withFile.GetMessage().GetId(), nil, nil)
	wantHits(t, "deleted message's file", hits(t, bob, q(w)+scope, stFiles))

	// Notes: own shelves, with scope=all or types=notes; never another user's.
	shelf := createShelf(t, bob, "Идеи", "", 201).GetRoom().GetId()
	mNote := send(t, bob, shelf, "заметка "+w, "")
	if len(hits(t, bob, q(w)+scope, stNotes)) != 0 {
		t.Fatal("notes in a workspace summary")
	}
	wantHits(t, "notes all", hits(t, bob, q(w)+"&scope=all", stNotes), mNote.GetId())
	wantHits(t, "notes explicit", hits(t, bob, q(w)+scope+"&types=notes", stNotes), mNote.GetId())
	wantHits(t, "notes of bob for carol", hits(t, carol, q(w)+"&scope=all&type=notes", stNotes))
	wantHits(t, "notes of bob for owner", hits(t, o, q(w)+"&scope=all", stNotes))
	if _, ok := hits(t, bob, q(w)+"&scope=all", stMessages)[mNote.GetId()]; ok {
		t.Fatal("a note among messages")
	}

	// Guests: exactly the rooms their roles show (the room list is the reference).
	gus := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	seen := visibleRooms(t, gus, wid)
	var want []string
	if seen[pub] != nil {
		want = append(want, m1.GetId())
	}
	if seen[priv] != nil {
		t.Fatal("guest sees the private room")
	}
	wantHits(t, "guest", hits(t, gus, q(w)+scope, stMessages), want...)

	// Validation and membership.
	bob.must(422, "GET", "/api/search?q=!!!&scope=all", nil, nil)
	bob.must(422, "GET", "/api/search?q=&scope=all", nil, nil)
	bob.must(400, "GET", "/api/search?q=x", nil, nil)
	bob.must(400, "GET", "/api/search?q=x&scope=all&type=nope", nil, nil)
	stranger := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	stranger.must(404, "GET", "/api/search?q=x&scope="+wid, nil, nil)
	if r := doSearch(t, bob, q(w)+scope); len(r.GetSections()) != 7 {
		t.Fatalf("sections %v", r.GetSections())
	}
}

// TestSearchTasks: boards by VIEW_BOARD, private boards, task-scoped access (ADR-0059: the
// invitee sees only their task and its comments), restricted boards, key, typo, prefix.
func TestSearchTasks(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	w := tag()
	scope := "&scope=" + wid
	open := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Открытая", Key: "OPN"}, 201)
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Закрытая", Key: "PRV", IsPrivate: true}, 201)
	tOpen := createTask(t, o, open.GetId(), &v1.CreateTaskRequest{Title: "Подготовить презентацию " + w}, 201)
	tMine := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "Карточка Боба " + w, Description: "описание релиза"}, 201)
	tOther := createTask(t, o, priv.GetId(), &v1.CreateTaskRequest{Title: "Чужая карточка " + w}, 201)
	cOpen := send(t, o, tOpen.GetRoomId(), "комментарий "+w, "")
	cMine := send(t, o, tMine.GetRoomId(), "комментарий "+w, "")
	cOther := send(t, o, tOther.GetRoomId(), "комментарий "+w, "")

	wantHits(t, "bob tasks", hits(t, bob, q(w)+scope, stTasks), tOpen.GetId())
	wantHits(t, "bob comments", hits(t, bob, q(w)+scope, stTaskComments), cOpen.GetId())
	wantHits(t, "owner tasks", hits(t, o, q(w)+scope, stTasks), tOpen.GetId(), tMine.GetId(), tOther.GetId())
	if _, ok := hits(t, o, q(w)+scope, stMessages)[cOpen.GetId()]; ok {
		t.Fatal("a task comment among messages")
	}

	// Task-scoped: assigned to one task of the private board.
	o.must(200, "PUT", "/api/tasks/"+tMine.GetId()+"/assignees", &v1.SetAssigneesRequest{Assignees: []*v1.TaskAssigneeInput{{UserId: bob.id}}}, nil)
	wantHits(t, "scoped tasks", hits(t, bob, q(w)+scope, stTasks), tOpen.GetId(), tMine.GetId())
	c := hits(t, bob, q(w)+scope, stTaskComments)
	wantHits(t, "scoped comments", c, cOpen.GetId(), cMine.GetId())
	if tc := c[cMine.GetId()].GetTaskComment(); tc.GetTaskKey() != "PRV-1" || tc.GetTaskId() != tMine.GetId() || tc.GetRoomId() != tMine.GetRoomId() {
		t.Fatalf("comment ref %v", tc)
	}
	_ = cOther
	// Description words, key, typo in the title, prefix.
	wantHits(t, "description", hits(t, bob, q("описание релиз")+scope, stTasks), tMine.GetId())
	k := hits(t, bob, q("PRV-1")+scope, stTasks)
	if h := k[tMine.GetId()]; h == nil || !h.GetTask().GetKeyMatch() || h.GetTask().GetKey() != "PRV-1" {
		t.Fatalf("key search %v", k)
	}
	if r := section(t, doSearch(t, bob, q("PRV-1")+scope), stTasks); len(r.GetItems()) == 0 || r.GetItems()[0].GetTask().GetTaskId() != tMine.GetId() {
		t.Fatalf("key match not first: %v", r.GetItems())
	}
	bob.must(200, "GET", "/api/search?"+q("PRV-2")+scope, nil, nil)
	if len(hits(t, bob, q("PRV-2")+scope, stTasks)) != 0 {
		t.Fatal("key of an invisible task")
	}
	wantHits(t, "title typo", hits(t, bob, q("презинтацию")+scope, stTasks), tOpen.GetId())
	wantHits(t, "title prefix", hits(t, bob, q("презент")+scope, stTasks), tOpen.GetId())

	// Restricted: the scoped access ends.
	restricted := true
	o.must(200, "PATCH", "/api/boards/"+priv.GetId(), &v1.UpdateBoardRequest{Restricted: &restricted}, nil)
	wantHits(t, "restricted tasks", hits(t, bob, q(w)+scope, stTasks), tOpen.GetId())
	wantHits(t, "restricted comments", hits(t, bob, q(w)+scope, stTaskComments), cOpen.GetId())

	// Guests: no boards.
	gus := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	r := doSearch(t, gus, q(w)+scope)
	if len(section(t, r, stTasks).GetItems())+len(section(t, r, stTaskComments).GetItems())+len(section(t, r, stEvents).GetItems()) != 0 {
		t.Fatalf("guest sees tasks / events: %v", r)
	}
}

// TestSearchEvents: only events the calendar shows with details — never someone else's
// meeting the caller would see as busy time, by title or by description.
func TestSearchEvents(t *testing.T) {
	c := calSetup(t)
	wid := c.ws.GetId()
	w := tag()
	scope := "&scope=" + wid
	dave := register(t, invite(t, c.o, wid))
	start := time.Now().Add(72 * time.Hour).Truncate(time.Minute)
	ev := func(u *user, title, desc, room string, att ...string) *v1.CalendarEvent {
		r := &v1.CreateCalendarEventRequest{Title: title, Description: desc, StartsAt: ts(start), EndsAt: ts(start.Add(time.Hour)), Tz: "Europe/Moscow", RoomId: room}
		for _, a := range att {
			r.Attendees = append(r.Attendees, &v1.CalendarEventAttendeeInput{UserId: a, Required: true})
		}
		return createEvent(t, u, wid, r)
	}
	inRoom := ev(c.o, "Созвон "+w, "", c.voice.GetId())
	busyOnly := ev(c.carol, "Секретная встреча "+w, "обсуждаем "+w+" бюджет", "", dave.id)
	mine := ev(c.carol, "Личная встреча", "повестка "+w, "", c.bob.id)

	wantHits(t, "bob events", hits(t, c.bob, q(w)+scope, stEvents), inRoom.GetId(), mine.GetId())
	wantHits(t, "busy-only by title", hits(t, c.bob, q("Секретная "+w)+scope, stEvents))
	wantHits(t, "busy-only by description", hits(t, c.bob, q("бюджет")+scope, stEvents))
	wantHits(t, "dave", hits(t, c.carol, q("бюджет")+scope, stEvents), busyOnly.GetId())
	wantHits(t, "dave attendee", hits(t, dave, q("бюджет")+scope, stEvents), busyOnly.GetId())
	h := hits(t, c.bob, q(w)+scope, stEvents)[inRoom.GetId()]
	if h.GetTitle() != "Созвон "+w || h.GetEvent().GetRoomId() != c.voice.GetId() || !h.GetEvent().GetOccurrenceStart().AsTime().Equal(start) || h.GetAuthorId() != c.o.id {
		t.Fatalf("event hit %v", h)
	}
	wantHits(t, "title typo", hits(t, c.bob, q("Созвн")+scope, stEvents), inRoom.GetId())
	// Guests have no calendar.
	wantHits(t, "guest", hits(t, c.gus, q(w)+scope, stEvents))
	// A repeating meeting: one hit, the next occurrence.
	series := createEvent(t, c.o, wid, &v1.CreateCalendarEventRequest{Title: "Еженедельная " + w, StartsAt: ts(start.Add(-14 * 24 * time.Hour)),
		EndsAt: ts(start.Add(-14*24*time.Hour + time.Hour)), Tz: "UTC", RoomId: c.voice.GetId(), Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY})
	sh := hits(t, c.bob, q("Еженедельная "+w)+scope, stEvents)[series.GetId()]
	if sh == nil || !sh.GetEvent().GetRecurring() || sh.GetEvent().GetOccurrenceStart().AsTime().Before(time.Now()) {
		t.Fatalf("series hit %v", sh)
	}
	// Cancelled: gone.
	c.o.must(204, "DELETE", "/api/events/"+inRoom.GetId(), nil, nil)
	wantHits(t, "cancelled", hits(t, c.bob, q("Созвон "+w)+scope, stEvents))
}

// TestSearchTranscripts: the recording card rule (own room or a live forwarded copy), the
// backfill of transcript_text, the offset of the matching segment.
func TestSearchTranscripts(t *testing.T) {
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()
	w := tag()
	ctx := context.Background()
	priv := textRoom(t, o, wid, "закрытая", true)
	pub := textRoom(t, o, wid, "общая", false)
	card := send(t, o, priv, "карточка записи", "")
	segs := `[{"speaker":0,"start":1.5,"end":3,"text":"Добрый день"},{"speaker":1,"start":12.25,"end":15,"text":"обсудим релиз ` + w + `"}]`
	var rid uuid.UUID
	// Stored as before 00064 (transcript_text NULL): the backfill fills it.
	if err := testDB.Pool.QueryRow(ctx, `INSERT INTO room_recordings (workspace_id, room_id, started_by, status, result_state, transcript_json, message_id)
		VALUES ($1, $2, $3, 'done', 'ready', $4::jsonb, $5) RETURNING id`, wid, priv, o.id, segs, card.GetId()).Scan(&rid); err != nil {
		t.Fatal(err)
	}
	_ = voice
	testApp.Recording.BackfillTranscripts(ctx)
	var text *string
	if err := testDB.Pool.QueryRow(ctx, "SELECT transcript_text FROM room_recordings WHERE id = $1", rid).Scan(&text); err != nil || text == nil ||
		*text != "Добрый день\nобсудим релиз "+w {
		t.Fatalf("backfill: %v %v", text, err)
	}
	scope := "&scope=" + wid
	got := hits(t, o, q("релиз "+w)+scope, stTranscripts)
	wantHits(t, "owner", got, rid.String())
	if tr := got[rid.String()].GetTranscript(); tr.GetOffsetMs() != 12250 || tr.GetRoomId() != priv ||
		got[rid.String()].GetSnippet() != "обсудим \u0002релиз\u0003 \u0002"+w+"\u0003" {
		t.Fatalf("transcript hit %v", got[rid.String()])
	}
	wantHits(t, "bob without the room", hits(t, bob, q(w)+scope, stTranscripts))
	// A live forwarded copy of the card in a room bob views: found there.
	var fwd uuid.UUID
	if err := testDB.Pool.QueryRow(ctx, "INSERT INTO messages (room_id, author_id, content, forwarded_from) VALUES ($1, $2, '', $3) RETURNING id",
		pub, o.id, card.GetId()).Scan(&fwd); err != nil {
		t.Fatal(err)
	}
	got = hits(t, bob, q(w)+scope, stTranscripts)
	wantHits(t, "forwarded", got, rid.String())
	if got[rid.String()].GetTranscript().GetRoomId() != pub {
		t.Fatalf("forwarded room %v", got[rid.String()])
	}
	// The same rule serves the transcript endpoint.
	bob.must(200, "GET", "/api/rooms/"+pub+"/recordings/"+rid.String()+"/transcript", nil, nil)
	bob.must(404, "GET", "/api/rooms/"+priv+"/recordings/"+rid.String()+"/transcript", nil, nil)
	o.must(204, "DELETE", "/api/messages/"+fwd.String(), nil, nil)
	wantHits(t, "copy deleted", hits(t, bob, q(w)+scope, stTranscripts))
	bob.must(404, "GET", "/api/rooms/"+pub+"/recordings/"+rid.String()+"/transcript", nil, nil)
	// A new result stores transcript_text at once (SetRecordingResult).
	if _, err := testDB.Pool.Exec(ctx, "UPDATE room_recordings SET deleted_at = now(), transcript_json = NULL, transcript_text = NULL WHERE id = $1", rid); err != nil {
		t.Fatal(err)
	}
	wantHits(t, "deleted", hits(t, o, q(w)+scope, stTranscripts))
}

// TestSearchScopeBotsAndPaging: scope=all across workspaces, bots (no notes), cursor paging in
// both orders, a section running out of time.
func TestSearchScopeBotsAndPaging(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(200, "POST", "/api/invites/"+invite(t, o, ws2.GetId())+"/join", nil, nil)
	w := tag()
	r1, r2 := textRoom(t, o, wid, "один", false), textRoom(t, o, ws2.GetId(), "два", false)
	a := send(t, o, r1, "раз "+w, "")
	b := send(t, o, r2, "два "+w, "")
	all := hits(t, bob, q(w)+"&scope=all", stMessages)
	wantHits(t, "scope=all", all, a.GetId(), b.GetId())
	if all[b.GetId()].GetWorkspaceId() != ws2.GetId() || all[a.GetId()].GetWorkspaceId() != wid {
		t.Fatal("workspace ids of scope=all hits")
	}
	wantHits(t, "scope=ws2", hits(t, bob, q(w)+"&scope="+ws2.GetId(), stMessages), b.GetId())

	// Bots: same rules, never notes.
	bt := createBot(t, o, wid, "finder")
	wantHits(t, "bot", hits(t, bt, q(w)+"&scope="+wid, stMessages), a.GetId())
	shelf := createShelf(t, o, "Боту не видно", "", 201).GetRoom().GetId()
	send(t, o, shelf, "заметка "+w, "")
	wantHits(t, "bot notes", hits(t, bt, q(w)+"&scope=all&type=notes", stNotes))

	// Paging: 5 matches, pages of 2, both orders, no duplicates, stable.
	ids := map[string]bool{a.GetId(): true}
	for i := range 4 {
		ids[send(t, o, r1, "страница "+w+" "+string(rune('a'+i)), "").GetId()] = true
	}
	for _, sort := range []string{"new", "relevance"} {
		seen := map[string]bool{}
		cur, pages := "", 0
		var first *v1.SearchSection
		for {
			qs := q(w) + "&scope=" + wid + "&type=messages&limit=2&sort=" + sort
			if cur != "" {
				qs += "&cursor=" + url.QueryEscape(cur)
			}
			s := section(t, doSearch(t, bob, qs), stMessages)
			if first == nil {
				first = s
			}
			for _, h := range s.GetItems() {
				if seen[hitID(h)] {
					t.Fatalf("%s: duplicate %s", sort, hitID(h))
				}
				seen[hitID(h)] = true
			}
			pages++
			if cur = s.GetNextCursor(); cur == "" || pages > 5 {
				break
			}
		}
		if len(seen) != len(ids) || pages != 3 || first.GetTotalEstimate() != 5 {
			t.Fatalf("%s: %d hits in %d pages, total %d", sort, len(seen), pages, first.GetTotalEstimate())
		}
	}
	// A cursor of another query: 400.
	s := section(t, doSearch(t, bob, q(w)+"&scope="+wid+"&type=messages&limit=2"), stMessages)
	bob.must(400, "GET", "/api/search?q=other&scope="+wid+"&type=messages&limit=2&cursor="+url.QueryEscape(s.GetNextCursor()), nil, nil)

	// A slow section comes back empty with timed_out; the others are complete.
	testApp.Search.Timeout = 300 * time.Millisecond
	testApp.Search.BeforeSection = func(ctx context.Context, tx pgx.Tx, typ v1.SearchType) error {
		if typ == stEvents {
			_, err := tx.Exec(ctx, "SELECT pg_sleep(2)")
			return err
		}
		return nil
	}
	defer func() { testApp.Search.Timeout, testApp.Search.BeforeSection = 0, nil }()
	r := doSearch(t, bob, q(w)+"&scope="+wid)
	if ev := section(t, r, stEvents); !ev.GetTimedOut() || len(ev.GetItems()) != 0 {
		t.Fatalf("events section %v", ev)
	}
	if m := section(t, r, stMessages); m.GetTimedOut() || len(m.GetItems()) != 4 {
		t.Fatalf("messages section %v", m)
	}
}
