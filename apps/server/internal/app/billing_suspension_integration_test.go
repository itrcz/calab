//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
)

// billingAccount creates the live billing account of ws in status (a debt episode for
// in-arrears / suspended) and returns its id. Money rows are not needed for enforcement.
func billingAccount(t *testing.T, ws, status string, debt bool) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	q := `INSERT INTO billing_accounts (workspace_id, market, currency, provider, plan, status)
VALUES ($1, 'global', 'USD', 'stripe', 'team', $2) RETURNING id`
	if debt {
		q = `INSERT INTO billing_accounts (workspace_id, market, currency, provider, plan, status, negative_since, suspend_at)
VALUES ($1, 'global', 'USD', 'stripe', 'team', $2, now() - interval '1 day', now() + interval '6 days') RETURNING id`
	}
	if err := testDB.Pool.QueryRow(context.Background(), q, ws, status).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { setBillingStatus(t, ws, id, "closed") })
	return id
}

// setBillingStatus moves the account (the core's job in production) and reports the change
// as the core does after commit (plans.Service.BillingChanged).
func setBillingStatus(t *testing.T, ws string, id uuid.UUID, status string) {
	t.Helper()
	if _, err := testDB.Pool.Exec(context.Background(), `UPDATE billing_accounts SET status = $2,
closed_at = CASE WHEN $2 = 'closed' THEN now() END, lapsed_at = CASE WHEN $2 = 'stopped' THEN lapsed_at END WHERE id = $1`, id, status); err != nil {
		t.Fatal(err)
	}
	if err := testApp.Plans.BillingChanged(context.Background(), testDB.Q, events.Redis{C: testRedis}, uuid.MustParse(ws)); err != nil {
		t.Fatal(err)
	}
}

func wantBillingSuspended(t *testing.T, c *client, method, path string, in proto.Message) {
	t.Helper()
	st, e := c.apiErrBody(method, path, in)
	if st != 403 || e.GetCode() != v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED || e.GetReason() != billing.ReasonWorkspaceBillingSuspended {
		t.Fatalf("%s %s: %d %v, want 403 WORKSPACE_SUSPENDED / %s", method, path, st, e, billing.ReasonWorkspaceBillingSuspended)
	}
}

// A billing suspension (ADR-0080 §8, §12) closes the whole workspace — reads too, unlike the
// moderation suspension — for members, admins, bots, guests, RTC, the gateway and every way in.
// The owner keeps the billing routes and the workspace's own metadata. Enforcement off is the
// kill switch; the moderation suspension stays independent of it both ways.
func TestBillingSuspensionEnforcement(t *testing.T) {
	ctx := context.Background()
	withBilling(t, newFakeSeats(), true)
	base := owner(t)
	a, wsPB := wsOwner(t)
	ws := wsPB.GetId()
	m := register(t, invite(t, a, ws))
	room := textRoom(t, a, ws, "Billing", false)
	voice := voiceRoom(t, a, ws, "Voice", 0)
	board := createBoard(t, a, ws, &v1.CreateBoardRequest{Name: "Paid board", Key: "PAID"}, 201)
	send(t, m, room, "before the deadline", uniq("bill-"))
	bot := createBot(t, a, ws, "billbot")
	link := roomLink(t, a, room, &v1.CreateRoomInviteRequest{})
	joinCode := invite(t, a, ws)
	outsider := register(t, invite(t, base, createWorkspace(t, base, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	messages := "/api/rooms/" + room + "/messages"
	var fr v1.BoardFormResponse
	a.must(201, "POST", "/api/boards/"+board.GetId()+"/forms", &v1.CreateBoardFormRequest{Definition: formFixture(board)}, &fr)
	publicForm := "/api/public/forms/" + fr.GetForm().GetUrl()[strings.LastIndex(fr.GetForm().GetUrl(), "/")+1:]

	// In arrears: everything works; Workspace.billing shows the deadline to every member.
	account := billingAccount(t, ws, "active", true)
	testApp.Plans.Invalidate(ctx, uuid.MustParse(ws))
	var gr v1.GetWorkspaceResponse
	m.must(200, "GET", "/api/workspaces/"+ws, nil, &gr)
	if b := gr.GetWorkspace().GetBilling(); b.GetState() != v1.BillingState_BILLING_STATE_IN_ARREARS || b.GetSuspendAt() == nil || b.GetSource() != v1.PlanSource_PLAN_SOURCE_MANUAL {
		t.Fatalf("Workspace.billing in arrears: %v", b)
	}
	m.must(200, "GET", messages, nil, nil)

	// An owner session open before the deadline switches to the paywall live: WORKSPACE_UPDATE
	// with Workspace.billing SUSPENDED (its lease is still valid when the core reports it).
	live := dialGW(t)
	defer func() { _ = live.ws.CloseNow() }()
	live.identify(a.token)
	setBillingStatus(t, ws, account, "suspended")
	live.wait("live WORKSPACE_UPDATE with the suspension", func(e *v1.DispatchEvent) bool {
		w := e.GetWorkspaceUpdate().GetWorkspace()
		return w.GetId() == ws && w.GetBilling().GetState() == v1.BillingState_BILLING_STATE_SUSPENDED
	})
	for _, c := range []*client{m.client, a.client} {
		wantBillingSuspended(t, c, "GET", messages, nil)
		wantBillingSuspended(t, c, "POST", messages, &v1.CreateMessageRequest{Content: "after", Nonce: uniq("n-")})
		wantBillingSuspended(t, c, "GET", "/api/boards/"+board.GetId(), nil)
		wantBillingSuspended(t, c, "POST", "/api/rooms/"+voice+"/join", nil)
		wantBillingSuspended(t, c, "GET", "/api/workspaces/"+ws+"/members", nil)
	}
	if st, _, _ := upload(t, m, "/api/workspaces/"+ws+"/files", "paid.txt", []byte("bytes")); st != 403 {
		t.Fatalf("upload: %d", st)
	}
	// The member: no workspace metadata, no billing (owner only).
	wantBillingSuspended(t, m.client, "GET", "/api/workspaces/"+ws, nil)
	wantBillingSuspended(t, m.client, "GET", "/api/workspaces/"+ws+"/billing", nil)
	// The owner's recovery scope: the workspace and its billing (501 here: BILLING handlers
	// arrive with T5; the policy let the request through).
	gr.Reset()
	a.must(200, "GET", "/api/workspaces/"+ws, nil, &gr)
	if gr.GetWorkspace().GetBilling().GetState() != v1.BillingState_BILLING_STATE_SUSPENDED {
		t.Fatalf("owner's workspace: %v", gr.GetWorkspace().GetBilling())
	}
	for _, p := range [][2]string{{"GET", "/billing"}, {"POST", "/billing/topups"}, {"GET", "/billing/ledger"}} {
		if st, e := a.apiErrBody(p[0], "/api/workspaces/"+ws+p[1], nil); st != 501 || e.GetReason() != billing.ReasonDisabled {
			t.Fatalf("owner %s %s: %d %v", p[0], p[1], st, e)
		}
	}
	// Public forms take no submissions (anonymous reads included).
	wantBillingSuspended(t, newClient(t), "GET", publicForm, nil)
	// Bots: closed (no recovery scope).
	wantBillingSuspended(t, bot.client, "GET", messages, nil)
	// RTC: tokens and the reconciler's identity check refuse every device.
	if testApp.RTC != nil {
		if err := testApp.RTC.IdentityAccess(ctx, uuid.MustParse(ws), uuid.MustParse(voice), uuid.MustParse(m.id), uuid.MustParse(m.session)); err == nil {
			t.Fatal("RTC identity allowed a billing-suspended member")
		}
		if err := testApp.RTC.IdentityAccess(ctx, uuid.MustParse(ws), uuid.MustParse(voice), uuid.MustParse(a.id), uuid.MustParse(a.session)); err == nil {
			t.Fatal("RTC identity allowed the owner")
		}
	}
	// Nobody joins: invitation link, registration by invitation, guest room link.
	wantBillingSuspended(t, outsider.client, "POST", "/api/invites/"+joinCode+"/join", nil)
	wantBillingSuspended(t, newClient(t), "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("late") + "@example.com", Password: "password123", DisplayName: "Late", InviteCode: joinCode, DeviceName: "test"})
	wantBillingSuspended(t, newClient(t), "POST", "/api/room-invites/"+link.GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Guest"})
	// The workspace stays listed for its members as a stub (the client shows the paywall /
	// the notice instead of «create a workspace»): GET /api/workspaces and READY carry only the
	// workspace with Workspace.billing SUSPENDED — no settings, no rooms, no members — and the
	// access status BILLING_SUSPENDED closes the content (the client drops its cache).
	for _, c := range []struct {
		who  *client
		role v1.WorkspaceRole
	}{{m.client, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER}, {a.client, v1.WorkspaceRole_WORKSPACE_ROLE_OWNER}} {
		var list v1.ListWorkspacesResponse
		c.who.must(200, "GET", "/api/workspaces", nil, &list)
		var stub *v1.Workspace
		for _, w := range list.GetWorkspaces() {
			if w.GetId() == ws {
				stub = w
			}
		}
		if stub == nil || stub.GetBilling().GetState() != v1.BillingState_BILLING_STATE_SUSPENDED || stub.GetName() == "" ||
			stub.GetMediaDefaults() != nil || stub.GetStorageUsedBytes() != 0 || stub.GetOwnerId() != a.id {
			t.Fatalf("GET /api/workspaces stub for %v: %v", c.role, stub)
		}
		g := dialGW(t)
		ready := g.identify(c.who.token)
		_ = g.ws.CloseNow()
		var snap *v1.WorkspaceSnapshot
		for _, s := range ready.GetWorkspaces() {
			if s.GetWorkspace().GetId() == ws {
				snap = s
			}
		}
		if snap == nil || snap.GetRole() != c.role || snap.GetWorkspace().GetBilling().GetState() != v1.BillingState_BILLING_STATE_SUSPENDED ||
			len(snap.GetRooms()) != 0 || len(snap.GetMembers()) != 0 || len(snap.GetRoles()) != 0 || snap.GetWorkspace().GetMediaDefaults() != nil {
			t.Fatalf("READY stub for %v: %v", c.role, snap)
		}
		locked := false
		for _, acc := range ready.GetIdentityAccess() {
			locked = locked || (acc.GetWorkspaceId() == ws && acc.GetReason() == v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_BILLING_SUSPENDED)
		}
		if !locked {
			t.Fatalf("READY identity access for %v: %v", c.role, ready.GetIdentityAccess())
		}
		for _, rs := range ready.GetReadStates() {
			if rs.GetRoomId() == room {
				t.Fatal("READY carries a read state of the suspended workspace")
			}
		}
	}
	// An outsider never sees it.
	var outList v1.ListWorkspacesResponse
	outsider.must(200, "GET", "/api/workspaces", nil, &outList)
	for _, w := range outList.GetWorkspaces() {
		if w.GetId() == ws {
			t.Fatal("an outsider lists the suspended workspace")
		}
	}
	g := dialGW(t)
	defer func() { _ = g.ws.CloseNow() }()
	g.identify(m.token)
	// BILLING_UPDATE (content-free) still reaches the owner, so the paywall refreshes after a
	// payment; nothing else of the workspace does, and a member gets nothing of it.
	og := dialGW(t)
	defer func() { _ = og.ws.CloseNow() }()
	og.identify(a.token)
	pub := events.Redis{C: testRedis}
	wsUUID := uuid.MustParse(ws)
	update := &v1.DispatchEvent{Event: &v1.DispatchEvent_BillingUpdate{BillingUpdate: &v1.BillingUpdate{WorkspaceId: ws, Revision: 7}}}
	pub.User(ctx, uuid.MustParse(a.id), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: &v1.Workspace{Id: ws, Name: "leak"}}}})
	pub.User(ctx, uuid.MustParse(a.id), update)
	og.wait("BILLING_UPDATE to the owner", func(e *v1.DispatchEvent) bool { return e.GetBillingUpdate().GetRevision() == 7 })
	pub.User(ctx, uuid.MustParse(m.id), update)
	pub.Workspace(ctx, wsUUID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: &v1.Workspace{Id: ws, Name: "leak"}}}})
	g.quiet("billing data to a member", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetBillingUpdate() != nil || e.GetWorkspaceUpdate().GetWorkspace().GetId() == ws
	})
	og.quiet("workspace data to the owner", 200*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceUpdate().GetWorkspace().GetName() == "leak"
	})

	// Kill switch: enforcement off reopens the workspace at once.
	testApp.SetBilling(newFakeSeats(), true, false)
	m.must(200, "GET", messages, nil, nil)
	testApp.SetBilling(newFakeSeats(), true, true)
	wantBillingSuspended(t, m.client, "GET", messages, nil)

	// Moderation is independent: paying (account active) does not lift a moderation
	// suspension, and a moderation suspension keeps its read-only contract.
	suspend(t, ws, true, "Moderation fixture")
	wantBillingSuspended(t, m.client, "GET", messages, nil) // both: billing closes reads too
	if st, e := a.apiErrBody("POST", "/api/workspaces/"+ws+"/billing/topups", nil); st != 501 {
		t.Fatalf("owner pays under both suspensions: %d %v", st, e)
	}
	setBillingStatus(t, ws, account, "active")
	m.must(200, "GET", messages, nil, nil) // moderation: reads stay
	if st, e := m.apiErrBody("POST", messages, &v1.CreateMessageRequest{Content: "x", Nonce: uniq("n-")}); st != 403 || e.GetCode() != v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED || e.GetReason() != "" {
		t.Fatalf("moderation write: %d %v", st, e)
	}
	suspend(t, ws, false, "")
	m.must(201, "POST", messages, &v1.CreateMessageRequest{Content: "after paying", Nonce: uniq("n-")}, nil)
	// Without enforcement data the gateway brings the workspace back.
	ready := dialGW(t).identify(m.token)
	found := false
	for _, snap := range ready.GetWorkspaces() {
		found = found || snap.GetWorkspace().GetId() == ws
	}
	if !found {
		t.Fatal("resumed workspace missing from READY")
	}
}

// Every classified workspace route goes through the identity policy: under a billing
// suspension a member gets 403 WORKSPACE_BILLING_SUSPENDED on each of them before any payload
// validation, and the owner too except its recovery scope (billing routes, the workspace).
func TestBillingSuspensionRouteInventory(t *testing.T) {
	withBilling(t, newFakeSeats(), true)
	a, wsPB := wsOwner(t)
	ws := wsPB.GetId()
	m := register(t, invite(t, a, ws))
	room := textRoom(t, a, ws, "Inventory", false)
	fixtures := routeFixtures(t, a, m, ws, room)
	billingAccount(t, ws, "suspended", true)
	recovery := func(pattern string) bool {
		return strings.Contains(pattern, "/api/workspaces/{id}/billing") || pattern == "GET /api/workspaces/{id}"
	}
	counts := map[string]int{}
	for _, pattern := range testApp.Routes {
		class := app.IdentityRouteClass(pattern)
		parts := strings.SplitN(pattern, " ", 2)
		if len(parts) != 2 {
			continue
		}
		id, ok := fixtures[class]
		if !ok {
			continue // global, admin, public and specialized routes have no workspace scope here
		}
		method, path := parts[0], strings.ReplaceAll(strings.ReplaceAll(parts[1], "{id}", id), "{appId}", id)
		for _, key := range []string{"userId", "sid", "cid", "rid", "roleId", "inviteId", "bgId", "badgeId", "soundId", "botId", "pmId", "grantId", "fid"} {
			path = strings.ReplaceAll(path, "{"+key+"}", uuid.NewString())
		}
		path = strings.ReplaceAll(path, "{emoji}", "x")
		counts[class]++
		t.Run(pattern, func(t *testing.T) {
			for _, who := range []*user{m, a} {
				c := &client{t: t, token: who.token, ip: who.ip}
				st := c.do(method, path, nil, nil)
				var e v1.ApiError
				_ = protojson.Unmarshal(c.lastBody, &e)
				denied := st == 403 && e.GetReason() == billing.ReasonWorkspaceBillingSuspended
				if who == a && recovery(pattern) {
					if denied {
						t.Fatalf("owner lost its recovery route %s", pattern)
					}
					continue
				}
				if !denied {
					t.Fatalf("%s as %s -> %d %v", pattern, map[bool]string{true: "owner", false: "member"}[who == a], st, &e)
				}
			}
		})
	}
	t.Logf("checked routes by class: %v", counts)
	if counts["workspace"] == 0 || counts["room"] == 0 || counts["message"] == 0 || counts["board"] == 0 || counts["file"] == 0 {
		t.Fatalf("inventory too small: %v", counts)
	}
}

// routeFixtures creates one resource of every identity route class in ws (before suspension).
func routeFixtures(t *testing.T, o, m *user, ws, room string) map[string]string {
	t.Helper()
	ctx := context.Background()
	b := createBoard(t, o, ws, &v1.CreateBoardRequest{Name: "Inventory board", Key: "INV"}, 201)
	task := createTask(t, o, b.Id, &v1.CreateTaskRequest{Title: "Inventory task"}, 201)
	msg := send(t, m, room, "Inventory message", uniq("inv-"))
	_, file, _ := upload(t, m, "/api/workspaces/"+ws+"/files", "inventory.txt", []byte("inventory bytes"))
	wsID := uuid.MustParse(ws)
	category, err := testDB.Q.CreateCategory(ctx, sqlc.CreateCategoryParams{WorkspaceID: wsID, Name: "Inventory category"})
	if err != nil {
		t.Fatal(err)
	}
	pack, err := testDB.Q.InsertStickerPack(ctx, sqlc.InsertStickerPackParams{WorkspaceID: &wsID, Name: "Inventory pack", ShortName: "b" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]})
	if err != nil {
		t.Fatal(err)
	}
	fid := uuid.MustParse(file.Id)
	sticker, err := testDB.Q.InsertSticker(ctx, sqlc.InsertStickerParams{PackID: pack.ID, FileID: &fid, Emoji: "x", Width: 16, Height: 16})
	if err != nil {
		t.Fatal(err)
	}
	event, err := testDB.Q.InsertEvent(ctx, sqlc.InsertEventParams{WorkspaceID: wsID, Title: "Inventory event", StartsAt: time.Now(), EndsAt: time.Now().Add(time.Hour), Tz: "UTC", OrganizerID: uuid.MustParse(m.id)})
	if err != nil {
		t.Fatal(err)
	}
	webapp, err := testDB.Q.InsertWorkspaceApp(ctx, sqlc.InsertWorkspaceAppParams{WorkspaceID: wsID, Name: "Inventory app", Url: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	boardCategory, err := testDB.Q.CreateBoardCategory(ctx, sqlc.CreateBoardCategoryParams{WorkspaceID: wsID, Name: "Inventory board category"})
	if err != nil {
		t.Fatal(err)
	}
	checklist, err := testDB.Q.CreateTaskChecklist(ctx, sqlc.CreateTaskChecklistParams{TaskID: uuid.MustParse(task.Id), Title: "Inventory checklist"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := testDB.Q.CreateChecklistItem(ctx, sqlc.CreateChecklistItemParams{ChecklistID: checklist.ID, TaskID: checklist.TaskID, Text: "Inventory item"})
	if err != nil {
		t.Fatal(err)
	}
	rule, err := testDB.Q.CreateBoardRule(ctx, sqlc.CreateBoardRuleParams{BoardID: uuid.MustParse(b.Id), Name: "Inventory rule",
		Enabled: false, TriggerKind: "task_created", Trigger: []byte(`{"task_created":{}}`), Actions: []byte(`[{"archive":{}}]`)})
	if err != nil {
		t.Fatal(err)
	}
	achievement, err := testDB.Q.InsertAchievement(ctx, sqlc.InsertAchievementParams{WorkspaceID: wsID, Title: "Inventory achievement",
		FileID: &fid, ImageSize: 1, Width: 512, Height: 512})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"achievement": achievement.ID.String(), "rule": rule.ID.String(), "board_category": boardCategory.ID.String(),
		"checklist": checklist.ID.String(), "checklist_item": item.ID.String(), "workspace": ws, "room": room, "message": msg.Id,
		"board": b.Id, "task": task.Id, "file": file.Id, "category": category.ID.String(), "pack": pack.ID.String(),
		"sticker": sticker.ID.String(), "event": event.ID.String(), "app": webapp.ID.String()}
}

// A billing-managed plan follows the paid days: the superadmin's manual plan edit is refused
// with 409 BILLING_PLAN_MANAGED and changes nothing; a manual plan stays editable.
func TestBillingManagedPlanRefusesManualEdit(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()
	setPlan(t, ws, &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, Note: "manual"})
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspace_plans SET source = 'billing' WHERE workspace_id = $1", ws); err != nil {
		t.Fatal(err)
	}
	st, e := superadminUser(t).apiErrBody("PUT", "/api/admin/workspaces/"+ws+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_FREE, Note: "manual edit"})
	if st != 409 || e.GetReason() != billing.ReasonPlanManagedByBilling {
		t.Fatalf("manual edit of a billing plan: %d %v", st, e)
	}
	row, err := testDB.Q.GetWorkspacePlan(context.Background(), uuid.MustParse(ws))
	if err != nil || row.Plan != "team" || row.Source != "billing" {
		t.Fatalf("plan changed: %+v %v", row, err)
	}
}
