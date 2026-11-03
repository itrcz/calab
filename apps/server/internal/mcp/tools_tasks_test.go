package mcp

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// taskFixture is a board DEV with two statuses and two labels, task DEV-7 on it and three
// members, one of them the caller (members/@me).
type taskFixture struct {
	ws, boardID, taskID, todo, review, bug, ui, me, ann, bob string
	board                                                    *v1.Board
	task                                                     *v1.Task
}

func newTaskFixture() *taskFixture {
	f := &taskFixture{ws: uuid.NewString(), boardID: uuid.NewString(), taskID: uuid.NewString(), todo: uuid.NewString(),
		review: uuid.NewString(), bug: uuid.NewString(), ui: uuid.NewString(), me: uuid.NewString(), ann: uuid.NewString(), bob: uuid.NewString()}
	f.board = &v1.Board{Id: f.boardID, Key: "DEV", Name: "Develop", WorkspaceId: f.ws,
		Statuses: []*v1.BoardStatus{{Id: f.todo, Name: "Todo"}, {Id: f.review, Name: "In Review"}},
		Labels:   []*v1.BoardLabel{{Id: f.bug, Name: "Bug"}, {Id: f.ui, Name: "UI"}}}
	f.task = &v1.Task{Id: f.taskID, Key: "DEV-7", BoardId: f.boardID, WorkspaceId: f.ws, StatusId: f.todo, RoomId: "room-7",
		LabelIds:  []string{f.bug},
		Assignees: []*v1.TaskAssignee{{UserId: f.ann, IsLead: true, Note: "backend"}},
		GitLinks: []*v1.TaskGitLink{
			{Kind: v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_PR, Provider: v1.GitProvider_GIT_PROVIDER_GITLAB, Repo: "gptunnel/gpt", Ref: "689", Title: "DEV-7 player", Url: "https://git/mr/689", State: v1.TaskGitLinkState_TASK_GIT_LINK_STATE_MERGED},
			{Kind: v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_BRANCH, Repo: "gptunnel/gpt", Ref: "DEV-7-player"},
			{Kind: v1.TaskGitLinkKind_TASK_GIT_LINK_KIND_COMMIT, Repo: "gptunnel/gpt", Ref: strings.Repeat("a", 40)},
		},
		Releases: []*v1.TaskRelease{{Name: "1290", Environment: "prod"}}}
	return f
}

func (f *taskFixture) member(id, name, nick string) *v1.WorkspaceMember {
	return &v1.WorkspaceMember{WorkspaceId: f.ws, User: &v1.User{Id: id, DisplayName: name}, Nickname: nick}
}

// api answers the routes the task tools call; extra handles the route under test.
func (f *taskFixture) api(t *testing.T, extra func(r *http.Request, body string) (int, proto.Message, bool)) *fakeAPI {
	fa := &fakeAPI{}
	fa.reply = func(r *http.Request) (int, proto.Message) {
		if st, m, ok := extra(r, fa.body[len(fa.body)-1]); ok {
			return st, m
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /api/t/DEV-7", "GET /api/tasks/" + f.taskID:
			return 200, &v1.TaskResponse{Task: proto.Clone(f.task).(*v1.Task), Board: f.board}
		case "GET /api/boards/" + f.boardID:
			return 200, &v1.BoardResponse{Board: f.board}
		case "GET /api/workspaces":
			return 200, &v1.ListWorkspacesResponse{Workspaces: []*v1.Workspace{{Id: f.ws}}}
		case "GET /api/workspaces/" + f.ws + "/boards":
			return 200, &v1.ListBoardsResponse{Boards: []*v1.Board{{Id: f.boardID, Key: "DEV"}}}
		case "GET /api/workspaces/" + f.ws + "/members/@me":
			return 200, &v1.GetMemberResponse{Member: f.member(f.me, "Тимофей Шмаков", "tim")}
		case "GET /api/workspaces/" + f.ws + "/members":
			return 200, &v1.ListMembersResponse{Members: []*v1.WorkspaceMember{
				f.member(f.me, "Тимофей Шмаков", "tim"), f.member(f.ann, "Анна Петрова", "ann"), f.member(f.bob, "Борис Петров", "bob")}}
		}
		t.Fatalf("unexpected %s %s", r.Method, r.URL)
		return 0, nil
	}
	return fa
}

func TestListTasks(t *testing.T) {
	f := newTaskFixture()
	var query map[string][]string
	fa := f.api(t, func(r *http.Request, _ string) (int, proto.Message, bool) {
		if r.URL.Path == "/api/workspaces/"+f.ws+"/tasks/search" {
			query = r.URL.Query()
			return 200, &v1.SearchTasksResponse{Tasks: []*v1.Task{f.task}, NextCursor: "c2"}, true
		}
		if r.URL.Path == "/api/me/tasks" {
			query = r.URL.Query()
			return 200, &v1.MyTasksResponse{Tasks: []*v1.Task{f.task}}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa

	text, isErr := call(t, h, "list_tasks", `{"board":"dev","status":"todo, In Review","assignee":"me","labels":["ui"]}`)
	if isErr || !strings.Contains(text, `"key":"DEV-7"`) || !strings.Contains(text, `"status":"Todo"`) ||
		!strings.Contains(text, `"labels":["Bug"]`) || !strings.Contains(text, `"next":"c2"`) {
		t.Fatalf("list_tasks: %v %s", isErr, text)
	}
	var filter v1.TaskFilter
	if err := unmarshal.Unmarshal([]byte(query["filter"][0]), &filter); err != nil {
		t.Fatalf("filter %q: %v", query["filter"], err)
	}
	want := map[v1.TaskField]string{
		v1.TaskField_TASK_FIELD_STATUS:   f.todo + "," + f.review,
		v1.TaskField_TASK_FIELD_ASSIGNEE: "me", // the server's own «me»: the person the bot acts for
		v1.TaskField_TASK_FIELD_LABEL:    f.ui,
	}
	for _, c := range filter.GetConditions() {
		if want[c.GetField()] != strings.Join(c.GetValues(), ",") || c.GetOp() != v1.TaskOp_TASK_OP_ANY_OF {
			t.Fatalf("condition %v", c)
		}
		delete(want, c.GetField())
	}
	if len(want) != 0 || query["board_id"][0] != f.boardID || query["state"][0] != "open" || query["limit"][0] != "20" || query["sort"] != nil {
		t.Fatalf("query %v, missing %v (no sort: the server's newest first)", query, want)
	}

	// A person by name.
	if _, isErr = call(t, h, "list_tasks", `{"board":"`+f.boardID+`","assignee":"Анна"}`); isErr {
		t.Fatal("assignee by name")
	}
	if err := unmarshal.Unmarshal([]byte(query["filter"][0]), &filter); err != nil || filter.GetConditions()[0].GetValues()[0] != f.ann {
		t.Fatalf("assignee filter %v", query["filter"])
	}

	// My open tasks everywhere.
	if text, isErr = call(t, h, "list_tasks", `{"mine":true}`); isErr || !strings.Contains(text, "DEV-7") ||
		query["scope"][0] != "assigned" || query["open"][0] != "1" {
		t.Fatalf("mine: %v %s %v", isErr, text, query)
	}
	if _, isErr = call(t, h, "list_tasks", `{"board":"DEV","sort":"-due"}`); isErr || query["sort"][0] != "-due" {
		t.Fatalf("sort given: %v", query)
	}

	for _, c := range []struct{ args, want string }{
		{`{}`, "give board, workspace or mine"},
		{`{"workspace":"` + f.ws + `","status":"Todo"}`, "status needs board"},
		{`{"board":"DEV","status":"Nope"}`, "Todo, In Review"},
		{`{"board":"DEV","labels":["Nope"]}`, "labels: Bug, UI"},
		{`{"board":"DEV","assignee":"Петров"}`, "several members match"},
		{`{"board":"DEV","state":"later"}`, "state must be"},
		{`{"board":"OPS"}`, `no board "OPS"`},
	} {
		if text, isErr := call(t, h, "list_tasks", c.args); !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s: %v %s", c.args, isErr, text)
		}
	}
}

func TestUpdateTask(t *testing.T) {
	f := newTaskFixture()
	var patch v1.UpdateTaskRequest
	var raw string
	fa := f.api(t, func(r *http.Request, body string) (int, proto.Message, bool) {
		if r.Method == http.MethodPatch && r.URL.Path == "/api/tasks/"+f.taskID {
			raw = body
			patch.Reset()
			if err := unmarshal.Unmarshal([]byte(body), &patch); err != nil {
				t.Fatalf("PATCH body %s: %v", body, err)
			}
			n := proto.Clone(f.task).(*v1.Task)
			n.LabelIds = patch.GetLabelIds()
			return 200, &v1.TaskResponse{Task: n}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa

	text, isErr := call(t, h, "update_task", `{"task":"DEV-7","priority":"High","due":"","add_labels":["UI"],"remove_labels":["bug"]}`)
	if isErr || !strings.Contains(text, `"labels":["UI"]`) || !strings.Contains(text, `"workspace":"`+f.ws+`"`) || !strings.Contains(text, `"board":"Develop (DEV)"`) {
		t.Fatalf("update_task (and where it landed): %v %s", isErr, text)
	}
	if patch.GetPriority() != v1.TaskPriority_TASK_PRIORITY_HIGH || patch.DueOn == nil || patch.GetDueOn() != "" ||
		!patch.GetSetLabels() || strings.Join(patch.GetLabelIds(), ",") != f.ui || patch.Title != nil || patch.StatusId != nil {
		t.Fatalf("PATCH %s", raw)
	}
	// An empty description clears it.
	if _, isErr = call(t, h, "update_task", `{"task":"DEV-7","description":""}`); isErr || patch.Description == nil || patch.GetDescription() != "" {
		t.Fatalf("clear description: %s", raw)
	}
	// Only given fields: a title alone sends no labels.
	if _, isErr = call(t, h, "update_task", `{"task":"DEV-7","title":"New"}`); isErr || patch.GetTitle() != "New" || patch.GetSetLabels() || patch.Priority != nil {
		t.Fatalf("title only: %s", raw)
	}
	for _, c := range []struct{ args, want string }{
		{`{"task":"DEV-7"}`, "nothing to change"},
		{`{"task":"DEV-7","priority":"p1"}`, "priority must be"},
		{`{"task":"DEV-7","labels":["Nope"]}`, "no label"},
		{`{"task":"DEV-7","estimate":-1}`, "estimate must be"},
	} {
		if text, isErr := call(t, h, "update_task", c.args); !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s: %v %s", c.args, isErr, text)
		}
	}
}

func TestAssign(t *testing.T) {
	f := newTaskFixture()
	var put v1.SetAssigneesRequest
	fa := f.api(t, func(r *http.Request, body string) (int, proto.Message, bool) {
		if r.Method == http.MethodPut && r.URL.Path == "/api/tasks/"+f.taskID+"/assignees" {
			put.Reset()
			if err := unmarshal.Unmarshal([]byte(body), &put); err != nil {
				t.Fatalf("PUT body %s: %v", body, err)
			}
			n := proto.Clone(f.task).(*v1.Task)
			n.Assignees = nil
			for _, a := range put.GetAssignees() {
				n.Assignees = append(n.Assignees, &v1.TaskAssignee{UserId: a.GetUserId(), IsLead: a.GetIsLead(), Note: a.GetNote()})
			}
			return 200, &v1.TaskResponse{Task: n}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa
	got := func() string {
		var parts []string
		for _, a := range put.GetAssignees() {
			p := a.GetUserId()
			if a.GetIsLead() {
				p += "*"
			}
			if a.GetNote() != "" {
				p += "(" + a.GetNote() + ")"
			}
			parts = append(parts, p)
		}
		return strings.Join(parts, ",")
	}

	// add me: Anna stays the lead with her note.
	if text, isErr := call(t, h, "assign", `{"task":"DEV-7","users":["me"]}`); isErr || got() != f.ann+"*(backend),"+f.me || !strings.Contains(text, `"workspace":"`+f.ws+`"`) {
		t.Fatalf("add me: %v %s %s", isErr, text, got())
	}
	// add by nickname and make them the lead.
	if _, isErr := call(t, h, "assign", `{"task":"DEV-7","users":["@bob"],"lead":"bob"}`); isErr || got() != f.ann+"(backend),"+f.bob+"*" {
		t.Fatalf("lead: %s", got())
	}
	// set replaces; the first becomes the lead.
	if _, isErr := call(t, h, "assign", `{"task":"DEV-7","users":["me","Борис Петров"],"mode":"set"}`); isErr || got() != f.me+"*,"+f.bob {
		t.Fatalf("set: %s", got())
	}
	// remove the only assignee: empty list, no lead.
	if _, isErr := call(t, h, "assign", `{"task":"DEV-7","users":["`+f.ann+`"],"mode":"remove"}`); isErr || got() != "" {
		t.Fatalf("remove: %s", got())
	}
	// Already assigned (Anna is the lead): no PUT, no journal entry.
	put.Reset()
	if text, isErr := call(t, h, "assign", `{"task":"DEV-7","users":["Анна"]}`); isErr || !strings.Contains(text, `"unchanged":true`) || len(put.GetAssignees()) != 0 {
		t.Fatalf("no-op: %v %s", isErr, text)
	}
	for _, c := range []struct{ args, want string }{
		{`{"task":"DEV-7"}`, "users is required"},
		{`{"task":"DEV-7","users":["me"],"mode":"swap"}`, "mode must be"},
		{`{"task":"DEV-7","users":["me"],"lead":"bob"}`, "lead must be one of"},
		{`{"task":"DEV-7","users":["nobody"]}`, `no member "nobody"`},
	} {
		if text, isErr := call(t, h, "assign", c.args); !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s: %v %s", c.args, isErr, text)
		}
	}
}

// read shows labels, the lead, Git links (commits only counted) and releases.
func TestReadTaskGit(t *testing.T) {
	f := newTaskFixture()
	h := New("test")
	h.API = f.api(t, func(*http.Request, string) (int, proto.Message, bool) { return 0, nil, false })
	text, isErr := call(t, h, "read", `{"task":"DEV-7"}`)
	var out map[string]any
	if isErr || json.Unmarshal([]byte(text), &out) != nil {
		t.Fatalf("read: %v %s", isErr, text)
	}
	git, _ := out["git"].(map[string]any)
	prs, _ := git["prs"].([]any)
	if out["lead"] != f.ann || out["labels"].([]any)[0] != "Bug" || len(prs) != 1 ||
		prs[0].(map[string]any)["ref"] != "gptunnel/gpt!689" || prs[0].(map[string]any)["state"] != "merged" ||
		git["commits"].(float64) != 1 || len(git["branches"].([]any)) != 1 ||
		out["releases"].([]any)[0].(map[string]any)["env"] != "prod" {
		t.Fatalf("read: %s", text)
	}
}

// mine cuts the API's 200-task page by the caller's limit and continues after the last task
// shown (the API's keyset cursor): nothing is lost, also when tasks close between pages.
func TestListTasksMinePaging(t *testing.T) {
	f := newTaskFixture()
	base := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	var open []*v1.Task // newest update first, as the API orders them
	for i := range 45 {
		open = append(open, &v1.Task{Id: uuid.NewString(), Key: "DEV-" + strconv.Itoa(100+i), BoardId: f.boardID, StatusId: f.todo,
			UpdatedAt: timestamppb.New(base.Add(-time.Duration(i) * time.Minute))})
	}
	fa := f.api(t, func(r *http.Request, _ string) (int, proto.Message, bool) {
		if r.URL.Path != "/api/me/tasks" {
			return 0, nil, false
		}
		page := open
		if c := r.URL.Query().Get("cursor"); c != "" {
			ts, id, _ := strings.Cut(c, "_")
			at, err := time.Parse(time.RFC3339Nano, ts)
			if err != nil {
				t.Fatalf("cursor %q", c)
			}
			page = slices.DeleteFunc(slices.Clone(open), func(x *v1.Task) bool {
				u := x.GetUpdatedAt().AsTime()
				return u.After(at) || (u.Equal(at) && x.GetId() >= id)
			})
		}
		return 200, &v1.MyTasksResponse{Tasks: page}, true
	})
	h := New("test")
	h.API = fa
	var keys []string
	cursor := ""
	for page := 0; page < 10; page++ {
		args := `{"mine":true,"limit":20}`
		if cursor != "" {
			args = `{"mine":true,"limit":20,"cursor":"` + cursor + `"}`
		}
		text, isErr := call(t, h, "list_tasks", args)
		var out struct {
			Tasks []struct{ Key string }
			Next  string
		}
		if isErr || json.Unmarshal([]byte(text), &out) != nil {
			t.Fatalf("mine page: %v %s", isErr, text)
		}
		for _, x := range out.Tasks {
			keys = append(keys, x.Key)
		}
		if page == 0 { // the agent closes 6 tasks of the first page before asking for the next
			open = open[6:]
		}
		if cursor = out.Next; cursor == "" {
			break
		}
	}
	if len(keys) != 45 || keys[0] != "DEV-100" || keys[44] != "DEV-144" {
		t.Fatalf("got %d tasks %v", len(keys), keys)
	}
}

// A task key in two workspaces is an error naming both, never the first match; with workspace
// the key is looked up there only.
func TestTaskKeyInTwoWorkspaces(t *testing.T) {
	f := newTaskFixture()
	ws2 := uuid.NewString()
	other := &v1.Task{Id: uuid.NewString(), Key: "DEV-7", Title: "чужая", BoardId: "b2", WorkspaceId: ws2, RoomId: "room-x"}
	var asked []string
	fa := f.api(t, func(r *http.Request, _ string) (int, proto.Message, bool) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/workspaces":
			return 200, &v1.ListWorkspacesResponse{Workspaces: []*v1.Workspace{{Id: f.ws}, {Id: ws2}, {Id: "nobot"}}}, true
		case "GET /api/t/DEV-7":
			w := r.URL.Query().Get("workspace_id")
			asked = append(asked, w)
			switch w {
			case ws2:
				return 200, &v1.TaskResponse{Task: other, Board: &v1.Board{Id: "b2"}}, true
			case "nobot":
				return 404, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_NOT_FOUND, Message: "not found"}, true
			}
		case "POST /api/rooms/room-7/messages", "POST /api/rooms/room-x/messages":
			t.Fatalf("commented on a guessed task: %s", r.URL.Path)
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa
	if text, isErr := call(t, h, "comment_task", `{"task":"dev-7","text":"x"}`); !isErr || !strings.Contains(text, "several workspaces") || !strings.Contains(text, ws2) {
		t.Fatalf("ambiguous key: %v %s", isErr, text)
	}
	asked = nil
	if text, isErr := call(t, h, "read", `{"task":"DEV-7","workspace":"`+f.ws+`"}`); isErr || !strings.Contains(text, f.taskID) || strings.Join(asked, ",") != f.ws {
		t.Fatalf("with workspace: %v %s %v", isErr, text, asked)
	}
}

// A key that spells a done task comes first; a board that cannot be read keeps the ids.
func TestListTasksKeyTaskAndUnreadableBoard(t *testing.T) {
	f := newTaskFixture()
	other := &v1.Task{Id: uuid.NewString(), Key: "OPS-1", BoardId: "hidden", StatusId: "s-1"}
	done := &v1.Task{Id: uuid.NewString(), Key: "DEV-12", BoardId: f.boardID, StatusId: f.review}
	fa := f.api(t, func(r *http.Request, _ string) (int, proto.Message, bool) {
		switch r.URL.Path {
		case "/api/workspaces/" + f.ws + "/tasks/search":
			return 200, &v1.SearchTasksResponse{Tasks: []*v1.Task{other}, KeyTask: done}, true
		case "/api/boards/hidden":
			return 429, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_RATE_LIMITED, Message: "slow down"}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa
	text, isErr := call(t, h, "list_tasks", `{"workspace":"`+f.ws+`","q":"DEV-12"}`)
	if isErr || strings.Index(text, "DEV-12") > strings.Index(text, "OPS-1") || !strings.Contains(text, `"status":"In Review"`) || !strings.Contains(text, `"status":"s-1"`) {
		t.Fatalf("key task / unreadable board: %v %s", isErr, text)
	}
}

// A board key in two workspaces is an error naming both, never the first match.
func TestBoardKeyInTwoWorkspaces(t *testing.T) {
	f := newTaskFixture()
	ws2, b2 := uuid.NewString(), uuid.NewString()
	fa := f.api(t, func(r *http.Request, _ string) (int, proto.Message, bool) {
		switch r.URL.Path {
		case "/api/workspaces":
			return 200, &v1.ListWorkspacesResponse{Workspaces: []*v1.Workspace{{Id: f.ws}, {Id: ws2}, {Id: "nobot"}}}, true
		case "/api/workspaces/" + ws2 + "/boards":
			return 200, &v1.ListBoardsResponse{Boards: []*v1.Board{{Id: b2, Key: "DEV", WorkspaceId: ws2}}}, true
		case "/api/workspaces/nobot/boards": // on behalf: a workspace of the person without the bot
			return 404, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_NOT_FOUND, Message: "not found"}, true
		case "/api/boards/" + f.boardID + "/tasks":
			t.Fatal("created on a guessed board")
		case "/api/boards/" + b2:
			return 200, &v1.BoardResponse{Board: &v1.Board{Id: b2, Key: "DEV", WorkspaceId: ws2}}, true
		case "/api/workspaces/" + ws2 + "/tasks/search":
			if r.URL.Query().Get("board_id") != b2 {
				t.Fatalf("searched board %s", r.URL.Query().Get("board_id"))
			}
			return 200, &v1.SearchTasksResponse{}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa
	if text, isErr := call(t, h, "create_task", `{"board":"DEV","title":"x"}`); !isErr || !strings.Contains(text, "several workspaces") || !strings.Contains(text, ws2) {
		t.Fatalf("ambiguous key: %v %s", isErr, text)
	}
	// With the workspace the key is that workspace's board.
	if text, isErr := call(t, h, "list_tasks", `{"board":"DEV","workspace":"`+ws2+`"}`); isErr || !strings.Contains(text, `"found":0`) {
		t.Fatalf("workspace given: %v %s", isErr, text)
	}
}
