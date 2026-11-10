//go:build integration

package app_test

import (
	"net/url"
	"slices"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestSearchFoldsYo (CBF-169): «е» and «ё» are one letter in the task search — the same tasks in
// the same order for either spelling of the query, by title (whole word, prefix, quoted phrase),
// description and comment, on the board search and GET /api/search alike, for a person and a
// bot; snippets mark the text as it is written; file names fold too. Stored text keeps its ё.
func TestSearchFoldsYo(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Ёлки", Key: "YO"}, 201)
	bt := createBot(t, o, wid, "yobot")

	title := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Позвонить Фёдоров Иван"}, 201)
	plain := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Федоров приедет в пятницу"}, 201)
	desc := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Квартальный отчёт", Description: "Отправить Федорова письмо"}, 201)
	descYo := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Сверка", Description: "Письмо от Фёдорова пришло"}, 201)
	talk := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "Созвон"}, 201)
	send(t, o, talk.GetRoomId(), "обсудить с Фёдоровым сроки", uniq("yo"))
	if title.GetTitle() != "Позвонить Фёдоров Иван" {
		t.Fatalf("stored title changed: %q", title.GetTitle())
	}

	tasks := func(c musty, q string) *v1.SearchTasksResponse {
		t.Helper()
		var sr v1.SearchTasksResponse
		c.must(200, "GET", "/api/workspaces/"+wid+"/tasks/search?q="+url.QueryEscape(q), nil, &sr)
		return &sr
	}
	order := func(sr *v1.SearchTasksResponse) []string {
		out := []string{}
		for _, x := range sr.GetTasks() {
			out = append(out, x.GetId())
		}
		return out
	}
	// same: every spelling gives the same ordered list, for bob and for the bot; it holds want
	// and none of not.
	same := func(name string, want, not []string, qs ...string) {
		t.Helper()
		first := order(tasks(bob, qs[0]))
		for _, q := range qs {
			for _, c := range []musty{bob, bt} {
				if got := order(tasks(c, q)); !slices.Equal(got, first) {
					t.Fatalf("%s: %q gives %v, %q gives %v", name, qs[0], first, q, got)
				}
			}
		}
		for _, id := range want {
			if !slices.Contains(first, id) {
				t.Fatalf("%s: %v misses %s", name, first, id)
			}
		}
		for _, id := range not {
			if slices.Contains(first, id) {
				t.Fatalf("%s: %v holds %s", name, first, id)
			}
		}
	}
	same("word (a prefix while typing)", []string{title.GetId(), plain.GetId(), desc.GetId(), descYo.GetId()}, nil, "федоров", "фёдоров", "ФЁДОРОВ", "Федоров")
	same("prefix", []string{title.GetId(), plain.GetId(), desc.GetId(), descYo.GetId()}, nil, "федоро", "фёдоро")
	same("description", []string{desc.GetId(), descYo.GetId()}, nil, "федорова", "фёдорова")
	same("phrase", []string{title.GetId()}, []string{plain.GetId(), desc.GetId(), descYo.GetId(), talk.GetId()}, `"позвонить федоров"`, `"позвонить фёдоров"`)
	same("comment", []string{talk.GetId()}, nil, "федоровым", "фёдоровым")
	same("stored ё in a title word", []string{desc.GetId()}, []string{title.GetId(), plain.GetId()}, "квартальный отчет", "квартальный отчёт")
	// Ranking: a title match first, whichever spelling the title or the query has.
	for _, q := range []string{"федоров", "фёдоров"} {
		if got := order(tasks(bob, q)); len(got) < 2 || !slices.Contains(got[:2], title.GetId()) || !slices.Contains(got[:2], plain.GetId()) {
			t.Fatalf("%q ranks %v", q, got)
		}
	}

	// Snippets mark the description as written, whichever spelling was typed.
	for _, q := range []string{"федорова", "фёдорова"} {
		snip := map[string]string{}
		for _, s := range tasks(bob, q).GetSnippets() {
			snip[s.GetTaskId()] = s.GetText()
		}
		if !strings.Contains(snip[desc.GetId()], "\u0002Федорова\u0003") || !strings.Contains(snip[descYo.GetId()], "\u0002Фёдорова\u0003") {
			t.Fatalf("%q snippets: %q", q, snip)
		}
	}

	// GET /api/search: the tasks section, same list and order both ways; the title highlighted.
	scope := "&scope=" + wid + "&type=tasks"
	var lists [][]string
	for _, q := range []string{"федоров", "фёдоров"} {
		r := doSearch(t, bob, "q="+url.QueryEscape(q)+scope)
		var ids []string
		for _, h := range section(t, r, stTasks).GetItems() {
			ids = append(ids, hitID(h))
			if hitID(h) == title.GetId() && h.GetSnippet() != "Позвонить \u0002Фёдоров\u0003 Иван" {
				t.Fatalf("%q: title snippet %q", q, h.GetSnippet())
			}
		}
		lists = append(lists, ids)
	}
	if len(lists[0]) != 4 || !slices.Equal(lists[0], lists[1]) { // title, plain and, by prefix, both descriptions
		t.Fatalf("/api/search tasks: %v vs %v", lists[0], lists[1])
	}

	// The board's «Текст» condition folds too.
	got := listTasks(t, bob, b.GetId(), &v1.TaskFilter{Conditions: []*v1.TaskCondition{{Field: v1.TaskField_TASK_FIELD_TEXT, Op: v1.TaskOp_TASK_OP_CONTAINS, Values: []string{"фёдоров"}}}})
	var keys []string
	for _, x := range got {
		keys = append(keys, x.GetId())
	}
	slices.Sort(keys)
	want := []string{title.GetId(), plain.GetId()}
	slices.Sort(want)
	if !slices.Equal(keys, want) {
		t.Fatalf("text filter: %v, want %v", keys, want)
	}

	// File names: «отчет» finds «Отчёт_…», marked as written.
	room := textRoom(t, o, wid, "файлы", false)
	_, f, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "Отчёт_Фёдорова.txt", []byte("x"))
	o.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{f.GetId()}, Nonce: uniq("f")}, nil)
	for _, q := range []string{"отчет федорова", "отчёт фёдорова"} {
		fh := hits(t, bob, "q="+url.QueryEscape(q)+"&scope="+wid, stFiles)
		wantHits(t, "file "+q, fh, f.GetId())
		if s := fh[f.GetId()].GetSnippet(); s != "\u0002Отчёт\u0003_\u0002Фёдорова\u0003.txt" {
			t.Fatalf("file snippet %q", s)
		}
	}
}
