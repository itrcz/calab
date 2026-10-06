//go:build integration

package app_test

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Boards 2.0 (ADR-0058): board features (§3) and board categories (§1).

func setFeatures(u musty, boardID string, want int, fs ...v1.BoardFeature) *v1.Board {
	var r v1.BoardResponse
	u.must(want, "PATCH", "/api/boards/"+boardID, &v1.UpdateBoardRequest{SetDisabledFeatures: true, DisabledFeatures: fs}, &r)
	return r.GetBoard()
}

// featureRefused checks the last answer of c is 409 FEATURE_DISABLED naming field.
func featureRefused(t *testing.T, c *client, field string) {
	t.Helper()
	var e v1.ApiError
	_ = protojson.Unmarshal(c.lastBody, &e)
	if e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT || e.GetReason() != "FEATURE_DISABLED" || e.GetField() != field {
		t.Fatalf("answer %v, want FEATURE_DISABLED on %q", &e, field)
	}
}

func lastError(c *client) *v1.ApiError {
	var e v1.ApiError
	_ = protojson.Unmarshal(c.lastBody, &e)
	return &e
}

type req struct {
	method, path string
	body         proto.Message
}

// TestBoardFeatures: each of the 13 features switched off, by a person (REST) and by a bot
// (Bot API, the same handlers): setting a new value of its field is 409 FEATURE_DISABLED with
// the field, repeating the current value and clearing pass, the data is kept and served while
// off and after switching back on; features without a server-side field (checklists — stage 2
// routes, comments — the task room, timeline — client only) do not refuse task writes.
func TestBoardFeatures(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	carol := register(t, invite(t, o, wid))
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Features", Key: "FEA"}, 201)
	if len(b.GetDisabledFeatures()) != 0 || b.GetEstimateScale() != v1.EstimateScale_ESTIMATE_SCALE_FIBONACCI {
		t.Fatalf("new board features %v scale %v", b.GetDisabledFeatures(), b.GetEstimateScale())
	}
	bt := createBot(t, o, wid, "featbot")
	setBoardPerms(o, b.GetId(), 200, userOv(bt.id, perm.ViewBoard|perm.CreateTasks|perm.EditTasks, 0))
	botUser := &user{client: bt.client, id: bt.id}

	o.must(201, "POST", "/api/boards/"+b.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: "L1", Color: 1}, nil)
	o.must(201, "POST", "/api/boards/"+b.GetId()+"/labels", &v1.CreateBoardLabelRequest{Name: "L2", Color: 2}, nil)
	o.must(201, "POST", "/api/boards/"+b.GetId()+"/milestones", &v1.CreateBoardMilestoneRequest{Name: "M1"}, nil)
	var br v1.BoardResponse
	o.must(201, "POST", "/api/boards/"+b.GetId()+"/milestones", &v1.CreateBoardMilestoneRequest{Name: "M2"}, &br)
	l1, l2 := br.GetBoard().GetLabels()[0].GetId(), br.GetBoard().GetLabels()[1].GetId()
	m1, m2 := br.GetBoard().GetMilestones()[0].GetId(), br.GetBoard().GetMilestones()[1].GetId()
	p1 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "parent 1"}, 201).GetId()
	p2 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "parent 2"}, 201).GetId()
	r1 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "related 1"}, 201).GetId()
	r2 := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "related 2"}, 201).GetId()

	actors := []struct {
		name  string
		u     *user
		files []string // own uploads: set, the alternative, create
	}{{name: "rest", u: o}, {name: "bot", u: botUser}}
	for i := range actors {
		for range 3 {
			st, f, _ := upload(t, actors[i].u, "/api/boards/"+b.GetId()+"/files", "spec.png", pngBytes(8, 8))
			if st != 201 {
				t.Fatalf("%s upload %d", actors[i].name, st)
			}
			actors[i].files = append(actors[i].files, f.GetId())
		}
	}

	pick := func(alt bool, a, b string) string {
		if alt {
			return b
		}
		return a
	}
	patch := func(task string, r *v1.UpdateTaskRequest) req { return req{"PATCH", "/api/tasks/" + task, r} }
	u32 := func(v uint32) *uint32 { return &v }
	str := func(v string) *string { return &v }
	prio := func(v v1.TaskPriority) *v1.TaskPriority { return &v }
	type fcase struct {
		f      v1.BoardFeature
		field  string // "" = no task field: writes pass
		set    func(files []string, task string, alt bool) req
		clear  func(files []string, task string) req
		create func(files []string) *v1.CreateTaskRequest
		kept   func(*v1.Task) bool
	}
	cases := []fcase{
		{v1.BoardFeature_BOARD_FEATURE_ESTIMATE, "estimate",
			func(_ []string, tk string, alt bool) req {
				return patch(tk, &v1.UpdateTaskRequest{Estimate: u32(map[bool]uint32{false: 3, true: 5}[alt])})
			},
			func(_ []string, tk string) req { return patch(tk, &v1.UpdateTaskRequest{Estimate: u32(0)}) },
			func([]string) *v1.CreateTaskRequest { return &v1.CreateTaskRequest{Title: "x", Estimate: 3} },
			func(x *v1.Task) bool { return x.GetEstimate() == 3 }},
		{v1.BoardFeature_BOARD_FEATURE_START_DATE, "startOn",
			func(_ []string, tk string, alt bool) req {
				return patch(tk, &v1.UpdateTaskRequest{StartOn: str(pick(alt, "2026-10-01", "2026-10-02"))})
			},
			func(_ []string, tk string) req { return patch(tk, &v1.UpdateTaskRequest{StartOn: str("")}) },
			func([]string) *v1.CreateTaskRequest { return &v1.CreateTaskRequest{Title: "x", StartOn: "2026-10-01"} },
			func(x *v1.Task) bool { return x.GetStartOn() == "2026-10-01" }},
		{v1.BoardFeature_BOARD_FEATURE_DUE_DATE, "dueOn",
			func(_ []string, tk string, alt bool) req {
				return patch(tk, &v1.UpdateTaskRequest{DueOn: str(pick(alt, "2026-12-01", "2026-12-02"))})
			},
			func(_ []string, tk string) req { return patch(tk, &v1.UpdateTaskRequest{DueOn: str("")}) },
			func([]string) *v1.CreateTaskRequest { return &v1.CreateTaskRequest{Title: "x", DueOn: "2026-12-01"} },
			func(x *v1.Task) bool { return x.GetDueOn() == "2026-12-01" }},
		{v1.BoardFeature_BOARD_FEATURE_PRIORITY, "priority",
			func(_ []string, tk string, alt bool) req {
				p := v1.TaskPriority_TASK_PRIORITY_HIGH
				if alt {
					p = v1.TaskPriority_TASK_PRIORITY_URGENT
				}
				return patch(tk, &v1.UpdateTaskRequest{Priority: prio(p)})
			},
			func(_ []string, tk string) req {
				return patch(tk, &v1.UpdateTaskRequest{Priority: prio(v1.TaskPriority_TASK_PRIORITY_NONE)})
			},
			func([]string) *v1.CreateTaskRequest {
				return &v1.CreateTaskRequest{Title: "x", Priority: v1.TaskPriority_TASK_PRIORITY_HIGH}
			},
			func(x *v1.Task) bool { return x.GetPriority() == v1.TaskPriority_TASK_PRIORITY_HIGH }},
		{v1.BoardFeature_BOARD_FEATURE_LABELS, "labelIds",
			func(_ []string, tk string, alt bool) req {
				ids := []string{l1}
				if alt {
					ids = append(ids, l2)
				}
				return patch(tk, &v1.UpdateTaskRequest{SetLabels: true, LabelIds: ids})
			},
			func(_ []string, tk string) req { return patch(tk, &v1.UpdateTaskRequest{SetLabels: true}) },
			func([]string) *v1.CreateTaskRequest { return &v1.CreateTaskRequest{Title: "x", LabelIds: []string{l1}} },
			func(x *v1.Task) bool { return len(x.GetLabelIds()) == 1 }},
		{v1.BoardFeature_BOARD_FEATURE_MILESTONES, "milestoneId",
			func(_ []string, tk string, alt bool) req {
				return patch(tk, &v1.UpdateTaskRequest{MilestoneId: str(pick(alt, m1, m2))})
			},
			func(_ []string, tk string) req { return patch(tk, &v1.UpdateTaskRequest{MilestoneId: str("")}) },
			func([]string) *v1.CreateTaskRequest { return &v1.CreateTaskRequest{Title: "x", MilestoneId: m1} },
			func(x *v1.Task) bool { return x.GetMilestoneId() == m1 }},
		{v1.BoardFeature_BOARD_FEATURE_SUBTASKS, "parentId",
			func(_ []string, tk string, alt bool) req {
				return patch(tk, &v1.UpdateTaskRequest{ParentId: str(pick(alt, p1, p2))})
			},
			func(_ []string, tk string) req { return patch(tk, &v1.UpdateTaskRequest{ParentId: str("")}) },
			func([]string) *v1.CreateTaskRequest { return &v1.CreateTaskRequest{Title: "x", ParentId: p1} },
			func(x *v1.Task) bool { return x.GetParentId() == p1 }},
		{v1.BoardFeature_BOARD_FEATURE_RELATIONS, "relatedId",
			func(_ []string, tk string, alt bool) req {
				return req{"PUT", "/api/tasks/" + tk + "/relations", &v1.SetTaskRelationRequest{
					Kind: v1.TaskRelationKind_TASK_RELATION_KIND_RELATES, RelatedId: pick(alt, r1, r2)}}
			},
			func(_ []string, tk string) req {
				return req{"DELETE", "/api/tasks/" + tk + "/relations?kind=relates&related_id=" + url.QueryEscape(r1), nil}
			},
			nil,
			func(x *v1.Task) bool { return len(x.GetRelations()) == 1 }},
		{v1.BoardFeature_BOARD_FEATURE_APPROVALS, "userIds",
			func(_ []string, tk string, alt bool) req {
				ids := []string{bob.id}
				if alt {
					ids = append(ids, carol.id)
				}
				return req{"PUT", "/api/tasks/" + tk + "/approvers", &v1.SetTaskApproversRequest{UserIds: ids}}
			},
			func(_ []string, tk string) req {
				return req{"PUT", "/api/tasks/" + tk + "/approvers", &v1.SetTaskApproversRequest{}}
			},
			func([]string) *v1.CreateTaskRequest {
				return &v1.CreateTaskRequest{Title: "x", ApproverIds: []string{bob.id}}
			},
			func(x *v1.Task) bool { return len(x.GetApprovers()) == 1 }},
		{f: v1.BoardFeature_BOARD_FEATURE_CHECKLISTS},
		{v1.BoardFeature_BOARD_FEATURE_ATTACHMENTS, "attachmentIds",
			func(fs []string, tk string, alt bool) req {
				ids := fs[:1]
				if alt {
					ids = fs[:2]
				}
				return patch(tk, &v1.UpdateTaskRequest{SetAttachments: true, AttachmentIds: ids})
			},
			func(_ []string, tk string) req { return patch(tk, &v1.UpdateTaskRequest{SetAttachments: true}) },
			func(fs []string) *v1.CreateTaskRequest {
				return &v1.CreateTaskRequest{Title: "x", AttachmentIds: fs[2:3]}
			},
			func(x *v1.Task) bool { return x.GetAttachmentCount() == 1 }},
		{f: v1.BoardFeature_BOARD_FEATURE_COMMENTS},
		{f: v1.BoardFeature_BOARD_FEATURE_TIMELINE},
		{f: v1.BoardFeature_BOARD_FEATURE_FORMS},
		{f: v1.BoardFeature_BOARD_FEATURE_AUTOMATIONS},
		{f: v1.BoardFeature_BOARD_FEATURE_GIT_LINKS},
	}
	if len(cases) != len(v1.BoardFeature_name)-1 {
		t.Fatalf("%d cases for %d features", len(cases), len(v1.BoardFeature_name)-1)
	}
	createField := map[v1.BoardFeature]string{v1.BoardFeature_BOARD_FEATURE_APPROVALS: "approverIds"}
	for _, c := range cases {
		for _, a := range actors {
			name := c.f.String() + "/" + a.name
			// The bot's request budget (30/s burst) is not what this test checks.
			_ = testRedis.Do(context.Background(), testRedis.B().Del().Key(redisx.Key("rl:bot:req:"+bt.id)).Build()).Error()
			tk := createTask(t, a.u, b.GetId(), &v1.CreateTaskRequest{Title: name}, 201).GetId()
			do := func(r req, want int) {
				t.Helper()
				a.u.must(want, r.method, r.path, r.body, nil)
			}
			if c.field != "" {
				do(c.set(a.files, tk, false), 200)
			}
			if got := setFeatures(o, b.GetId(), 200, c.f).GetDisabledFeatures(); len(got) != 1 || got[0] != c.f {
				t.Fatalf("%s: disabled %v", name, got)
			}
			if c.field == "" {
				// No task field: task writes are not refused.
				patchTask(t, a.u, tk, &v1.UpdateTaskRequest{Title: str(name + "!"), Estimate: u32(8), SetLabels: true, LabelIds: []string{l2}}, 200)
				setFeatures(o, b.GetId(), 200)
				continue
			}
			do(c.set(a.files, tk, true), 409)
			featureRefused(t, a.u.client, c.field)
			do(c.set(a.files, tk, false), 200) // the current value again
			if c.create != nil {
				a.u.must(409, "POST", "/api/boards/"+b.GetId()+"/tasks", c.create(a.files), nil)
				field := c.field
				if f, ok := createField[c.f]; ok {
					field = f
				}
				featureRefused(t, a.u.client, field)
			}
			if !c.kept(getTask(t, o, tk).GetTask()) {
				t.Fatalf("%s: data not served while off: %v", name, getTask(t, o, tk).GetTask())
			}
			setFeatures(o, b.GetId(), 200)
			if !c.kept(getTask(t, o, tk).GetTask()) {
				t.Fatalf("%s: data lost after switching on", name)
			}
			setFeatures(o, b.GetId(), 200, c.f)
			do(c.clear(a.files, tk), 200) // clearing is allowed while off
			setFeatures(o, b.GetId(), 200)
		}
	}

	// Board settings: MANAGE_BOARD; unknown features and an unspecified scale are 422.
	bob.must(403, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{SetDisabledFeatures: true}, nil)
	setFeatures(o, b.GetId(), 422, v1.BoardFeature_BOARD_FEATURE_UNSPECIFIED)
	setFeatures(o, b.GetId(), 422, v1.BoardFeature(99))
	unspecified := v1.EstimateScale_ESTIMATE_SCALE_UNSPECIFIED
	o.must(422, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{EstimateScale: &unspecified}, nil)
	if got := setFeatures(o, b.GetId(), 200, v1.BoardFeature_BOARD_FEATURE_TIMELINE, v1.BoardFeature_BOARD_FEATURE_ESTIMATE).GetDisabledFeatures(); len(got) != 2 ||
		got[0] != v1.BoardFeature_BOARD_FEATURE_ESTIMATE || got[1] != v1.BoardFeature_BOARD_FEATURE_TIMELINE {
		t.Fatalf("disabled set %v", got)
	}
	setFeatures(o, b.GetId(), 200)

	// The estimate scale: writes off the scale are 422; tasks keep their values.
	big := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "big", Estimate: 21}, 201).GetId()
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "x", Estimate: 4}, 422)
	scale := func(s v1.EstimateScale) {
		var r v1.BoardResponse
		o.must(200, "PATCH", "/api/boards/"+b.GetId(), &v1.UpdateBoardRequest{EstimateScale: &s}, &r)
		if r.GetBoard().GetEstimateScale() != s {
			t.Fatalf("scale %v", r.GetBoard().GetEstimateScale())
		}
	}
	scale(v1.EstimateScale_ESTIMATE_SCALE_LINEAR)
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "x", Estimate: 13}, 422)
	if lastError(o.client).GetField() != "estimate" {
		t.Fatalf("scale refusal %v", lastError(o.client))
	}
	createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "x", Estimate: 4}, 201)
	patchTask(t, o, big, &v1.UpdateTaskRequest{Estimate: u32(21), Title: str("still big")}, 200) // unchanged value off the scale
	patchTask(t, botUser, big, &v1.UpdateTaskRequest{Estimate: u32(13)}, 422)
	scale(v1.EstimateScale_ESTIMATE_SCALE_TSHIRT)
	patchTask(t, o, big, &v1.UpdateTaskRequest{Estimate: u32(4)}, 422)
	if getTask(t, o, big).GetTask().GetEstimate() != 21 {
		t.Fatal("a scale change rewrote the task")
	}
	patchTask(t, o, big, &v1.UpdateTaskRequest{Estimate: u32(8)}, 200)

	// APPROVALS off: the gate does not hold the task, votes are refused (withdrawing passes),
	// no reminders; the votes are kept.
	done := statusOf(b, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	gated := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "gated", ApproverIds: []string{bob.id, carol.id}}, 201).GetId()
	voteTask(carol, gated, 200, approve, "")
	patchTask(t, o, gated, &v1.UpdateTaskRequest{StatusId: &done}, 409)
	setFeatures(o, b.GetId(), 200, v1.BoardFeature_BOARD_FEATURE_APPROVALS)
	voteTask(bob, gated, 409, approve, "")
	featureRefused(t, bob.client, "decision")
	voteTask(carol, gated, 200, withdraw, "")
	ctx := context.Background()
	if _, err := testDB.Pool.Exec(ctx, "UPDATE task_approvers SET requested_at = now() - interval '25 hours' WHERE task_id = $1", gated); err != nil {
		t.Fatal(err)
	}
	if _, err := testApp.Boards.Remind(ctx); err != nil {
		t.Fatal(err)
	}
	var reminded int
	if err := testDB.Pool.QueryRow(ctx, "SELECT coalesce(sum(reminders), 0) FROM task_approvers WHERE task_id = $1", gated).Scan(&reminded); err != nil || reminded != 0 {
		t.Fatalf("reminders with APPROVALS off: %d %v", reminded, err)
	}
	if got := patchTask(t, o, gated, &v1.UpdateTaskRequest{StatusId: &done, Description: str("changed")}, 200); len(got.GetApprovers()) != 2 {
		t.Fatalf("approvers lost: %v", got.GetApprovers())
	}
	setFeatures(o, b.GetId(), 200)
	if _, err := testApp.Boards.Remind(ctx); err != nil {
		t.Fatal(err)
	}

	// Moving to a board with other features is allowed; the fields stay.
	lean := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Lean", Key: "LEA"}, 201)
	setFeatures(o, lean.GetId(), 200, v1.BoardFeature_BOARD_FEATURE_DUE_DATE, v1.BoardFeature_BOARD_FEATURE_APPROVALS)
	mv := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "moving", DueOn: "2026-12-24", ApproverIds: []string{bob.id}}, 201).GetId()
	patchTask(t, o, mv, &v1.UpdateTaskRequest{BoardId: str(lean.GetId())}, 200)
	if got := getTask(t, o, mv).GetTask(); got.GetBoardId() != lean.GetId() || got.GetDueOn() != "2026-12-24" || len(got.GetApprovers()) != 1 {
		t.Fatalf("moved task %v", got)
	}
	// Approved task held on the source board is not held into COMPLETED on the target (gate off).
	leanDone := statusOf(lean, v1.BoardStatusType_BOARD_STATUS_TYPE_COMPLETED)
	patchTask(t, o, mv, &v1.UpdateTaskRequest{StatusId: &leanDone}, 200)
}

// TestBoardTaskCommentsOff: COMMENTS off makes the task room read-only (like an archived task):
// posting is 403 for people and bots, reading stays, EDIT_TASKS still moderates; no
// MESSAGE_CREATE reaches the board's viewers.
func TestBoardTaskCommentsOff(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	b := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Quiet", Key: "QUI"}, 201)
	bt := createBot(t, o, wid, "quietbot")
	tk := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "без обсуждений"}, 201)
	room := tk.GetRoomId()
	m := send(t, bob, room, "до выключения", uniq("c"))

	gb := dialGW(t)
	gb.identify(bob.token)
	setFeatures(o, b.GetId(), 200, v1.BoardFeature_BOARD_FEATURE_COMMENTS)
	gb.wait("BOARD_UPDATE with comments off", func(e *v1.DispatchEvent) bool {
		fs := e.GetBoardUpdate().GetBoard().GetDisabledFeatures()
		return e.GetBoardUpdate().GetBoard().GetId() == b.GetId() && len(fs) == 1 && fs[0] == v1.BoardFeature_BOARD_FEATURE_COMMENTS
	})
	bob.must(403, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "нельзя", Nonce: uniq("n")}, nil)
	o.must(403, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "и владельцу", Nonce: uniq("n")}, nil)
	bt.must(403, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "и боту", Nonce: uniq("n")}, nil)
	gb.quiet("MESSAGE_CREATE in a room with comments off", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetRoomId() == room
	})
	var list v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+room+"/messages", nil, &list)
	if len(list.GetMessages()) != 1 {
		t.Fatalf("old comments %v", list.GetMessages())
	}
	o.must(204, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil) // MANAGE_MESSAGES of EDIT_TASKS
	bob.must(403, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	// Task writes are not refused; switching back on opens the room.
	patchTask(t, o, tk.GetId(), &v1.UpdateTaskRequest{Description: func() *string { s := "ok"; return &s }()}, 200)
	setFeatures(o, b.GetId(), 200)
	m2 := send(t, bob, room, "снова можно", uniq("c"))
	gb.wait("MESSAGE_CREATE after switching on", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == m2.GetId() })
}

func createCategory(t *testing.T, u musty, wsID string, req *v1.CreateBoardCategoryRequest, want int) *v1.BoardCategory {
	t.Helper()
	var r v1.BoardCategoryResponse
	u.must(want, "POST", "/api/workspaces/"+wsID+"/board-categories", req, &r)
	return r.GetCategory()
}

func listCategories(t *testing.T, u musty, wsID string) []*v1.BoardCategory {
	t.Helper()
	var r v1.ListBoardCategoriesResponse
	u.must(200, "GET", "/api/workspaces/"+wsID+"/board-categories", nil, &r)
	return r.GetCategories()
}

func categoryIDs(cs []*v1.BoardCategory) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.GetId()
	}
	return out
}

// TestBoardCategories: CRUD and ordering with CREATE_BOARDS, placing boards with MANAGE_BOARD in
// one transaction, deleting a category (its boards go uncategorized at the end), events to
// members but never guests, READY; a private / closed board is not revealed by a category or by
// the order endpoint.
func TestBoardCategories(t *testing.T) {
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()
	gb := dialGW(t)
	if ready := gb.identify(bob.token); len(ready.GetWorkspaces()[0].GetBoardCategories()) != 0 {
		t.Fatal("categories in READY of a new workspace")
	}
	// A guest: no list, no events.
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+voice.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	anon := &client{t: t, ip: "10.66.1.1"}
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := &user{client: &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.66.1.2"}, id: gj.GetMe().GetUser().GetId()}
	gg := dialGW(t)
	gg.identify(guest.token)

	// CRUD: CREATE_BOARDS (members do not have it by default); positions; validation.
	createCategory(t, bob, wid, &v1.CreateBoardCategoryRequest{Name: "Нельзя"}, 403)
	c1 := createCategory(t, o, wid, &v1.CreateBoardCategoryRequest{Name: "Разработка"}, 201)
	gb.wait("BOARD_CATEGORY_CREATE", func(e *v1.DispatchEvent) bool { return e.GetBoardCategoryCreate().GetCategory().GetId() == c1.GetId() })
	gg.quiet("a category event to a guest", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetBoardCategoryCreate() != nil })
	c2 := createCategory(t, o, wid, &v1.CreateBoardCategoryRequest{Name: "Маркетинг"}, 201)
	zero := int32(0)
	c0 := createCategory(t, o, wid, &v1.CreateBoardCategoryRequest{Name: "Первая", Position: &zero}, 201)
	if c0.GetPosition() != 0 || c2.GetPosition() != 1 {
		t.Fatalf("positions %v %v", c0, c2)
	}
	gb.wait("the shifted category", func(e *v1.DispatchEvent) bool {
		return e.GetBoardCategoryUpdate().GetCategory().GetId() == c2.GetId() && e.GetBoardCategoryUpdate().GetCategory().GetPosition() == 2
	})
	if ids := categoryIDs(listCategories(t, bob, wid)); len(ids) != 3 || ids[0] != c0.GetId() || ids[1] != c1.GetId() || ids[2] != c2.GetId() {
		t.Fatalf("order %v", ids)
	}
	createCategory(t, o, wid, &v1.CreateBoardCategoryRequest{Name: " "}, 422)
	guest.must(403, "GET", "/api/workspaces/"+wid+"/board-categories", nil, nil)
	name := "Разработка 2"
	var ur v1.BoardCategoryResponse
	bob.must(403, "PATCH", "/api/board-categories/"+c1.GetId(), &v1.UpdateBoardCategoryRequest{Name: &name}, nil)
	o.must(200, "PATCH", "/api/board-categories/"+c1.GetId(), &v1.UpdateBoardCategoryRequest{Name: &name, Position: &zero}, &ur)
	if ur.GetCategory().GetName() != name || ur.GetCategory().GetPosition() != 0 {
		t.Fatalf("updated %v", ur.GetCategory())
	}
	gb.wait("BOARD_CATEGORY_UPDATE", func(e *v1.DispatchEvent) bool {
		return e.GetBoardCategoryUpdate().GetCategory().GetName() == name
	})
	o.must(404, "PATCH", "/api/board-categories/"+uuid.NewString(), &v1.UpdateBoardCategoryRequest{Name: &name}, nil)

	// Boards: a public one bob sees, a private and a closed one he does not.
	pub := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Pub", Key: "PUB"}, 201)
	priv := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Priv", Key: "PRV", IsPrivate: true}, 201)
	closed := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Closed", Key: "CLS", IsPrivate: true}, 201)
	restricted := true
	o.must(200, "PATCH", "/api/boards/"+closed.GetId(), &v1.UpdateBoardRequest{Restricted: &restricted}, nil)
	hidden := func(e *v1.DispatchEvent) bool {
		id := e.GetBoardUpdate().GetBoard().GetId() + e.GetBoardCreate().GetBoard().GetId()
		return id == priv.GetId() || id == closed.GetId()
	}
	var or v1.SetBoardOrderResponse
	o.must(200, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Boards: []*v1.SetBoardOrderRequest_BoardPosition{
			{BoardId: pub.GetId(), CategoryId: c2.GetId(), Position: 0},
			{BoardId: priv.GetId(), CategoryId: c2.GetId(), Position: 1},
			{BoardId: closed.GetId(), CategoryId: c2.GetId(), Position: 2},
		},
		Categories: []*v1.SetBoardOrderRequest_CategoryPosition{{CategoryId: c2.GetId(), Position: 0}, {CategoryId: c1.GetId(), Position: 1}, {CategoryId: c0.GetId(), Position: 2}},
	}, &or)
	if len(or.GetBoards()) != 3 || len(or.GetCategories()) != 3 || or.GetCategories()[0].GetId() != c2.GetId() {
		t.Fatalf("order answer %v", &or)
	}
	for _, b := range or.GetBoards() {
		if b.GetCategoryId() != c2.GetId() {
			t.Fatalf("board %s not in the category", b.GetKey())
		}
	}
	gb.wait("BOARD_UPDATE of the public board", func(e *v1.DispatchEvent) bool {
		return e.GetBoardUpdate().GetBoard().GetId() == pub.GetId() && e.GetBoardUpdate().GetBoard().GetCategoryId() == c2.GetId()
	})
	gb.quiet("a hidden board through a category", 300*time.Millisecond, hidden)
	if bs := listBoards(t, bob, wid); len(bs) != 1 || bs[pub.GetId()].GetCategoryId() != c2.GetId() {
		t.Fatalf("bob's boards %v", bs)
	}

	// The order endpoint does not reveal: a hidden board answers like a missing one.
	bob.must(403, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Boards: []*v1.SetBoardOrderRequest_BoardPosition{{BoardId: pub.GetId(), Position: 1}}}, nil) // no MANAGE_BOARD
	bob.must(422, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Boards: []*v1.SetBoardOrderRequest_BoardPosition{{BoardId: closed.GetId(), Position: 0}}}, nil)
	hiddenErr := lastError(bob.client)
	bob.must(422, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Boards: []*v1.SetBoardOrderRequest_BoardPosition{{BoardId: uuid.NewString(), Position: 0}}}, nil)
	if missing := lastError(bob.client); missing.GetMessage() != hiddenErr.GetMessage() || missing.GetField() != hiddenErr.GetField() {
		t.Fatalf("hidden %v vs missing %v", hiddenErr, missing)
	}
	bob.must(403, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Categories: []*v1.SetBoardOrderRequest_CategoryPosition{{CategoryId: c0.GetId(), Position: 0}}}, nil)
	// Another workspace's board and category are 422, the whole drag is rolled back.
	o2ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	foreign := createBoard(t, o, o2ws.GetId(), &v1.CreateBoardRequest{Name: "Foreign", Key: "FOR"}, 201)
	foreignCat := createCategory(t, o, o2ws.GetId(), &v1.CreateBoardCategoryRequest{Name: "Чужая"}, 201)
	o.must(422, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Boards: []*v1.SetBoardOrderRequest_BoardPosition{{BoardId: foreign.GetId(), Position: 0}}}, nil)
	o.must(422, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Boards:     []*v1.SetBoardOrderRequest_BoardPosition{{BoardId: pub.GetId(), CategoryId: foreignCat.GetId(), Position: 5}},
		Categories: []*v1.SetBoardOrderRequest_CategoryPosition{{CategoryId: c0.GetId(), Position: 7}}}, nil)
	if cs := listCategories(t, o, wid); cs[2].GetId() != c0.GetId() || cs[2].GetPosition() != 2 {
		t.Fatalf("a refused drag changed the order: %v", cs)
	}
	o.must(422, "PUT", "/api/workspaces/"+wid+"/boards/order", &v1.SetBoardOrderRequest{
		Categories: []*v1.SetBoardOrderRequest_CategoryPosition{{CategoryId: foreignCat.GetId(), Position: 0}}}, nil)

	// PUT /boards/{id}/position with category_id: into a category, then out of it.
	var pr v1.BoardResponse
	pos0 := &v1.SetBoardPositionRequest{Position: 0, CategoryId: func() *string { s := c0.GetId(); return &s }()}
	bob.must(403, "PUT", "/api/boards/"+pub.GetId()+"/position", pos0, nil)
	o.must(200, "PUT", "/api/boards/"+pub.GetId()+"/position", pos0, &pr)
	if pr.GetBoard().GetCategoryId() != c0.GetId() || pr.GetBoard().GetPosition() != 0 {
		t.Fatalf("placed %v", pr.GetBoard())
	}
	gb.wait("BOARD_UPDATE into c0", func(e *v1.DispatchEvent) bool {
		return e.GetBoardUpdate().GetBoard().GetId() == pub.GetId() && e.GetBoardUpdate().GetBoard().GetCategoryId() == c0.GetId()
	})
	o.must(422, "PUT", "/api/boards/"+pub.GetId()+"/position", &v1.SetBoardPositionRequest{CategoryId: func() *string { s := foreignCat.GetId(); return &s }()}, nil)

	// Delete: the boards go uncategorized after the ones already there; BOARD_UPDATE only to
	// those who see them; BOARD_CATEGORY_DELETE to every member but guests.
	loose := createBoard(t, o, wid, &v1.CreateBoardRequest{Name: "Loose", Key: "LOO"}, 201)
	bob.must(403, "DELETE", "/api/board-categories/"+c2.GetId(), nil, nil)
	o.must(204, "DELETE", "/api/board-categories/"+c2.GetId(), nil, nil)
	gb.wait("BOARD_CATEGORY_DELETE", func(e *v1.DispatchEvent) bool { return e.GetBoardCategoryDelete().GetCategoryId() == c2.GetId() })
	gb.quiet("a hidden board after the category went", 300*time.Millisecond, hidden)
	gg.quiet("a category event to a guest", 100*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetBoardCategoryDelete() != nil || e.GetBoardCategoryUpdate() != nil || e.GetBoardCategoryCreate() != nil
	})
	all := listBoards(t, o, wid)
	if all[priv.GetId()].GetCategoryId() != "" || all[closed.GetId()].GetCategoryId() != "" ||
		all[priv.GetId()].GetPosition() <= all[loose.GetId()].GetPosition() || all[closed.GetId()].GetPosition() <= all[priv.GetId()].GetPosition() {
		t.Fatalf("after delete: priv %v closed %v loose %v", all[priv.GetId()], all[closed.GetId()], all[loose.GetId()])
	}
	o.must(404, "DELETE", "/api/board-categories/"+c2.GetId(), nil, nil)

	// READY: members get the categories, guests none.
	if ready := dialGW(t).identify(bob.token); len(ready.GetWorkspaces()[0].GetBoardCategories()) != 2 {
		t.Fatalf("READY categories %v", ready.GetWorkspaces()[0].GetBoardCategories())
	}
	if ready := dialGW(t).identify(guest.token); len(ready.GetWorkspaces()[0].GetBoardCategories()) != 0 {
		t.Fatal("guest READY has board categories")
	}

	// Bots: reading like members; managing with CREATE_BOARDS only.
	bt := createBot(t, o, wid, "catbot")
	if len(listCategories(t, bt, wid)) != 2 {
		t.Fatal("bot list")
	}
	createCategory(t, bt, wid, &v1.CreateBoardCategoryRequest{Name: "Бот"}, 403)

	// The limit: 50 per workspace.
	for i := len(listCategories(t, o, wid)); i < 50; i++ {
		createCategory(t, o, wid, &v1.CreateBoardCategoryRequest{Name: uniq("c")}, 201)
	}
	createCategory(t, o, wid, &v1.CreateBoardCategoryRequest{Name: "51"}, 409)
	if r, _ := errReason(o.client); r != "BOARD_CATEGORY_LIMIT" {
		t.Fatalf("limit reason %q", r)
	}
}
