package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Token economy: few general tools, one-line descriptions, compact answers (only non-empty
// fields, short names); the full API object only on request (read full=true).

// args is the union of the tools' arguments (JSON names as in the schemas).
type args struct {
	Q           string  `json:"q"`
	Kind        string  `json:"kind"`
	Workspace   string  `json:"workspace"`
	Task        string  `json:"task"`
	Room        string  `json:"room"`
	Board       string  `json:"board"`
	Title       string  `json:"title"`
	Description *string `json:"description"` // nil = not given; update_task: "" clears
	Status      string  `json:"status"`
	Text        string  `json:"text"`
	ReplyTo     string  `json:"reply_to"`
	Before      string  `json:"before"`
	Limit       int     `json:"limit"`
	Full        bool    `json:"full"`
	// update_task, assign, list_tasks (ADR-0156)
	Priority     string   `json:"priority"`
	Due          *string  `json:"due"`
	Start        *string  `json:"start"`
	Estimate     *int     `json:"estimate"`
	Parent       *string  `json:"parent"`
	Labels       []string `json:"labels"`
	AddLabels    []string `json:"add_labels"`
	RemoveLabels []string `json:"remove_labels"`
	Users        []string `json:"users"`
	Mode         string   `json:"mode"`
	Lead         string   `json:"lead"`
	Assignee     string   `json:"assignee"`
	State        string   `json:"state"`
	Sort         string   `json:"sort"`
	Cursor       string   `json:"cursor"`
	Mine         bool     `json:"mine"`
	// get_task_attachment, edit_message, read comments (CBF-182)
	File     string `json:"file"`
	Comment  string `json:"comment"`
	Message  string `json:"message"`
	Comments int    `json:"comments"`
	// comment_task, send_message: uploaded files to attach (upload_attachment, CBF-187)
	Files []string `json:"files"`
	// CBF-188: calendar, people, inbox, reactions, checklists, task links, approval
	Action     string   `json:"action"`
	Event      string   `json:"event"`
	From       string   `json:"from"`
	To         string   `json:"to"` // calendar: the window's end; send_message: the person
	End        *string  `json:"end"`
	Duration   int      `json:"duration"`
	AllDay     bool     `json:"all_day"`
	All        bool     `json:"all"`
	WorkHours  *bool    `json:"work_hours"`
	Repeat     string   `json:"repeat"`
	Occurrence string   `json:"occurrence"`
	Scope      string   `json:"scope"`
	Person     string   `json:"person"`
	Members    bool     `json:"members"`
	Emoji      string   `json:"emoji"`
	Item       string   `json:"item"`
	Items      []string `json:"items"`
	Checklist  string   `json:"checklist"`
	Related    string   `json:"related"`
	Decision   string   `json:"decision"`
	Reason     string   `json:"reason"`
}

type tool struct {
	def map[string]any
	run func(ctx context.Context, c *api, a args) (any, error)
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

func strs(desc string) map[string]any {
	return map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": desc}
}

func schema(required []string, props map[string]any) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func def(name, desc string, input map[string]any) map[string]any {
	return map[string]any{"name": name, "description": desc, "inputSchema": input}
}

var taskArg = str("task id or key (ABC-12)")

var filesArg = strs("file ids from upload_attachment: your own uploads, not attached yet")

// wsArg narrows a task key to one workspace (a key may repeat across workspaces).
var wsArg = str("workspace id, when a task key is in several workspaces")

var toolDefs = []tool{
	{def("find", "Find tasks, messages, rooms, boards or people the bot can see. Returns ids for the other tools.", schema(nil, map[string]any{
		"q":         str("words; for rooms/boards/people a name part, empty = all"),
		"kind":      map[string]any{"type": "string", "enum": []string{"tasks", "messages", "rooms", "boards", "people"}, "description": "default: all (people with q)"},
		"workspace": str("workspace id; default all"),
		"limit":     map[string]any{"type": "integer", "description": "per kind, 1-20, default 10"},
	})), find},
	{def("read", "Read a task (with its board's statuses, labels, checklists, files, Git links, releases, approval, links), a room's recent messages (members=true: who is in it) or a person's profile. Give task, room or person.", schema(nil, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"room":      str("room id (a task's comments: its room)"),
		"person":    str("me, a user id, a name or a nickname: profile, role, status, timezone"),
		"members":   map[string]any{"type": "boolean", "description": "room: who can see it"},
		"comments":  map[string]any{"type": "integer", "description": "task: latest comments, 1-50"},
		"limit":     map[string]any{"type": "integer", "description": "messages, 1-50, default 20"},
		"before":    str("message id: older history"),
		"full":      map[string]any{"type": "boolean", "description": "the full API object"},
	})), read},
	{def("create_task", "Create a task on a board.", schema([]string{"board", "title"}, map[string]any{
		"board":       str("board id or key (DEV)"),
		"title":       str("1-200 chars"),
		"description": str("markdown"),
		"status":      str("status name or id; default the board's"),
	})), createTask},
	{def("comment_task", "Comment on a task; files: ids from upload_attachment (all attach or nothing is posted).", schema([]string{"task"}, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"text":      str("comment, markdown; may be empty with files"),
		"files":     filesArg,
	})), commentTask},
	{def("set_task_status", "Move a task to another status of its board.", schema([]string{"task", "status"}, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"status":    str("status name or id"),
	})), setTaskStatus},
	{def("send_message", "Send a message to a room or to a person (their DM); files: ids from upload_attachment (all attach or nothing is sent).", schema(nil, map[string]any{
		"room":      str("room id"),
		"to":        str("instead of room: a user id, a name or a nickname"),
		"workspace": str("workspace id, to find the person in"),
		"text":      str("markdown, up to 4000 chars; may be empty with files"),
		"reply_to":  str("message id"),
		"files":     filesArg,
	})), sendMessage},
	// ADR-0156: the tools a developer's agent needs on a task besides the ones above.
	{def("list_tasks", "List tasks of a board or of all boards of a workspace by filters, newest update first; mine=true: my tasks (without board/workspace: my open tasks everywhere).", schema(nil, map[string]any{
		"board":     str("board id or key (DEV)"),
		"workspace": str("workspace id (when no board)"),
		"q":         str("words or a key; empty = filters only"),
		"status":    str("status names or ids, comma-separated"),
		"assignee":  str("me, a user id, a name or a nickname"),
		"labels":    strs("label names (any of them)"),
		"state":     map[string]any{"type": "string", "enum": []string{"open", "done", "all"}, "description": "default open"},
		"sort":      str("default newest update first (relevance with q); updated | created | key | priority | due, -updated etc. for descending"),
		"mine":      map[string]any{"type": "boolean", "description": "assignee me; without board/workspace: my open tasks on every board, other filters ignored"},
		"limit":     map[string]any{"type": "integer", "description": "1-50, default 20"},
		"cursor":    str("next page"),
	})), listTasks},
	{def("update_task", "Change fields of a task; only given fields change.", schema([]string{"task"}, map[string]any{
		"task":          taskArg,
		"workspace":     wsArg,
		"title":         str("1-200 chars"),
		"description":   str("markdown; replaces the description"),
		"priority":      map[string]any{"type": "string", "enum": []string{"none", "low", "medium", "high", "urgent"}},
		"due":           str("YYYY-MM-DD, empty = none"),
		"start":         str("YYYY-MM-DD, empty = none"),
		"estimate":      map[string]any{"type": "integer", "description": "0 = none"},
		"parent":        str("parent task id or key, empty = none"),
		"labels":        strs("label names: the whole set"),
		"add_labels":    strs("label names to add"),
		"remove_labels": strs("label names to remove"),
	})), updateTask},
	{def("assign", "Set who works on a task: add (default), remove or replace assignees; one is the lead.", schema([]string{"task", "users"}, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"users":     strs("me, user ids, names or nicknames"),
		"mode":      map[string]any{"type": "string", "enum": []string{"add", "remove", "set"}, "description": "default add"},
		"lead":      str("the lead among the assignees (me, id, name); default: kept, else the first"),
	})), assign},
	// CBF-182: a task's files for the agent; fixing its own comment instead of posting another.
	{def("get_task_attachment", "A file of a task or its comment: metadata (sha256) and download_url, a signed URL for 10 min: fetch it with curl in a shell, never paste the bytes into the chat. Text (256 KiB) and images (up to 3 MiB, else a preview) also inline. Limits 3 MiB, images 5 MiB; text, xlsx, docx, pptx, pdf, zip, ogg, mp3, wav, m4a, png, jpeg, webp, gif.", schema([]string{"task", "file"}, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"file":      str("file id (from read) or name"),
		"comment":   str("comment message id; default: the task, its last 100 comments"),
	})), getTaskAttachment},
	// CBF-187: a local file to a comment or message: upload URL, curl, then files of comment_task / send_message.
	{def("upload_attachment", "A single-use upload URL (10 min) for one local file up to 3 MiB for a task comment (task) or a room message (room): run the returned curl in a shell, then pass the answer's file id in files of comment_task or send_message.", schema(nil, map[string]any{
		"task":      str("task id or key whose comment gets the file (or room)"),
		"workspace": wsArg,
		"room":      str("room id whose message gets the file (or task)"),
	})), uploadAttachment},
	{def("edit_message", "Edit your own message or comment.", schema([]string{"message", "text"}, map[string]any{
		"message": str("message id"),
		"text":    str("markdown"),
	})), editMessage},
	// CBF-188: calendar, inbox, reactions, checklists, task links, approval.
	{def("calendar", "Meetings: mine in a period, one with its comments, people's free/busy, common free slots. Times ISO 8601 (no offset: my timezone).", schema(nil, map[string]any{
		"action":     map[string]any{"type": "string", "enum": []string{"list", "event", "freebusy", "suggest"}, "description": "default list"},
		"workspace":  str("workspace id"),
		"from":       str("default today 00:00"),
		"to":         str("default +7 days (freebusy +1)"),
		"all":        map[string]any{"type": "boolean", "description": "list: every one I see"},
		"event":      str("event: meeting id"),
		"users":      strs("me, user ids, names or nicknames"),
		"duration":   map[string]any{"type": "integer", "description": "suggest: minutes, default 30"},
		"work_hours": map[string]any{"type": "boolean", "description": "suggest: in working hours, default true"},
		"room":       str("suggest: a voice room that must be free too"),
		"limit":      map[string]any{"type": "integer", "description": "list: 1-100, default 50"},
	})), calendarTool},
	{def("event", "Create, change, cancel a meeting, or comment on it.", schema([]string{"action"}, map[string]any{
		"action":      map[string]any{"type": "string", "enum": []string{"create", "update", "cancel", "comment"}},
		"event":       str("meeting id (not for create)"),
		"workspace":   str("create: workspace id"),
		"title":       str("up to 120 chars"),
		"description": str("markdown"),
		"start":       str("ISO 8601; update keeps the length"),
		"end":         str("ISO 8601; or duration"),
		"duration":    map[string]any{"type": "integer", "description": "minutes, default 30"},
		"all_day":     map[string]any{"type": "boolean"},
		"users":       strs("attendees: user ids, names or nicknames"),
		"mode":        map[string]any{"type": "string", "enum": []string{"add", "remove", "set"}, "description": "update users, default add"},
		"room":        str("voice room id or name; update: none = no room"),
		"repeat":      map[string]any{"type": "string", "enum": []string{"none", "daily", "weekly", "biweekly", "monthly", "workdays"}},
		"occurrence":  str("one occurrence of a series (from calendar)"),
		"scope":       map[string]any{"type": "string", "enum": []string{"this", "following", "all"}, "description": "with occurrence, default this"},
		"text":        str("comment: markdown"),
	})), eventTool},
	{def("inbox", "What was written to me: unread DMs and messages mentioning me, newest first.", schema(nil, map[string]any{
		"workspace": str("mentions of one workspace"),
		"limit":     map[string]any{"type": "integer", "description": "1-50, default 20"},
		"before":    str("message id: older mentions"),
	})), inbox},
	{def("react", "Add or remove my reaction to a message.", schema([]string{"message", "emoji"}, map[string]any{
		"message": str("message id"),
		"emoji":   str("an emoji, e.g. 👍"),
		"mode":    map[string]any{"type": "string", "enum": []string{"add", "remove"}, "description": "default add"},
	})), react},
	{def("checklist", "Check, uncheck or toggle a task's checklist item, or add items.", schema([]string{"task"}, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"action":    map[string]any{"type": "string", "enum": []string{"check", "uncheck", "toggle", "add"}, "description": "default check"},
		"item":      str("number (as in read), text or id; add: the text"),
		"items":     strs("add: several items"),
		"checklist": str("title or id; add: default the first"),
	})), checklistTool},
	{def("link_tasks", "Link two tasks of a workspace or remove the link.", schema([]string{"task", "related"}, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"related":   str("the other task: id or key"),
		"kind":      map[string]any{"type": "string", "enum": []string{"relates", "blocks", "blocked_by", "duplicates"}, "description": "task <kind> related, default relates"},
		"mode":      map[string]any{"type": "string", "enum": []string{"add", "remove"}, "description": "default add"},
	})), linkTasks},
	{def("approve", "Vote on a task's approval as its approver.", schema([]string{"task", "decision"}, map[string]any{
		"task":      taskArg,
		"workspace": wsArg,
		"decision":  map[string]any{"type": "string", "enum": []string{"approve", "reject", "withdraw"}},
		"reason":    str("required to reject, up to 500 chars"),
	})), approve},
}

var (
	tools    = map[string]tool{}
	toolList []map[string]any
)

func init() {
	for _, t := range toolDefs {
		name := t.def["name"].(string)
		tools[name] = t
		toolList = append(toolList, t.def)
	}
}

// ToolNames lists the tools (tests).
func ToolNames() []string {
	out := make([]string, 0, len(toolList))
	for _, t := range toolList {
		out = append(out, t["name"].(string))
	}
	return out
}

func clamp(n, def, hi int) int {
	if n <= 0 {
		return def
	}
	return min(n, hi)
}

func need(name, v string) error {
	if strings.TrimSpace(v) == "" {
		return errors.New(name + " is required")
	}
	return nil
}

// ---- find ----

func find(ctx context.Context, c *api, a args) (any, error) {
	kinds := []string{"tasks", "messages", "rooms", "boards", "people"}
	if a.Kind != "" {
		if !slices.Contains(kinds, a.Kind) {
			return nil, errors.New("kind must be tasks, messages, rooms, boards or people")
		}
		kinds = []string{a.Kind}
	}
	limit := clamp(a.Limit, 10, 20)
	q := strings.TrimSpace(a.Q)
	if a.Kind == "" && q == "" {
		kinds = slices.DeleteFunc(kinds, func(k string) bool { return k == "people" }) // every member of every workspace: ask for it
	}
	out := map[string]any{}
	searchTasks, searchMsgs := slices.Contains(kinds, "tasks"), slices.Contains(kinds, "messages")
	if (searchTasks || searchMsgs) && q == "" {
		if a.Kind != "" {
			return nil, errors.New("q is required for " + a.Kind)
		}
		searchTasks, searchMsgs = false, false
	}
	if searchTasks || searchMsgs {
		var types []string
		if searchTasks {
			types = append(types, "tasks")
		}
		if searchMsgs {
			types = append(types, "messages", "task_comments")
		}
		scope := "all"
		if a.Workspace != "" {
			scope = strings.TrimSpace(a.Workspace)
		}
		var r v1.SearchResponse
		qs := url.Values{"q": {q}, "scope": {scope}, "types": {strings.Join(types, ",")}, "limit": {strconv.Itoa(limit)}}
		if err := c.call(ctx, http.MethodGet, "/api/search", qs, nil, &r); err != nil {
			return nil, err
		}
		var tasks, msgs []map[string]any
		for _, s := range r.GetSections() {
			for _, h := range s.GetItems() {
				switch {
				case h.GetTask() != nil:
					t := h.GetTask()
					tasks = append(tasks, compact(map[string]any{"id": t.GetTaskId(), "key": t.GetKey(), "title": h.GetTitle(),
						"status": enum(t.GetStatusType().String(), "BOARD_STATUS_TYPE_"), "board": t.GetBoardId()}))
				case h.GetMessage() != nil:
					m := h.GetMessage()
					msgs = append(msgs, compact(map[string]any{"id": m.GetMessageId(), "room": m.GetRoomId(), "text": snippet(h.GetSnippet()),
						"author": h.GetAuthorId(), "at": ts(h.GetAt())}))
				case h.GetTaskComment() != nil:
					m := h.GetTaskComment()
					msgs = append(msgs, compact(map[string]any{"id": m.GetMessageId(), "room": m.GetRoomId(), "task": m.GetTaskKey(),
						"text": snippet(h.GetSnippet()), "author": h.GetAuthorId(), "at": ts(h.GetAt())}))
				}
			}
		}
		if tasks != nil {
			out["tasks"] = tasks
		}
		if msgs != nil {
			out["messages"] = msgs
		}
	}
	wantRooms, wantBoards := slices.Contains(kinds, "rooms"), slices.Contains(kinds, "boards")
	if wantRooms || wantBoards {
		wss, err := workspaceIDs(ctx, c, a.Workspace)
		if err != nil {
			return nil, err
		}
		low := strings.ToLower(q)
		var rooms, boards []map[string]any
		for _, ws := range wss {
			if wantRooms && len(rooms) < limit {
				var r v1.ListRoomsResponse
				if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/rooms", nil, nil, &r); err != nil {
					return nil, err
				}
				for _, x := range r.GetRooms() {
					if len(rooms) < limit && strings.Contains(strings.ToLower(x.GetName()), low) {
						rooms = append(rooms, compact(map[string]any{"id": x.GetId(), "name": x.GetName(),
							"type": enum(x.GetType().String(), "ROOM_TYPE_"), "workspace": ws}))
					}
				}
			}
			if wantBoards && len(boards) < limit {
				var r v1.ListBoardsResponse
				if err := c.call(ctx, http.MethodGet, "/api/workspaces/"+seg(ws)+"/boards", nil, nil, &r); err != nil {
					// a workspace whose roles give no boards (403) is skipped, not fatal
					var ae *apiError
					if errors.As(err, &ae) && ae.status == http.StatusForbidden {
						continue
					}
					return nil, err
				}
				for _, b := range r.GetBoards() {
					if len(boards) < limit && (strings.Contains(strings.ToLower(b.GetName()), low) || strings.EqualFold(b.GetKey(), q)) {
						boards = append(boards, compact(map[string]any{"id": b.GetId(), "key": b.GetKey(), "name": b.GetName(), "workspace": ws}))
					}
				}
			}
		}
		if rooms != nil {
			out["rooms"] = rooms
		}
		if boards != nil {
			out["boards"] = boards
		}
	}
	if slices.Contains(kinds, "people") {
		wss, err := workspaceIDs(ctx, c, a.Workspace)
		if err != nil {
			return nil, err
		}
		ps, err := people(ctx, c, wss, q, limit)
		if err != nil {
			return nil, err
		}
		if ps != nil {
			out["people"] = ps
		}
	}
	if len(out) == 0 {
		return map[string]any{"found": 0}, nil
	}
	return out, nil
}

func workspaceIDs(ctx context.Context, c *api, ws string) ([]string, error) {
	if ws = strings.TrimSpace(ws); ws != "" {
		return []string{ws}, nil
	}
	var r v1.ListWorkspacesResponse
	if err := c.call(ctx, http.MethodGet, "/api/workspaces", nil, nil, &r); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(r.GetWorkspaces()))
	for _, w := range r.GetWorkspaces() {
		out = append(out, w.GetId())
	}
	return out, nil
}

// ---- read ----

func read(ctx context.Context, c *api, a args) (any, error) {
	switch {
	case strings.TrimSpace(a.Person) != "":
		return readPerson(ctx, c, a) // CBF-188
	case strings.TrimSpace(a.Task) != "":
		tr, board, err := loadTask(ctx, c, a.Task, a.Workspace)
		if err != nil {
			return nil, err
		}
		if a.Full {
			return raw(tr)
		}
		t := tr.GetTask()
		var assignees []string
		lead := ""
		for _, x := range t.GetAssignees() {
			assignees = append(assignees, x.GetUserId())
			if x.GetIsLead() {
				lead = x.GetUserId()
			}
		}
		var subs []map[string]any
		for _, s := range tr.GetSubtasks() {
			subs = append(subs, compact(map[string]any{"id": s.GetId(), "key": s.GetKey(), "title": s.GetTitle(), "status": statusName(board, s.GetStatusId())}))
		}
		var statuses []string
		for _, s := range board.GetStatuses() {
			statuses = append(statuses, s.GetName())
		}
		out := map[string]any{
			"id": t.GetId(), "key": t.GetKey(), "title": t.GetTitle(), "description": t.GetDescription(),
			"status": statusName(board, t.GetStatusId()), "statuses": statuses,
			"priority": enum(t.GetPriority().String(), "TASK_PRIORITY_"), "assignees": assignees, "lead": lead,
			"labels": labelNames(board, t.GetLabelIds()),
			"start":  t.GetStartOn(), "due": t.GetDueOn(), "board": compact(map[string]any{"id": board.GetId(), "key": board.GetKey(), "name": board.GetName()}),
			"workspace": t.GetWorkspaceId(), "room": t.GetRoomId(), "comments": t.GetCommentCount(), "subtasks": subs,
			"created_by": t.GetCreatedBy(), "updated": ts(t.GetUpdatedAt()),
			"git": gitLinks(t), "releases": releases(t), // ADR-0156
			"files": fileList(t.GetAttachments()), "checklists": checklists(t), // CBF-182
			"approval": approvalInfo(t), "links": taskLinks(tr), // CBF-188
		}
		if p := tr.GetParent(); p != nil {
			out["parent"] = compact(map[string]any{"id": p.GetId(), "key": p.GetKey(), "title": p.GetTitle()})
		}
		if a.Comments > 0 && t.GetRoomId() != "" {
			var ms v1.ListMessagesResponse
			qs := url.Values{"limit": {strconv.Itoa(clamp(a.Comments, 20, 50))}}
			if err := c.call(ctx, http.MethodGet, "/api/rooms/"+seg(t.GetRoomId())+"/messages", qs, nil, &ms); err != nil {
				return nil, err
			}
			list := make([]map[string]any, 0, len(ms.GetMessages()))
			for _, m := range slices.Backward(ms.GetMessages()) {
				list = append(list, message(m))
			}
			out["recent_comments"], out["more_comments"] = list, ms.GetHasMore()
		}
		return compact(out), nil
	case strings.TrimSpace(a.Room) != "":
		var room v1.GetRoomResponse
		if err := c.call(ctx, http.MethodGet, "/api/rooms/"+seg(a.Room), nil, nil, &room); err != nil {
			return nil, err
		}
		qs := url.Values{"limit": {strconv.Itoa(clamp(a.Limit, 20, 50))}}
		if a.Before != "" {
			qs.Set("before", a.Before)
		}
		var ms v1.ListMessagesResponse
		if err := c.call(ctx, http.MethodGet, "/api/rooms/"+seg(a.Room)+"/messages", qs, nil, &ms); err != nil {
			return nil, err
		}
		if a.Full {
			return raw(&ms)
		}
		r := room.GetRoom()
		list := make([]map[string]any, 0, len(ms.GetMessages()))
		for _, m := range slices.Backward(ms.GetMessages()) { // newest first in the API, oldest first here
			list = append(list, message(m))
		}
		out := map[string]any{
			"room": compact(map[string]any{"id": r.GetId(), "name": r.GetName(), "type": enum(r.GetType().String(), "ROOM_TYPE_"),
				"topic": r.GetTopic(), "workspace": r.GetWorkspaceId()}),
			"messages": list, "more": ms.GetHasMore(),
		}
		if a.Members { // CBF-188
			people, total, err := roomMembers(ctx, c, r)
			if err != nil {
				return nil, err
			}
			out["members"] = people
			if total > len(people) {
				out["members_total"] = total
			}
		}
		return compact(out), nil
	}
	return nil, errors.New("give task, room or person")
}

func message(m *v1.Message) map[string]any {
	text := m.GetContent()
	switch {
	case m.GetKind() == v1.MessageKind_MESSAGE_KIND_SYSTEM:
		text = "[system]"
	case m.GetSticker() != nil:
		text = "[sticker " + m.GetSticker().GetEmoji() + "]"
	}
	files := fileList(m.GetAttachments()) // ids for get_task_attachment (CBF-182)
	// ADR-0140: who saw the bot's own message on screen (set by the API for the author only).
	var readBy []map[string]any
	for _, rd := range m.GetReadBy() {
		readBy = append(readBy, map[string]any{"user": rd.GetUserId(), "at": ts(rd.GetReadAt())})
	}
	return compact(map[string]any{"id": m.GetId(), "author": m.GetAuthorId(), "text": text, "at": ts(m.GetCreatedAt()),
		"reply_to": m.GetReplyToId(), "files": files, "read_by": readBy})
}

// taskByRef reads a task by id, or by key (GET /api/t/{key}) in workspace ws. A key is unique
// only within a workspace (ADR-0156): without ws it is looked up in each of the caller's
// workspaces and must be found in exactly one — never the first match, a write must not land
// in another workspace's task.
func taskByRef(ctx context.Context, c *api, ref, ws string) (*v1.TaskResponse, error) {
	ref = strings.TrimSpace(ref)
	if _, err := uuid.Parse(ref); err == nil {
		var tr v1.TaskResponse
		if err := c.call(ctx, http.MethodGet, "/api/tasks/"+seg(ref), nil, nil, &tr); err != nil {
			return nil, err
		}
		if tr.GetTask() == nil {
			return nil, errors.New("task not found")
		}
		return &tr, nil
	}
	path := "/api/t/" + seg(strings.ToUpper(ref))
	wss, err := workspaceIDs(ctx, c, ws)
	if err != nil {
		return nil, err
	}
	var found []*v1.TaskResponse
	var miss error
	for _, w := range wss {
		var tr v1.TaskResponse
		if err := c.call(ctx, http.MethodGet, path, url.Values{"workspace_id": {w}}, nil, &tr); err != nil {
			var ae *apiError
			if errors.As(err, &ae) && (ae.status == http.StatusNotFound || ae.status == http.StatusForbidden) && len(wss) > 1 {
				miss = err
				continue
			}
			return nil, err
		}
		if tr.GetTask() != nil {
			found = append(found, &tr)
		}
	}
	switch len(found) {
	case 0:
		if miss != nil {
			return nil, miss
		}
		return nil, errors.New("task not found")
	case 1:
		return found[0], nil
	}
	names := make([]string, 0, len(found))
	for _, tr := range found {
		names = append(names, tr.GetTask().GetKey()+" "+strconv.Quote(tr.GetTask().GetTitle())+" (id "+tr.GetTask().GetId()+", workspace "+tr.GetTask().GetWorkspaceId()+")")
	}
	return nil, errors.New("task key " + strconv.Quote(strings.ToUpper(ref)) + " is in several workspaces, give the task id or workspace: " + strings.Join(names, "; "))
}

// loadTask reads a task by id or key (in workspace ws) with its board (statuses).
func loadTask(ctx context.Context, c *api, ref, ws string) (*v1.TaskResponse, *v1.Board, error) {
	tr, err := taskByRef(ctx, c, ref, ws)
	if err != nil {
		return nil, nil, err
	}
	if b := tr.GetBoard(); b != nil {
		return tr, b, nil
	}
	b, err := loadBoard(ctx, c, tr.GetTask().GetBoardId())
	return tr, b, err
}

func loadBoard(ctx context.Context, c *api, id string) (*v1.Board, error) {
	var br v1.BoardResponse
	if err := c.call(ctx, http.MethodGet, "/api/boards/"+seg(id), nil, nil, &br); err != nil {
		return nil, err
	}
	return br.GetBoard(), nil
}

func statusName(b *v1.Board, id string) string {
	for _, s := range b.GetStatuses() {
		if s.GetId() == id {
			return s.GetName()
		}
	}
	return id
}

// statusID resolves a status of the board by id or name (case-insensitive).
func statusID(b *v1.Board, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	names := make([]string, 0, len(b.GetStatuses()))
	for _, s := range b.GetStatuses() {
		if s.GetId() == ref || strings.EqualFold(s.GetName(), ref) {
			return s.GetId(), nil
		}
		names = append(names, s.GetName())
	}
	return "", errors.New("no status " + strconv.Quote(ref) + "; statuses: " + strings.Join(names, ", "))
}

// ---- actions ----

func createTask(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("board", a.Board), need("title", a.Title)); err != nil {
		return nil, err
	}
	req := &v1.CreateTaskRequest{Title: a.Title, Description: deref(a.Description)}
	boardID := strings.TrimSpace(a.Board)
	var board *v1.Board
	if _, err := uuid.Parse(boardID); a.Status != "" || err != nil { // a status by name, or a board by key (ADR-0156)
		b, err := resolveBoard(ctx, c, boardID, a.Workspace)
		if err != nil {
			return nil, err
		}
		if a.Status != "" {
			if req.StatusId, err = statusID(b, a.Status); err != nil {
				return nil, err
			}
		}
		board, boardID = b, b.GetId()
	}
	var tr v1.TaskResponse
	if err := c.call(ctx, http.MethodPost, "/api/boards/"+seg(boardID)+"/tasks", nil, req, &tr); err != nil {
		return nil, err
	}
	t := tr.GetTask()
	out := where(map[string]any{"id": t.GetId(), "key": t.GetKey(), "room": t.GetRoomId()}, t, board)
	if board != nil {
		out["status"] = statusName(board, t.GetStatusId())
	}
	return out, nil
}

// where adds to a write tool's answer the workspace and board the write landed in (ADR-0156):
// a key may repeat across workspaces, and the agent and the person must see where it went.
func where(out map[string]any, t *v1.Task, b *v1.Board) map[string]any {
	out["workspace"] = t.GetWorkspaceId()
	board := t.GetBoardId()
	if b != nil && b.GetId() == board {
		board = b.GetName() + " (" + b.GetKey() + ")"
	}
	out["board"] = board
	return compact(out)
}

func commentTask(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("task", a.Task), needBody(a)); err != nil {
		return nil, err
	}
	tr, err := taskByRef(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	out, err := send(ctx, c, tr.GetTask().GetRoomId(), a.Text, "", a.Files)
	if err != nil {
		return nil, err
	}
	m := out.(map[string]any)
	m["task"] = tr.GetTask().GetKey()
	return where(m, tr.GetTask(), tr.GetBoard()), nil
}

func setTaskStatus(ctx context.Context, c *api, a args) (any, error) {
	if err := errors.Join(need("task", a.Task), need("status", a.Status)); err != nil {
		return nil, err
	}
	tr, board, err := loadTask(ctx, c, a.Task, a.Workspace)
	if err != nil {
		return nil, err
	}
	sid, err := statusID(board, a.Status)
	if err != nil {
		return nil, err
	}
	var out v1.TaskResponse
	if err := c.call(ctx, http.MethodPatch, "/api/tasks/"+seg(tr.GetTask().GetId()), nil, &v1.UpdateTaskRequest{StatusId: &sid}, &out); err != nil {
		return nil, err
	}
	return where(map[string]any{"key": out.GetTask().GetKey(), "status": statusName(board, out.GetTask().GetStatusId())}, out.GetTask(), board), nil
}

func sendMessage(ctx context.Context, c *api, a args) (any, error) {
	if err := needBody(a); err != nil {
		return nil, err
	}
	room := strings.TrimSpace(a.Room)
	switch {
	case room != "" && strings.TrimSpace(a.To) != "":
		return nil, errors.New("give room or to, not both")
	case room == "" && strings.TrimSpace(a.To) == "":
		return nil, errors.New("give room or to")
	case room == "": // CBF-188: the person's DM, opened if new
		var err error
		if room, err = dmWith(ctx, c, a.Workspace, a.To); err != nil {
			return nil, err
		}
	}
	return send(ctx, c, room, a.Text, a.ReplyTo, a.Files)
}

// needBody: a message needs text or files.
func needBody(a args) error {
	if strings.TrimSpace(a.Text) == "" && len(a.Files) == 0 {
		return errors.New("text is required (or files)")
	}
	return nil
}

// send posts a message with files (ids of the caller's unattached uploads) through the app's
// route: it checks ATTACH_FILES and that every file is the caller's own unattached upload in
// this workspace, in one transaction: one bad id and nothing is posted.
func send(ctx context.Context, c *api, room, text, replyTo string, files []string) (any, error) {
	var r v1.CreateMessageResponse
	var ids []string
	for _, f := range files {
		ids = append(ids, strings.TrimSpace(f))
	}
	req := &v1.CreateMessageRequest{Content: text, ReplyToId: strings.TrimSpace(replyTo), Nonce: uuid.NewString(), AttachmentIds: ids}
	if err := c.call(ctx, http.MethodPost, "/api/rooms/"+seg(room)+"/messages", nil, req, &r); err != nil {
		return nil, err
	}
	out := map[string]any{"id": r.GetMessage().GetId(), "room": r.GetMessage().GetRoomId()}
	if fs := fileList(r.GetMessage().GetAttachments()); fs != nil {
		out["files"] = fs
	}
	return out, nil
}

// ---- compact answers ----

// jsonText is v as compact JSON (a content block's text).
func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// raw is the API object as protojson without default values (read full=true).
func raw(m proto.Message) (any, error) {
	b, err := marshal.Marshal(m)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(b), nil
}

// compact drops empty values: "", 0, false, nil and empty lists / maps.
func compact(m map[string]any) map[string]any {
	for k, v := range m {
		switch x := v.(type) {
		case string:
			if x == "" {
				delete(m, k)
			}
		case bool:
			if !x {
				delete(m, k)
			}
		case uint32:
			if x == 0 {
				delete(m, k)
			}
		case uint64:
			if x == 0 {
				delete(m, k)
			}
		case []string:
			if len(x) == 0 {
				delete(m, k)
			}
		case []map[string]any:
			if len(x) == 0 {
				delete(m, k)
			}
		case map[string]any:
			if len(x) == 0 {
				delete(m, k)
			}
		case nil:
			delete(m, k)
		}
	}
	return m
}

// enum is an enum name in lower case without its prefix; "" for the unspecified value.
func enum(name, prefix string) string {
	s := strings.ToLower(strings.TrimPrefix(name, prefix))
	if s == "unspecified" {
		return ""
	}
	return s
}

// snippet removes the highlight marks of search snippets (U+0002 / U+0003).
func snippet(s string) string { return strings.NewReplacer("\x02", "", "\x03", "").Replace(s) }

func ts(t *timestamppb.Timestamp) string {
	if t == nil {
		return ""
	}
	return t.AsTime().UTC().Format("2006-01-02T15:04Z")
}

// deref is the value of an optional string argument, "" when not given.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
