package mcp

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// The CBF-188 tools: calendar, event, people (read person / members), inbox, send_message to,
// react, checklist, link_tasks, approve.

func (f *taskFixture) me188() *v1.GetMeResponse {
	return &v1.GetMeResponse{Me: &v1.Me{User: &v1.User{Id: f.me, Timezone: "Europe/Moscow"}}}
}

func forbidden(reason string) *v1.ApiError {
	return &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_FORBIDDEN, Message: "not allowed", Reason: proto.String(reason)}
}

func TestCalendarTool(t *testing.T) {
	f := newTaskFixture()
	start := time.Date(2026, 11, 16, 7, 0, 0, 0, time.UTC) // 10:00 in Moscow
	mineEv := &v1.CalendarEvent{Id: "e1", Title: "Планёрка", StartsAt: timestamppb.New(start), EndsAt: timestamppb.New(start.Add(30 * time.Minute)),
		OrganizerId: f.ann, Attendees: []*v1.CalendarEventAttendee{{UserId: f.me, Status: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED, Required: true}},
		MyStatus: v1.AttendeeStatus_ATTENDEE_STATUS_ACCEPTED, Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY, OccurrenceAt: timestamppb.New(start)}
	other := &v1.CalendarEvent{Id: "e2", Title: "Чужая", StartsAt: timestamppb.New(start), EndsAt: timestamppb.New(start.Add(time.Hour)), OrganizerId: f.bob}
	var query map[string][]string
	var body string
	fa := f.api(t, func(r *http.Request, b string) (int, proto.Message, bool) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/me":
			return 200, f.me188(), true
		case "GET /api/workspaces/" + f.ws + "/events":
			query = r.URL.Query()
			return 200, &v1.ListCalendarEventsResponse{Events: []*v1.CalendarEvent{mineEv, other}}, true
		case "GET /api/workspaces/" + f.ws + "/freebusy":
			query = r.URL.Query()
			return 200, &v1.FreeBusyResponse{Users: []*v1.FreeBusyUser{{UserId: f.ann, Timezone: "Europe/Moscow",
				WorkHours: &v1.WorkHours{StartMin: 9 * 60, EndMin: 18 * 60, Days: []uint32{1, 2, 3, 4, 5}},
				Busy:      []*v1.BusyInterval{{StartsAt: timestamppb.New(start), EndsAt: timestamppb.New(start.Add(time.Hour)), EventId: "e1"}}}}}, true
		case "POST /api/workspaces/" + f.ws + "/freebusy/suggest":
			body = b
			if strings.Contains(b, `"durationMin":1440`) {
				return 409, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_CONFLICT, Message: "no common hours", Reason: proto.String("NO_COMMON_HOURS")}, true
			}
			return 200, &v1.SuggestSlotsResponse{Slots: []*v1.Slot{{StartsAt: timestamppb.New(start), EndsAt: timestamppb.New(start.Add(45 * time.Minute))}}}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa

	text, isErr := call(t, h, "calendar", `{"from":"2026-11-16","to":"2026-11-17"}`)
	if isErr || !strings.Contains(text, `"when":"2026-11-16 10:00–10:30"`) || !strings.Contains(text, `"tz":"Europe/Moscow"`) ||
		strings.Contains(text, "Чужая") || !strings.Contains(text, `"occurrence":"2026-11-16T07:00:00Z"`) || !strings.Contains(text, `"me":"accepted"`) {
		t.Fatalf("list: %v %s", isErr, text)
	}
	// A date is the whole day in my zone: [16th 00:00, 18th 00:00) Moscow.
	if query["from"][0] != "2026-11-15T21:00:00Z" || query["to"][0] != "2026-11-17T21:00:00Z" {
		t.Fatalf("window %v", query)
	}
	if text, _ = call(t, h, "calendar", `{"all":true,"from":"2026-11-16T00:00:00+03:00"}`); !strings.Contains(text, "Чужая") {
		t.Fatalf("all: %s", text)
	}

	text, isErr = call(t, h, "calendar", `{"action":"freebusy","users":["Анна"],"from":"2026-11-16T09:00+03:00","to":"2026-11-16T18:00+03:00"}`)
	if isErr || query["users"][0] != f.ann || query["from"][0] != "2026-11-16T06:00:00Z" || !strings.Contains(text, `"work_hours":"09:00–18:00 Mon,Tue,Wed,Thu,Fri"`) ||
		!strings.Contains(text, `"when":"2026-11-16 10:00–11:00"`) {
		t.Fatalf("freebusy: %v %s %v", isErr, text, query)
	}

	text, isErr = call(t, h, "calendar", `{"action":"suggest","users":["me","ann"],"duration":45,"from":"2099-01-01T09:00+03:00"}`)
	var req v1.SuggestSlotsRequest
	_ = unmarshal.Unmarshal([]byte(body), &req)
	if isErr || !strings.Contains(text, `"slots":["2026-11-16 10:00–10:45"]`) || req.GetDurationMin() != 45 || !req.GetWithinWorkHours() ||
		strings.Join(req.GetUsers(), ",") != f.me+","+f.ann {
		t.Fatalf("suggest: %v %s %v", isErr, text, &req)
	}
	if text, isErr = call(t, h, "calendar", `{"action":"suggest","users":["ann"],"duration":1440,"work_hours":false,"from":"2099-01-01"}`); !isErr || !strings.Contains(text, "409 CONFLICT") {
		t.Fatalf("suggest refused: %s", text)
	}

	for _, c := range []struct{ args, want string }{
		{`{"action":"nope"}`, "action must be"},
		{`{"from":"16.11.2026"}`, "use ISO 8601"},
		{`{"from":"2026-11-16","to":"2026-11-10"}`, "to must be after from"},
		{`{"action":"freebusy"}`, "users is required"},
		{`{"action":"event"}`, "event is required"},
	} {
		if text, isErr := call(t, h, "calendar", c.args); !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s: %v %s", c.args, isErr, text)
		}
	}
}

func TestEventTool(t *testing.T) {
	f := newTaskFixture()
	voice, text := uuid.NewString(), uuid.NewString()
	start := time.Date(2026, 11, 16, 7, 0, 0, 0, time.UTC)
	ev := &v1.CalendarEvent{Id: "e1", WorkspaceId: f.ws, Title: "Демо", StartsAt: timestamppb.New(start), EndsAt: timestamppb.New(start.Add(time.Hour)),
		OrganizerId: f.me, Repeat: v1.EventRepeat_EVENT_REPEAT_WEEKLY,
		Attendees: []*v1.CalendarEventAttendee{{UserId: f.me, Required: true}, {UserId: f.ann, Required: false}, {Email: "x@example.com", Required: true}}}
	var bodies, paths []string
	fa := f.api(t, func(r *http.Request, b string) (int, proto.Message, bool) {
		switch r.Method + " " + r.URL.Path {
		case "GET /api/me":
			return 200, f.me188(), true
		case "GET /api/workspaces/" + f.ws + "/rooms":
			return 200, &v1.ListRoomsResponse{Rooms: []*v1.Room{{Id: text, Name: "Общий", Type: v1.RoomType_ROOM_TYPE_TEXT}, {Id: voice, Name: "Общий голос", Type: v1.RoomType_ROOM_TYPE_VOICE}}}, true
		case "POST /api/workspaces/" + f.ws + "/events", "PATCH /api/events/e1":
			bodies = append(bodies, b)
			return 200, &v1.CalendarEventResponse{Event: ev}, true
		case "GET /api/events/e1":
			return 200, &v1.CalendarEventResponse{Event: ev}, true
		case "DELETE /api/events/e1":
			paths = append(paths, r.URL.String())
			return 204, nil, true
		case "POST /api/events/e1/comments":
			if r.Header.Get("Calab-On-Behalf") != "" {
				return 403, forbidden("ON_BEHALF_ROUTE"), true
			}
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa

	res, isErr := call(t, h, "event", `{"action":"create","title":"Демо","start":"2026-11-16T10:00","duration":60,"users":["Анна","bob"],"room":"общий"}`)
	var cr v1.CreateCalendarEventRequest
	_ = unmarshal.Unmarshal([]byte(bodies[0]), &cr)
	if isErr || cr.GetTz() != "Europe/Moscow" || !cr.GetStartsAt().AsTime().Equal(start) || !cr.GetEndsAt().AsTime().Equal(start.Add(time.Hour)) ||
		cr.GetRoomId() != voice || len(cr.GetAttendees()) != 2 || cr.GetAttendees()[0].GetUserId() != f.ann || cr.GetAttendees()[1].GetUserId() != f.bob {
		t.Fatalf("create: %v %s %v", isErr, res, &cr)
	}
	if !strings.Contains(res, `"when":"2026-11-16 10:00–11:00"`) || !strings.Contains(res, `"optional":true`) {
		t.Fatalf("create answer: %s", res)
	}

	// Reschedule one occurrence: the length is kept; the attendees added keep the others.
	_, isErr = call(t, h, "event", `{"action":"update","event":"e1","occurrence":"2026-11-23T10:00+03:00","start":"2026-11-23T15:00+03:00","users":["bob"]}`)
	var ur v1.UpdateCalendarEventRequest
	_ = unmarshal.Unmarshal([]byte(bodies[1]), &ur)
	occ := time.Date(2026, 11, 23, 7, 0, 0, 0, time.UTC)
	if isErr || ur.GetScope() != v1.EventScope_EVENT_SCOPE_THIS || !ur.GetOccurrenceAt().AsTime().Equal(occ) ||
		!ur.GetStartsAt().AsTime().Equal(occ.Add(5*time.Hour)) || !ur.GetEndsAt().AsTime().Equal(occ.Add(6*time.Hour)) ||
		!ur.GetSetAttendees() || len(ur.GetAttendees()) != 4 || ur.GetAttendees()[1].GetRequired() || ur.GetAttendees()[2].GetEmail() != "x@example.com" {
		t.Fatalf("update: %v %v", isErr, &ur)
	}
	_, _ = call(t, h, "event", `{"action":"update","event":"e1","users":["ann"],"mode":"remove","room":"none"}`)
	ur.Reset()
	_ = unmarshal.Unmarshal([]byte(bodies[2]), &ur)
	if len(ur.GetAttendees()) != 2 || ur.RoomId == nil || ur.GetRoomId() != "" || ur.StartsAt != nil {
		t.Fatalf("update remove: %v", &ur)
	}

	if _, isErr = call(t, h, "event", `{"action":"cancel","event":"e1","occurrence":"2026-11-23T07:00:00Z","scope":"following"}`); isErr ||
		paths[0] != "/api/events/e1?occurrence=2026-11-23T07%3A00%3A00Z&scope=following" {
		t.Fatalf("cancel: %v", paths)
	}

	// A meeting comment is closed on behalf (ADR-0109): the refusal says what to do.
	if res, isErr = call(t, h, "event", `{"action":"comment","event":"e1","text":"буду"}`); !isErr || !strings.Contains(res, "ON_BEHALF_ROUTE") || !strings.Contains(res, "OAuth") {
		t.Fatalf("comment on behalf: %s", res)
	}

	for _, c := range []struct{ args, want string }{
		{`{"action":"create","title":"x"}`, "start is required"},
		{`{"action":"create","title":"x","start":"2026-11-16T10:00","room":"нет такой"}`, "no voice room"},
		{`{"action":"create","title":"x","start":"2026-11-16T10:00","users":["Петров"]}`, "several members match"},
		{`{"action":"create","title":"x","start":"2026-11-16T10:00","repeat":"yearly"}`, "repeat must be"},
		{`{"action":"update","event":"e1","scope":"following"}`, "needs occurrence"},
		{`{"action":"cancel"}`, "event is required"},
		{`{}`, "action must be"},
	} {
		if text, isErr := call(t, h, "event", c.args); !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s: %v %s", c.args, isErr, text)
		}
	}
}

func TestPeopleTools(t *testing.T) {
	f := newTaskFixture()
	member := perm.RoleDefaults[perm.RoleMember]
	memberRole, pub, priv, dm := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	rooms := map[string]*v1.Room{
		pub: {Id: pub, WorkspaceId: f.ws, Name: "общий", Type: v1.RoomType_ROOM_TYPE_TEXT},
		priv: {Id: priv, WorkspaceId: f.ws, Name: "тайная", Type: v1.RoomType_ROOM_TYPE_TEXT, IsPrivate: true, Restricted: true, CreatedBy: f.me,
			PermissionOverrides: []*v1.RoomPermissionOverride{{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: f.bob, Allow: uint64(perm.ViewRoom)}}},
		dm: {Id: dm, Type: v1.RoomType_ROOM_TYPE_DM},
	}
	mem := func(id, name, nick string) *v1.WorkspaceMember {
		m := f.member(id, name, nick)
		m.Role, m.RoleIds = v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER, []string{memberRole}
		return m
	}
	var sent []string
	fa := f.api(t, func(r *http.Request, b string) (int, proto.Message, bool) {
		p := r.URL.Path
		switch {
		case r.Method == "GET" && p == "/api/me":
			return 200, f.me188(), true
		case r.Method == "GET" && p == "/api/workspaces/"+f.ws+"/members":
			return 200, &v1.ListMembersResponse{Members: []*v1.WorkspaceMember{mem(f.me, "Тимофей Шмаков", "tim"), mem(f.ann, "Анна Петрова", "ann"), mem(f.bob, "Борис Петров", "bob")}}, true
		case r.Method == "GET" && p == "/api/workspaces/"+f.ws+"/members/"+f.ann:
			m := mem(f.ann, "Анна Петрова", "ann")
			m.RoleIds = append(m.RoleIds, "r-design")
			m.User.Timezone, m.User.StatusEmoji, m.User.StatusText = "Asia/Novosibirsk", "🌴", "в отпуске"
			return 200, &v1.GetMemberResponse{Member: m, OpenTasks: []*v1.Task{f.task}}, true
		case r.Method == "GET" && p == "/api/workspaces/"+f.ws+"/roles":
			return 200, &v1.ListRolesResponse{Roles: []*v1.Role{{Id: "r-design", Name: "Дизайн", Position: 2}, {Id: memberRole, Name: "member", Position: 1, Permissions: uint64(member), Builtin: v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER}}}, true
		case r.Method == "GET" && strings.HasPrefix(p, "/api/rooms/") && strings.HasSuffix(p, "/messages"):
			return 200, &v1.ListMessagesResponse{}, true
		case r.Method == "GET" && strings.HasPrefix(p, "/api/rooms/"):
			if x := rooms[strings.TrimPrefix(p, "/api/rooms/")]; x != nil {
				return 200, &v1.GetRoomResponse{Room: x}, true
			}
			return 404, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_NOT_FOUND, Message: "not found"}, true
		case r.Method == "GET" && p == "/api/dms":
			return 200, &v1.ListDmsResponse{Dms: []*v1.DmSummary{
				{Room: &v1.Room{Id: dm}, Peer: &v1.User{Id: f.ann, DisplayName: "Анна Петрова"}, ReadState: &v1.ReadState{UnreadCount: 2},
					LastMessage: &v1.DmLastMessage{Content: "посмотри DEV-7"}, LastMessageAt: timestamppb.Now()},
				{Room: &v1.Room{Id: "dm-read"}, Peer: &v1.User{Id: f.bob}, ReadState: &v1.ReadState{}}}}, true
		case r.Method == "GET" && p == "/api/me/mentions":
			return 200, &v1.ListMessagesResponse{Messages: []*v1.Message{{Id: "m9", RoomId: pub, AuthorId: f.bob, Content: "@tim глянь"}}, HasMore: true}, true
		case r.Method == "POST" && p == "/api/dms":
			sent = append(sent, b)
			return 200, &v1.CreateDmResponse{Dm: &v1.DmSummary{Room: &v1.Room{Id: dm}}}, true
		case r.Method == "POST" && p == "/api/rooms/"+dm+"/messages":
			sent = append(sent, b)
			return 201, &v1.CreateMessageResponse{Message: &v1.Message{Id: "m10", RoomId: dm}}, true
		case p == "/api/messages/m9/reactions/👍":
			sent = append(sent, r.Method)
			return 204, nil, true
		case p == "/api/messages/m8/reactions/👍":
			return 403, forbidden(""), true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa

	text, isErr := call(t, h, "read", `{"person":"ann"}`)
	if isErr || !strings.Contains(text, `"timezone":"Asia/Novosibirsk"`) || !strings.Contains(text, `"status":"🌴 в отпуске"`) ||
		!strings.Contains(text, `"roles":["Дизайн"]`) || !strings.Contains(text, `"role":"member"`) || !strings.Contains(text, `"key":"DEV-7"`) || !strings.Contains(text, `"local_time"`) {
		t.Fatalf("person: %v %s", isErr, text)
	}
	if text, isErr = call(t, h, "read", `{"person":"Никто"}`); !isErr || !strings.Contains(text, "no member") {
		t.Fatalf("unknown person: %s", text)
	}

	// Members: the public room — everyone; the private one — its creator and who was let in.
	text, _ = call(t, h, "read", `{"room":"`+pub+`","members":true}`)
	if strings.Count(text, `"nick"`) != 3 {
		t.Fatalf("public members: %s", text)
	}
	text, _ = call(t, h, "read", `{"room":"`+priv+`","members":true}`)
	if !strings.Contains(text, f.me) || !strings.Contains(text, f.bob) || strings.Contains(text, f.ann) {
		t.Fatalf("private members: %s", text)
	}
	if text, _ = call(t, h, "read", `{"room":"`+dm+`","members":true}`); !strings.Contains(text, f.ann) || !strings.Contains(text, f.me) {
		t.Fatalf("dm members: %s", text)
	}
	if text, isErr = call(t, h, "read", `{"room":"nope","members":true}`); !isErr || !strings.Contains(text, "404") {
		t.Fatalf("hidden room: %s", text)
	}

	text, isErr = call(t, h, "inbox", `{}`)
	var in struct {
		DMs []struct {
			Room   string
			Unread int
			Last   string
		}
		Mentions []map[string]any
		More     bool
	}
	_ = json.Unmarshal([]byte(text), &in)
	if isErr || len(in.DMs) != 1 || in.DMs[0].Unread != 2 || in.DMs[0].Last != "посмотри DEV-7" || len(in.Mentions) != 1 || in.Mentions[0]["room"] != pub || !in.More {
		t.Fatalf("inbox: %v %s", isErr, text)
	}

	if text, isErr = call(t, h, "send_message", `{"to":"Анна","text":"привет"}`); isErr || !strings.Contains(text, dm) || !strings.Contains(sent[0], f.ann) {
		t.Fatalf("send to: %v %s %v", isErr, text, sent)
	}
	for _, c := range []struct{ args, want string }{
		{`{"text":"x"}`, "give room or to"},
		{`{"room":"r","to":"ann","text":"x"}`, "not both"},
		{`{"to":"me","text":"x"}`, "another person"},
	} {
		if text, isErr := call(t, h, "send_message", c.args); !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s: %s", c.args, text)
		}
	}

	if _, isErr = call(t, h, "react", `{"message":"m9","emoji":"👍"}`); isErr {
		t.Fatal("react")
	}
	if _, isErr = call(t, h, "react", `{"message":"m9","emoji":"👍","mode":"remove"}`); isErr || strings.Join(sent[len(sent)-2:], ",") != "PUT,DELETE" {
		t.Fatalf("react remove: %v", sent)
	}
	if text, isErr = call(t, h, "react", `{"message":"m8","emoji":"👍"}`); !isErr || !strings.Contains(text, "403 FORBIDDEN") {
		t.Fatalf("react denied: %s", text)
	}
	if text, isErr = call(t, h, "react", `{"message":"m9"}`); !isErr || !strings.Contains(text, "emoji is required") {
		t.Fatalf("react no emoji: %s", text)
	}
}

func TestTaskApprovalChecklistLinks(t *testing.T) {
	f := newTaskFixture()
	other := uuid.NewString()
	f.task.Approvers = []*v1.TaskApprover{{UserId: f.ann, State: v1.ApproverState_APPROVER_STATE_APPROVED}, {UserId: f.me, State: v1.ApproverState_APPROVER_STATE_PENDING}}
	f.task.ApprovalState = v1.TaskApprovalState_TASK_APPROVAL_STATE_PENDING
	f.task.Checklists = []*v1.TaskChecklist{{Id: "cl1", Title: "Релиз", Items: []*v1.TaskChecklistItem{{Id: "i1", Text: "Тесты"}, {Id: "i2", Text: "Changelog", Done: true}}}}
	f.task.Relations = []*v1.TaskRelation{{TaskId: other, RelatedId: f.taskID, Kind: v1.TaskRelationKind_TASK_RELATION_KIND_BLOCKS}}
	otherTask := &v1.Task{Id: other, Key: "DEV-8", BoardId: f.boardID, WorkspaceId: f.ws}
	var calls, bodies []string
	plainBot := false
	fa := f.api(t, func(r *http.Request, b string) (int, proto.Message, bool) {
		k := r.Method + " " + r.URL.Path
		switch k {
		case "GET /api/t/DEV-7", "GET /api/tasks/" + f.taskID:
			return 200, &v1.TaskResponse{Task: proto.Clone(f.task).(*v1.Task), Board: f.board, Related: []*v1.Task{otherTask}}, true
		case "GET /api/t/DEV-8":
			return 200, &v1.TaskResponse{Task: otherTask}, true
		case "POST /api/tasks/" + f.taskID + "/approval":
			if plainBot {
				return 403, forbidden("BOT_NOT_ALLOWED"), true
			}
			bodies = append(bodies, b)
			t2 := proto.Clone(f.task).(*v1.Task)
			t2.Approvers[1].State, t2.Approvers[1].Comment = v1.ApproverState_APPROVER_STATE_REJECTED, "нет тестов"
			t2.ApprovalState = v1.TaskApprovalState_TASK_APPROVAL_STATE_REJECTED
			return 200, &v1.TaskResponse{Task: t2}, true
		case "PATCH /api/checklist-items/i1", "POST /api/checklists/cl1/items", "POST /api/checklists/cl2/items", "POST /api/tasks/" + f.taskID + "/checklists":
			calls, bodies = append(calls, k), append(bodies, b)
			if strings.HasSuffix(k, "/checklists") {
				return 201, &v1.TaskChecklistResponse{Checklist: &v1.TaskChecklist{Id: "cl2", Title: "Чек-лист"}}, true
			}
			return 200, &v1.TaskChecklistResponse{Checklist: f.task.GetChecklists()[0], ChecklistTotal: 2, ChecklistDone: 1}, true
		case "PUT /api/tasks/" + other + "/relations", "DELETE /api/tasks/" + other + "/relations", "PUT /api/tasks/" + f.taskID + "/relations":
			calls, bodies = append(calls, r.URL.String()), append(bodies, b)
			if r.Method == "PUT" && strings.Contains(r.URL.Path, f.taskID) {
				return 422, &v1.ApiError{Code: v1.ErrorCode_ERROR_CODE_VALIDATION, Message: "a task you can see is required", Field: "relatedId"}, true
			}
			return 200, &v1.TaskResponse{Task: otherTask}, true
		}
		return 0, nil, false
	})
	h := New("test")
	h.API = fa

	text, _ := call(t, h, "read", `{"task":"DEV-7"}`)
	if !strings.Contains(text, `"approval":{"approvers":[{"user":"`+f.ann+`","vote":"approved"},{"user":"`+f.me+`","vote":"pending"}],"pending":["`+f.me+`"],"required":2,"state":"pending"}`) ||
		!strings.Contains(text, `"links":[{"key":"DEV-8","kind":"blocked_by","task":"`+other+`"}]`) {
		t.Fatalf("read approval/links: %s", text)
	}

	// approve
	if text, isErr := call(t, h, "approve", `{"task":"DEV-7","decision":"reject"}`); !isErr || !strings.Contains(text, "reason is required") {
		t.Fatalf("reject without reason: %s", text)
	}
	text, isErr := call(t, h, "approve", `{"task":"DEV-7","decision":"reject","reason":"нет тестов"}`)
	var ar v1.TaskApprovalRequest
	_ = unmarshal.Unmarshal([]byte(bodies[0]), &ar)
	if isErr || ar.GetDecision() != v1.TaskApprovalDecision_TASK_APPROVAL_DECISION_REJECT || ar.GetComment() != "нет тестов" ||
		!strings.Contains(text, `"state":"rejected"`) || !strings.Contains(text, `"reason":"нет тестов"`) {
		t.Fatalf("reject: %v %s %v", isErr, text, &ar)
	}
	plainBot = true
	if text, isErr = call(t, h, "approve", `{"task":"DEV-7","decision":"approve"}`); !isErr || !strings.Contains(text, "BOT_NOT_ALLOWED") || !strings.Contains(text, "Calab-On-Behalf") {
		t.Fatalf("plain bot vote: %s", text)
	}
	if text, isErr = call(t, h, "approve", `{"task":"DEV-7","decision":"maybe"}`); !isErr || !strings.Contains(text, "decision must be") {
		t.Fatalf("bad decision: %s", text)
	}

	// checklist
	bodies = nil
	if text, isErr = call(t, h, "checklist", `{"task":"DEV-7","item":"1"}`); isErr || calls[0] != "PATCH /api/checklist-items/i1" || bodies[0] != `{"done":true}` ||
		!strings.Contains(text, `"done":"1/2"`) {
		t.Fatalf("check by number: %v %s %v %v", isErr, text, calls, bodies)
	}
	if _, isErr = call(t, h, "checklist", `{"task":"DEV-7","item":"тест","action":"toggle"}`); isErr || bodies[1] != `{"done":true}` {
		t.Fatalf("toggle by text: %v", bodies)
	}
	if _, isErr = call(t, h, "checklist", `{"task":"DEV-7","action":"add","items":["Демо","Анонс"]}`); isErr || len(calls) != 4 || calls[3] != "POST /api/checklists/cl1/items" {
		t.Fatalf("add: %v", calls)
	}
	if _, isErr = call(t, h, "checklist", `{"task":"DEV-7","action":"add","item":"Ревью","checklist":"Ревью"}`); isErr ||
		calls[4] != "POST /api/tasks/"+f.taskID+"/checklists" || !strings.Contains(bodies[4], `"title":"Ревью"`) || calls[5] != "POST /api/checklists/cl2/items" {
		t.Fatalf("add to a new checklist: %v %v", calls, bodies)
	}
	for _, c := range []struct{ args, want string }{
		{`{"task":"DEV-7","item":"9"}`, "no item 9"},
		{`{"task":"DEV-7","item":"нет такого"}`, "no checklist item"},
		{`{"task":"DEV-7","item":"1","checklist":"Другой"}`, "no checklist"},
		{`{"task":"DEV-7"}`, "item is required"},
		{`{"task":"DEV-7","action":"add"}`, "item or items"},
		{`{"task":"DEV-7","action":"drop","item":"1"}`, "action must be"},
	} {
		if text, isErr := call(t, h, "checklist", c.args); !isErr || !strings.Contains(text, c.want) {
			t.Errorf("%s: %s", c.args, text)
		}
	}

	// links: blocked_by is stored on the other task; the answer shows the task asked about.
	calls = nil
	text, isErr = call(t, h, "link_tasks", `{"task":"DEV-7","related":"DEV-8","kind":"blocked_by"}`)
	if isErr || calls[0] != "/api/tasks/"+other+"/relations" || !strings.Contains(bodies[len(bodies)-1], `"relatedId":"`+f.taskID+`"`) || !strings.Contains(text, `"key":"DEV-7"`) ||
		!strings.Contains(text, "blocked_by") {
		t.Fatalf("link blocked_by: %v %s %v", isErr, text, calls)
	}
	if _, isErr = call(t, h, "link_tasks", `{"task":"DEV-7","related":"DEV-8","kind":"blocked_by","mode":"remove"}`); isErr ||
		calls[1] != "/api/tasks/"+other+"/relations?kind=blocks&related_id="+f.taskID {
		t.Fatalf("unlink: %v", calls)
	}
	if text, isErr = call(t, h, "link_tasks", `{"task":"DEV-7","related":"DEV-8","kind":"duplicates"}`); !isErr || !strings.Contains(text, "422") {
		t.Fatalf("link refused: %s", text)
	}
	if text, isErr = call(t, h, "link_tasks", `{"task":"DEV-7","related":"DEV-8","kind":"parent"}`); !isErr || !strings.Contains(text, "kind must be") {
		t.Fatalf("bad kind: %s", text)
	}
}
