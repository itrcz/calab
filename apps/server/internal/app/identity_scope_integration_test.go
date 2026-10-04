//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
)

type identityFixture struct {
	local         *user
	scoped        *user
	a, b          *v1.Workspace
	roomA, roomB  string
	connection    sqlc.WorkspaceIdentityConnection
	external      sqlc.WorkspaceExternalIdentity
	scopedSession sqlc.Session
}

func identitySetup(t *testing.T, mode string) identityFixture {
	t.Helper()
	ctx := context.Background()
	o := owner(t)
	a := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, a.GetId()))
	u.must(200, "POST", "/api/invites/"+invite(t, o, b.GetId())+"/join", nil, nil)
	var roomA, roomB v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+a.Id+"/rooms", &v1.CreateRoomRequest{Name: "Identity A", Type: v1.RoomType_ROOM_TYPE_TEXT}, &roomA)
	o.must(201, "POST", "/api/workspaces/"+b.Id+"/rooms", &v1.CreateRoomRequest{Name: "Identity B", Type: v1.RoomType_ROOM_TYPE_TEXT}, &roomB)
	ra, rb := roomA.Room.Id, roomB.Room.Id
	ws, uid := uuid.MustParse(a.GetId()), uuid.MustParse(u.id)
	if _, err := testDB.Q.UpsertWorkspacePlan(ctx, sqlc.UpsertWorkspacePlanParams{WorkspaceID: ws, Plan: "enterprise", Limits: []byte("{}")}); err != nil {
		t.Fatal(err)
	}
	for _, feature := range []identitypolicy.Feature{identitypolicy.SSO, identitypolicy.DirectorySync, identitypolicy.OAuthProvider} {
		if _, err := testDB.Q.UpsertIdentityGrant(ctx, sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: string(feature), Enabled: true, Source: "cloud_business"}); err != nil {
			t.Fatal(err)
		}
	}
	policy, err := testDB.Q.EnsureIdentityPolicy(ctx, ws)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = testDB.Q.SetIdentityPolicy(ctx, sqlc.SetIdentityPolicyParams{WorkspaceID: ws, Mode: mode, AssuranceMaxAgeSeconds: 3600, ExpectedVersion: policy.Version}); err != nil {
		t.Fatal(err)
	}
	conn, err := testDB.Q.CreateIdentityConnection(ctx, sqlc.CreateIdentityConnectionParams{WorkspaceID: ws, Name: "Fixture", Provider: "generic", Issuer: "https://issuer.identity.test", ClientID: "fixture", Status: "draft", Scopes: []string{"openid"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = testDB.Q.MarkIdentityConnectionTested(ctx, sqlc.MarkIdentityConnectionTestedParams{WorkspaceID: ws, ID: conn.ID, Version: conn.Version}); err != nil {
		t.Fatal(err)
	}
	conn, err = testDB.Q.ActivateIdentityConnection(ctx, sqlc.ActivateIdentityConnectionParams{WorkspaceID: ws, ID: conn.ID, Version: conn.Version})
	if err != nil {
		t.Fatal(err)
	}
	ext, err := testDB.Q.CreateExternalIdentity(ctx, sqlc.CreateExternalIdentityParams{WorkspaceID: ws, ConnectionID: conn.ID, UserID: uid, Issuer: conn.Issuer, Subject: uuid.NewString(), Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	secret, hash, err := auth.NewRefreshSecret()
	if err != nil {
		t.Fatal(err)
	}
	session, err := testDB.Q.CreateScopedIdentitySession(ctx, sqlc.CreateScopedIdentitySessionParams{UserID: uid, RefreshTokenHash: hash, ExpiresAt: time.Now().Add(time.Hour), AuthorityKind: "workspace_sso", AuthorityWorkspaceID: &ws, AuthorityConnectionID: &conn.ID})
	if err != nil {
		t.Fatal(err)
	}
	f := identityFixture{local: u, a: a, b: b, roomA: ra, roomB: rb, connection: conn, external: ext, scopedSession: session}
	f.prove(t, session.ID, time.Now())
	pair, err := testApp.Auth.IssueIdentityTokens(ctx, testDB.Q, session, secret)
	if err != nil {
		t.Fatal(err)
	}
	f.scoped = &user{client: &client{t: t, token: pair.AccessToken, ip: "10.77.0.1"}, id: u.id, session: session.ID.String(), refresh: pair.RefreshToken, email: u.email}
	return f
}

func (f identityFixture) prove(t *testing.T, sid uuid.UUID, at time.Time) {
	t.Helper()
	ctx := context.Background()
	ws, uid := uuid.MustParse(f.a.GetId()), uuid.MustParse(f.local.id)
	state, err := identitypolicy.NewSQLLoader(testDB.Q, testCfg.IdentityEntitlements()).LoadIdentityState(ctx, sid, uid, ws)
	if err != nil {
		t.Fatal(err)
	}
	_, err = testDB.Q.UpsertWorkspaceAssurance(ctx, sqlc.UpsertWorkspaceAssuranceParams{WorkspaceID: ws, SessionID: sid, UserID: uid, ConnectionID: f.connection.ID, IdentityID: f.external.ID, AuthenticatedAt: at, ValidUntil: at.Add(time.Hour), PolicyVersion: state.Policy.Version, AccessVersion: state.AccessVersion, ConnectionVersion: f.connection.Version, IdentityVersion: f.external.Version, SessionVersion: state.Principal.Version, EntitlementVersion: state.EntitlementVersion})
	if err != nil {
		t.Fatal(err)
	}
}

func TestIdentityAuthorityAndStepUp(t *testing.T) {
	f := identitySetup(t, "enforced")
	f.scoped.must(200, "GET", "/api/rooms/"+f.roomA, nil, nil)
	f.scoped.must(403, "GET", "/api/rooms/"+f.roomB, nil, nil)
	var denied v1.ApiError
	f.local.must(403, "GET", "/api/rooms/"+f.roomA, nil, nil)
	if err := protojson.Unmarshal(f.local.lastBody, &denied); err != nil {
		t.Fatal(err)
	}
	if denied.Code != v1.ErrorCode_ERROR_CODE_SSO_REQUIRED {
		t.Fatalf("local bypass error: %v", &denied)
	}
	f.local.must(200, "GET", "/api/rooms/"+f.roomB, nil, nil)
	var me v1.GetMeResponse
	f.scoped.must(200, "GET", "/api/me", nil, &me)
	if me.Me.IsSuperadmin || me.Me.Email != "" || me.Me.Settings != nil {
		t.Fatalf("scoped profile leak: %v", &me)
	}
	var list v1.ListWorkspacesResponse
	f.scoped.must(200, "GET", "/api/workspaces", nil, &list)
	if len(list.Workspaces) != 1 || list.Workspaces[0].Id != f.a.Id {
		t.Fatalf("scoped workspace leak: %v", &list)
	}
	f.local.must(200, "GET", "/api/workspaces", nil, &list)
	for _, w := range list.Workspaces {
		if w.Id == f.a.Id {
			t.Fatal("enforced A disclosed before step-up")
		}
	}
	f.prove(t, uuid.MustParse(f.local.session), time.Now())
	f.local.must(200, "GET", "/api/rooms/"+f.roomA, nil, nil)
	if _, err := testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: uuid.MustParse(f.a.Id), SessionID: &f.scopedSession.ID}); err != nil {
		t.Fatal(err)
	}
	f.scoped.must(403, "GET", "/api/rooms/"+f.roomA, nil, nil)
	f.local.must(200, "GET", "/api/rooms/"+f.roomA, nil, nil) // independent proof survives
	f.local.must(200, "GET", "/api/rooms/"+f.roomB, nil, nil)
}

func TestIdentityRouteInventoryAndCrossWorkspace(t *testing.T) {
	f := identitySetup(t, "enforced")
	b := createBoard(t, owner(t), f.b.Id, &v1.CreateBoardRequest{Name: "Denied board", Key: "DENY"}, 201)
	task := createTask(t, owner(t), b.Id, &v1.CreateTaskRequest{Title: "Denied task"}, 201)
	msg := send(t, f.local, f.roomB, "Forbidden content", uniq("identity-"))
	_, file, _ := upload(t, f.local, "/api/workspaces/"+f.b.Id+"/files", "identity.txt", []byte("forbidden bytes"))

	ws := uuid.MustParse(f.b.Id)
	category, err := testDB.Q.CreateCategory(context.Background(), sqlc.CreateCategoryParams{WorkspaceID: ws, Name: "Denied category"})
	if err != nil {
		t.Fatal(err)
	}
	pack, err := testDB.Q.InsertStickerPack(context.Background(), sqlc.InsertStickerPackParams{WorkspaceID: &ws, Name: "Denied pack", ShortName: "i" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16]})
	if err != nil {
		t.Fatal(err)
	}
	fid := uuid.MustParse(file.Id)
	sticker, err := testDB.Q.InsertSticker(context.Background(), sqlc.InsertStickerParams{PackID: pack.ID, FileID: &fid, Emoji: "x", Width: 16, Height: 16})
	if err != nil {
		t.Fatal(err)
	}
	event, err := testDB.Q.InsertEvent(context.Background(), sqlc.InsertEventParams{WorkspaceID: ws, Title: "Denied event", StartsAt: time.Now(), EndsAt: time.Now().Add(time.Hour), Tz: "UTC", OrganizerID: uuid.MustParse(f.local.id)})
	if err != nil {
		t.Fatal(err)
	}
	webapp, err := testDB.Q.InsertWorkspaceApp(context.Background(), sqlc.InsertWorkspaceAppParams{WorkspaceID: ws, Name: "Denied app", Url: "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	boardCategory, err := testDB.Q.CreateBoardCategory(context.Background(), sqlc.CreateBoardCategoryParams{WorkspaceID: ws, Name: "Denied board category"})
	if err != nil {
		t.Fatal(err)
	}
	checklist, err := testDB.Q.CreateTaskChecklist(context.Background(), sqlc.CreateTaskChecklistParams{TaskID: uuid.MustParse(task.Id), Title: "Denied checklist"})
	if err != nil {
		t.Fatal(err)
	}
	item, err := testDB.Q.CreateChecklistItem(context.Background(), sqlc.CreateChecklistItemParams{ChecklistID: checklist.ID, TaskID: checklist.TaskID, Text: "Denied item"})
	if err != nil {
		t.Fatal(err)
	}
	rule, err := testDB.Q.CreateBoardRule(context.Background(), sqlc.CreateBoardRuleParams{BoardID: uuid.MustParse(b.Id), Name: "Denied rule",
		Enabled: false, TriggerKind: "task_created", Trigger: []byte(`{"task_created":{}}`), Actions: []byte(`[{"archive":{}}]`)})
	if err != nil {
		t.Fatal(err)
	}
	achievement, err := testDB.Q.InsertAchievement(context.Background(), sqlc.InsertAchievementParams{WorkspaceID: ws, Title: "Denied achievement",
		FileID: &fid, ImageSize: 1, Width: 512, Height: 512})
	if err != nil {
		t.Fatal(err)
	}
	fixtures := map[string]string{"achievement": achievement.ID.String(), "rule": rule.ID.String(), "board_category": boardCategory.ID.String(), "checklist": checklist.ID.String(), "checklist_item": item.ID.String(), "workspace": f.b.Id, "room": f.roomB, "message": msg.Id, "board": b.Id, "task": task.Id, "file": file.Id, "category": category.ID.String(), "pack": pack.ID.String(), "sticker": sticker.ID.String(), "event": event.ID.String(), "app": webapp.ID.String()}
	counts := map[string]int{}
	for _, pattern := range testApp.Routes {
		if !app.IdentityRouteCovered(pattern) {
			t.Fatalf("unclassified registered route %s", pattern)
		}
		class := app.IdentityRouteClass(pattern)
		counts[class]++
		parts := strings.SplitN(pattern, " ", 2)
		if len(parts) != 2 {
			continue
		}
		method, path := parts[0], parts[1]
		switch class {
		case "global", "admin":
		case "workspace", "room", "message", "board", "task", "file", "category", "pack", "sticker", "event", "app", "board_category", "checklist", "checklist_item", "rule", "achievement":
			path = strings.ReplaceAll(path, "{id}", fixtures[class])
			path = strings.ReplaceAll(path, "{appId}", fixtures[class])
		default:
			continue
		}
		for _, key := range []string{"id", "userId", "sid", "cid", "rid", "roleId", "inviteId", "bgId", "badgeId", "soundId", "botId"} {
			path = strings.ReplaceAll(path, "{"+key+"}", uuid.NewString())
		}
		path = strings.ReplaceAll(path, "{emoji}", "x")
		t.Run(pattern, func(t *testing.T) {
			c := &client{t: t, token: f.scoped.token, ip: f.scoped.ip}
			var e v1.ApiError
			status := c.do(method, path, nil, nil)
			_ = protojson.Unmarshal(c.lastBody, &e)
			if status != 403 || e.Code != v1.ErrorCode_ERROR_CODE_IDENTITY_SCOPE_DENIED {
				t.Fatalf("%s -> %d %v", pattern, status, &e)
			}
		})
	}
	t.Logf("registered route classifications: %v", counts)
	// The failures happen before payload validation and resource effects.
	var room v1.GetRoomResponse
	f.local.must(200, "GET", "/api/rooms/"+f.roomB, nil, &room)
	if room.Room.Id != f.roomB {
		t.Fatal("denied mutations changed room")
	}
	f.local.must(200, "GET", "/api/tasks/"+task.Id, nil, nil)
}

func TestIdentityRefreshAndRecoveryScope(t *testing.T) {
	f := identitySetup(t, "optional")
	// The legacy refresh namespace cannot rotate a scoped session.
	f.scoped.must(401, "POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: f.scoped.refresh}, nil)
	resp, err := testApp.Auth.RefreshWorkspace(context.Background(), uuid.MustParse(f.a.Id), &v1.RefreshRequest{RefreshToken: f.scoped.refresh}, auth.Client{})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Tokens.Authority.Kind != v1.SessionAuthorityKind_SESSION_AUTHORITY_KIND_WORKSPACE_SSO || resp.Tokens.Authority.WorkspaceId != f.a.Id {
		t.Fatalf("authority widened: %v", resp.Tokens.Authority)
	}
	c := &client{t: t, token: resp.Tokens.AccessToken}
	c.must(403, "GET", "/api/rooms/"+f.roomB, nil, nil)
	c.must(403, "POST", "/api/auth/logout", &v1.LogoutRequest{AllSessions: true}, nil)
	f.local.must(200, "GET", "/api/me", nil, nil)
	ctx := context.Background()
	ws := uuid.MustParse(f.a.Id)
	at := time.Now()
	_, hash, _ := auth.NewRefreshSecret()
	session, err := testDB.Q.CreateScopedIdentitySession(ctx, sqlc.CreateScopedIdentitySessionParams{UserID: uuid.MustParse(f.local.id), RefreshTokenHash: hash, ExpiresAt: at.Add(10 * time.Minute), AuthorityKind: "recovery", AuthorityWorkspaceID: &ws, RecoveryAuthenticatedAt: &at})
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := testApp.Auth.Tokens().Issue(session.UserID, session.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	recovery := &client{t: t, token: token}
	for _, path := range []string{"/api/me", "/api/workspaces", "/api/rooms/" + f.roomA, "/api/rooms/" + f.roomB, "/api/me/sessions"} {
		recovery.must(403, "GET", path, nil, nil)
	}
}

func TestIdentityNoGrantAndLostRedisRevocation(t *testing.T) {
	f := identitySetup(t, "enforced")
	f.scoped.must(200, "GET", "/api/rooms/"+f.roomA, nil, nil)
	ws := uuid.MustParse(f.a.Id)
	if _, err := testDB.Q.UpsertIdentityGrant(context.Background(), sqlc.UpsertIdentityGrantParams{WorkspaceID: ws, Feature: "corporate_sso", Source: "cloud_business", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	// No Redis event or marker was emitted: the fresh DB epoch rejects immediately.
	f.scoped.must(409, "GET", "/api/rooms/"+f.roomA, nil, nil)
	f.local.must(409, "GET", "/api/rooms/"+f.roomA, nil, nil)
	f.local.must(200, "GET", "/api/rooms/"+f.roomB, nil, nil)
	p, err := testDB.Q.GetIdentityPolicy(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	if p.Mode != "enforced" {
		t.Fatalf("downgrade opened password mode %s", p.Mode)
	}
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM session_workspace_assurances WHERE session_id=$1", f.scopedSession.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("assurance changed on admission/refresh: %d", count)
	}
}

func TestIdentityGatewayPerSessionFanoutAndStaleReplay(t *testing.T) {
	f := identitySetup(t, "enforced")
	scoped := dialGW(t)
	defer func() { _ = scoped.ws.CloseNow() }()
	readyScoped := scoped.identify(f.scoped.token)
	local := dialGW(t)
	defer func() { _ = local.ws.CloseNow() }()
	readyLocal := local.identify(f.local.token)
	if len(readyScoped.Workspaces) != 1 || readyScoped.Workspaces[0].Workspace.Id != f.a.Id || len(readyLocal.Workspaces) != 1 || readyLocal.Workspaces[0].Workspace.Id != f.b.Id {
		t.Fatal("READY used account-wide authority")
	}
	if len(readyScoped.Dms) != 0 || len(readyScoped.Notes) != 0 || readyScoped.Me.Email != "" {
		t.Fatal("scoped READY disclosed global state")
	}
	// Same account, two device sessions: only independently proving the local session opens A.
	f.prove(t, uuid.MustParse(f.local.session), time.Now())
	testApp.Gateway.EnforceIdentity(context.Background())
	local.wait("local assurance opens A", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceCreate().GetSnapshot().GetWorkspace().GetId() == f.a.Id
	})
	// A user channel is not trusted workspace attribution. Resolve its embedded durable room.
	event := &v1.DispatchEvent{Event: &v1.DispatchEvent_MessageCreate{MessageCreate: &v1.MessageCreate{Message: &v1.Message{Id: uuid.NewString(), RoomId: f.roomB, Content: "B private user-channel"}}}}
	(events.Redis{C: testRedis}).User(context.Background(), uuid.MustParse(f.local.id), event)
	local.wait("B event on independent local session", func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetContent() == "B private user-channel"
	})
	scoped.quiet("B user-channel disclosure", 200*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetContent() == "B private user-channel"
	})
	// Disconnect local client, accumulate an A frame, then lose just that assurance in DB.
	last := local.last
	if err := local.ws.CloseNow(); err != nil {
		t.Fatal(err)
	}
	send(t, f.scoped, f.roomA, "stale A payload", "")
	time.Sleep(100 * time.Millisecond)
	sid := uuid.MustParse(f.local.session)
	if _, err := testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: uuid.MustParse(f.a.Id), SessionID: &sid}); err != nil {
		t.Fatal(err)
	}
	// Restore scoped device's own independent proof; the local replay must still deny A.
	f.prove(t, f.scopedSession.ID, time.Now())
	replay := dialGW(t)
	defer func() { _ = replay.ws.CloseNow() }()
	replay.last = last
	replay.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{Token: f.local.token, SessionId: readyLocal.SessionId, Seq: last}}})
	replay.waitFrame("stale replay invalidated", func(frame *v1.GatewayFrame) bool {
		if frame.GetDispatch().GetMessageCreate().GetMessage().GetContent() == "stale A payload" {
			t.Fatal("stale buffered A frame escaped")
		}
		return frame.GetInvalidSession() != nil
	})
	replay.last = 0 // INVALID_SESSION starts a new sequence after IDENTIFY
	fresh := replay.identify(f.local.token)
	if len(fresh.Workspaces) != 1 || fresh.Workspaces[0].Workspace.Id != f.b.Id {
		t.Fatal("fresh READY resurrected denied A")
	}
	send(t, f.scoped, f.roomA, "live A denied on local", "")
	msg := send(t, f.local, f.roomB, "B remains live", "")
	replay.wait("B remains live", func(e *v1.DispatchEvent) bool {
		if e.GetMessageCreate().GetMessage().GetRoomId() == f.roomA {
			t.Fatal("live A frame escaped")
		}
		return e.GetMessageCreate().GetMessage().GetId() == msg.Id
	})
}

func TestIdentityEnforcedHumanInviteBootstrap(t *testing.T) {
	f := identitySetup(t, "optional")
	o := owner(t)
	existingCode := invite(t, o, f.a.Id)
	newCode := invite(t, o, f.a.Id)
	newcomer := register(t, invite(t, o, f.b.Id))
	ws := uuid.MustParse(f.a.Id)
	p, err := testDB.Q.GetIdentityPolicy(context.Background(), ws)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = testDB.Q.SetIdentityPolicy(context.Background(), sqlc.SetIdentityPolicyParams{WorkspaceID: ws, Mode: "enforced", AssuranceMaxAgeSeconds: 3600, ExpectedVersion: p.Version}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		user *user
		code string
	}{{f.local, existingCode}, {newcomer, newCode}} {
		var out v1.JoinWorkspaceResponse
		c.user.must(200, "POST", "/api/invites/"+c.code+"/join", nil, &out)
		if out.Workspace != nil || out.Member != nil || out.GetIdentityAccess().GetWorkspaceId() != f.a.Id || out.GetIdentityAccess().GetReason() != v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SSO_REQUIRED {
			t.Fatal("bootstrap returned workspace metadata or lacked locked status")
		}
		c.user.must(403, "GET", "/api/rooms/"+f.roomA, nil, nil)
		var proofs int
		if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM session_workspace_assurances WHERE session_id=$1", uuid.MustParse(c.user.session)).Scan(&proofs); err != nil {
			t.Fatal(err)
		}
		if proofs != 0 {
			t.Fatal("invitation minted assurance")
		}
	}
	f.scoped.must(403, "POST", "/api/invites/"+existingCode+"/join", nil, nil)
	anonymous := &client{t: t}
	anonymous.must(403, "GET", "/api/invites/"+newCode, nil, nil)
	var api v1.ApiError
	if err := protojson.Unmarshal(anonymous.lastBody, &api); err != nil || api.Code != v1.ErrorCode_ERROR_CODE_SSO_REQUIRED {
		t.Fatal("preview did not convey structured SSO_REQUIRED")
	}
	if strings.Contains(string(anonymous.lastBody), f.a.Name) || strings.Contains(string(anonymous.lastBody), newcomer.id) {
		t.Fatal("preview disclosed membership metadata")
	}
}

func TestIdentityProfileImagesRequireCurrentScopedMembership(t *testing.T) {
	f := identitySetup(t, "enforced")
	_, _, first := upload(t, f.local, "/api/me/avatar", "old.png", pngBytes(16, 16))
	old := first.User.AvatarFileId
	_, _, current := upload(t, f.local, "/api/me/avatar", "current.png", pngBytes(20, 20))
	image := current.User.AvatarFileId
	f.scoped.must(200, "GET", "/api/files/"+image, nil, nil)
	f.scoped.must(403, "GET", "/api/files/"+old, nil, nil)
	onlyB := register(t, invite(t, owner(t), f.b.Id))
	_, _, other := upload(t, onlyB, "/api/me/avatar", "B.png", pngBytes(24, 24))
	f.scoped.must(403, "GET", "/api/files/"+other.User.AvatarFileId, nil, nil)
	if _, err := testDB.Q.RevokeWorkspaceAssurances(context.Background(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: uuid.MustParse(f.a.Id), SessionID: &f.scopedSession.ID}); err != nil {
		t.Fatal(err)
	}
	f.scoped.must(403, "GET", "/api/files/"+image, nil, nil)
	f.local.must(200, "GET", "/api/files/"+image, nil, nil)
}

func TestIdentityOperatorGrantDoesNotEscalateScopedSession(t *testing.T) {
	f := identitySetup(t, "optional")
	uid := uuid.MustParse(f.local.id)
	if _, err := testDB.Q.CreateProductAdminGrant(context.Background(), sqlc.CreateProductAdminGrantParams{UserID: uid, OperatorNote: "integration trusted local grant"}); err != nil {
		t.Fatal(err)
	}
	var local, scoped v1.GetMeResponse
	f.local.must(200, "GET", "/api/me", nil, &local)
	f.scoped.must(200, "GET", "/api/me", nil, &scoped)
	if !local.Me.IsSuperadmin || scoped.Me.IsSuperadmin {
		t.Fatal("operator grant crossed session authority")
	}
	f.local.must(200, "GET", "/api/admin/workspaces", nil, nil)
	f.scoped.must(403, "GET", "/api/admin/workspaces", nil, nil)
	// Only the local proof ages out; the durable grant still exists and must prompt reauth.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE sessions SET local_authenticated_at=clock_timestamp()-interval '6 minutes' WHERE id=$1", uuid.MustParse(f.local.session)); err != nil {
		t.Fatal(err)
	}
	auth.ForgetSessionChecks()
	f.local.must(403, "GET", "/api/admin/workspaces", nil, nil)
	var denial v1.ApiError
	if err := protojson.Unmarshal(f.local.lastBody, &denial); err != nil || denial.Code != v1.ErrorCode_ERROR_CODE_RECENT_AUTH_REQUIRED {
		t.Fatalf("stale local proof did not request reauthentication: %v", &denial)
	}
}
