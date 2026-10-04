//go:build integration

package app_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/plans"
)

// Plans and limits (ADR-0024).

const (
	unlimitedPlan   = `{"room_members":0,"stream_max_preset":"","stream_max_fps":0,"camera_max_preset":"","camera_max_fps":0,"streams_per_room":0,"storage_mb":0,"members":0,"sticker_packs":0,"stickers":0,"bots":0,"audio_tier_max_kbps":0,"boards":0,"cameras_per_room":0,"caldav_disabled":false,"musician_disabled":false,"checklists_disabled":false,"board_forms_disabled":false}`
	superadminEmail = "it-admin@example.com"
	// superadminEmail2 belongs to TestAdminGuardAndLimit only (it exhausts its rate limit).
	superadminEmail2 = "it-admin2@example.com"
)

// withFreeLimits applies the built-in free limits (5 in a room, 720p / 15 fps, 1 stream,
// 1 GiB) for the rest of the test; the harness runs without plan limits otherwise.
func withFreeLimits(t *testing.T) {
	t.Helper()
	unlimited, err := plans.ParseLimits(unlimitedPlan, plans.DefaultFree)
	if err != nil {
		t.Fatal(err)
	}
	testApp.Plans.SetDefaults(plans.DefaultFree, plans.DefaultTeam, plans.DefaultBusiness)
	t.Cleanup(func() { testApp.Plans.SetDefaults(unlimited, plans.DefaultTeam, plans.DefaultBusiness) })
}

// registerEmail registers a user with a given email through an invite.
func registerEmail(t *testing.T, inviteCode, email string) *user {
	t.Helper()
	seq++
	c := &client{t: t, ip: fmt.Sprintf("10.9.%d.%d", seq/250, seq%250+1)}
	var resp v1.RegisterResponse
	c.must(201, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: email, Password: "password123", DisplayName: "Admin", InviteCode: inviteCode, DeviceName: "test",
	}, &resp)
	c.token = resp.GetTokens().GetAccessToken()
	// A superadmin address counts only once verified (ADR-0023).
	if resp.GetMe().GetIsSuperadmin() {
		t.Fatal("unverified address is superadmin")
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET email_verified_at = now() WHERE id = $1", resp.GetMe().GetUser().GetId()); err != nil {
		t.Fatal(err)
	}
	return &user{client: c, id: resp.GetMe().GetUser().GetId(), refresh: resp.GetTokens().GetRefreshToken(), session: resp.GetTokens().GetSessionId(), email: email}
}

var superUser *user
var superUserProofUntil time.Time

func superadminUser(t *testing.T) *user {
	t.Helper()
	if superUser == nil {
		o := owner(t)
		ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
		superUser = registerEmail(t, invite(t, o, ws.GetId()), superadminEmail)
	}
	superUser.t = t
	ensureFixtureLocalProof(t, superUser, srv.URL, &superUserProofUntil)
	return superUser
}

// apiErr performs a bodyless request and decodes the ApiError of the response.
func (c *client) apiErr(method, path string) (int, *v1.ApiError) {
	c.t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), method, srv.URL+path, http.NoBody)
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var e v1.ApiError
	_ = protojson.Unmarshal(raw, &e)
	return resp.StatusCode, &e
}

func joinPending(t *testing.T, u *user, rid string) *v1.JoinVoiceResponse {
	t.Helper()
	var j v1.JoinVoiceResponse
	u.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	return &j
}

// The plan limits users in a voice room for everyone (the owner too, pending devices count):
// the 6th user gets 409 ROOM_FULL with reason PLAN_LIMIT; the room's own user_limit stays a
// separate, role-dependent check.
func TestPlanRoomMembersLimit(t *testing.T) {
	liveKitUp(t)
	withFreeLimits(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	rid := voiceRoom(t, o, ws.GetId(), "big", 0)
	var members []*user
	for range 5 {
		m := register(t, code)
		members = append(members, m)
		joinPending(t, m, rid) // pending, not connected: still takes a place
	}
	st, e := o.apiErr("POST", "/api/rooms/"+rid+"/join")
	if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_ROOM_FULL || e.GetReason() != "PLAN_LIMIT" || e.GetUsed() != 5 || e.GetLimit() != 5 {
		t.Fatalf("6th user (owner): %d %v", st, e)
	}
	// A second device of a user already inside does not take a new place.
	joinPending(t, members[0], rid)
	// Leaving frees the place.
	members[4].must(204, "POST", "/api/rooms/"+rid+"/voice/leave", nil, nil)
	j := joinPending(t, o, rid)
	if j.GetPlanLimits().GetRoomMembers() != 5 {
		t.Fatalf("join plan_limits: %v", j.GetPlanLimits())
	}

	// A room user_limit below the plan: plain ROOM_FULL without a reason.
	small := voiceRoom(t, o, ws.GetId(), "small", 1)
	joinPending(t, members[1], small)
	st, e = members[2].apiErr("POST", "/api/rooms/"+small+"/join")
	if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_ROOM_FULL || e.Reason != nil || e.GetLimit() != 1 {
		t.Fatalf("room user_limit: %d %v", st, e)
	}

	// team plan: 15 in a room. Fill the room up to 15 (used must read 15/15 at the next join).
	admin := superadminUser(t)
	admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM, Note: "paid"}, nil)
	members[4].must(200, "POST", "/api/rooms/"+rid+"/join", nil, nil) // 6
	code2 := invite(t, o, ws.GetId())                                 // an invite code serves 10 registrations
	for range 10 {                                                    // up to 15
		register(t, code2).must(200, "POST", "/api/rooms/"+rid+"/join", nil, nil)
	}
	st, e = register(t, invite(t, o, ws.GetId())).apiErr("POST", "/api/rooms/"+rid+"/join")
	if st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_ROOM_FULL || e.GetReason() != "PLAN_LIMIT" || e.GetUsed() != 15 || e.GetLimit() != 15 {
		t.Fatalf("16th user on team: %d %v", st, e)
	}
	// Business (PLAN_ENTERPRISE): 50 in a room.
	admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE, Note: "business"}, nil)
	register(t, invite(t, o, ws.GetId())).must(200, "POST", "/api/rooms/"+rid+"/join", nil, nil)
}

// Stream / camera quality is capped by the plan in the answers of /join, /stream/request and
// /camera/request (1080p → 720p / 15 on free), and the room's streams are capped to 1.
func TestPlanMediaCaps(t *testing.T) {
	liveKitUp(t)
	withFreeLimits(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	// The room allows 1080p and 3 streams by default; the plan caps both.
	j := joinPending(t, bob, rid)
	if m := j.GetMedia(); m.GetMaxStreamPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720 || m.GetMaxStreams() != 1 {
		t.Fatalf("join media not capped: %v", m)
	}
	pl := j.GetPlanLimits()
	if pl.GetStreamMaxFps() != 15 || pl.GetCameraMaxPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720 || pl.GetStreamsPerRoom() != 1 {
		t.Fatalf("join plan_limits: %v", pl)
	}
	// Room.media stays the room's own settings (the UI tells room and plan locks apart).
	var gr v1.GetRoomResponse
	o.must(200, "GET", "/api/rooms/"+rid, nil, &gr)
	if gr.GetRoom().GetMedia().GetMaxStreamPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080 {
		t.Fatalf("room media changed: %v", gr.GetRoom().GetMedia())
	}
	lkJoin(t, "ws_"+ws.GetId()+"_room_"+rid, j.GetIdentity())

	var sr v1.RequestStreamResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/stream/request", &v1.RequestStreamRequest{Preset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080}, &sr)
	if sr.GetPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720 || sr.GetFps() != 15 {
		t.Fatalf("stream 1080p on free: %v", &sr)
	}
	var cr v1.RequestCameraResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/camera/request", &v1.RequestCameraRequest{Preset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080, Fps: 30}, &cr)
	if cr.GetPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720 || cr.GetFps() != 15 {
		t.Fatalf("camera 1080p/30 on free: %v", &cr)
	}

	// The plan is in READY (Workspace.plan) with the contact for buying.
	ready := dialGW(t).identify(bob.token)
	if ready.GetPlanContact() != "mailto:it@gptunnel.ai" {
		t.Fatalf("plan_contact %q", ready.GetPlanContact())
	}
	for _, s := range ready.GetWorkspaces() {
		if s.GetWorkspace().GetId() == ws.GetId() {
			p := s.GetWorkspace().GetPlan()
			if p.GetPlan() != v1.Plan_PLAN_FREE || p.GetLimits().GetRoomMembers() != 5 || p.GetLimits().GetStreamMaxFps() != 15 {
				t.Fatalf("READY plan: %v", p)
			}
		}
	}

	// Custom plan with 1080p / 30: the answers follow at once (cache invalidated).
	admin := superadminUser(t)
	admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM,
		Limits: &v1.PlanLimits{StreamMaxPreset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080, StreamMaxFps: 30, StreamsPerRoom: 2}}, nil)
	bob.must(200, "POST", "/api/rooms/"+rid+"/stream/request", &v1.RequestStreamRequest{Preset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL}, &sr)
	if sr.GetPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080 || sr.GetFps() != 15 {
		t.Fatalf("stream on custom: %v", &sr)
	}
	bob.must(200, "POST", "/api/rooms/"+rid+"/camera/request", &v1.RequestCameraRequest{}, &cr)
	if cr.GetPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED || cr.GetFps() != 0 {
		t.Fatalf("camera without caps: %v", &cr)
	}
}

func uploadRaw(t *testing.T, u *user, wsID string, size int) (int, *v1.ApiError) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "blob.bin")
	_, _ = fw.Write(bytes.Repeat([]byte{'x'}, size))
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+"/api/workspaces/"+wsID+"/files", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+u.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var e v1.ApiError
	if resp.StatusCode >= 300 {
		_ = protojson.Unmarshal(raw, &e)
	}
	return resp.StatusCode, &e
}

// The plan's storage_mb caps the workspace quota: 413 FILE_QUOTA_EXCEEDED, reason PLAN_LIMIT,
// with the usage and the effective quota.
func TestPlanStorageQuota(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	voiceRoom(t, o, ws.GetId(), "files", 0) // ATTACH_FILES somewhere
	admin := superadminUser(t)
	admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM,
		Limits: &v1.PlanLimits{StorageMb: 1}}, nil)
	const part = 600 << 10
	if st, e := uploadRaw(t, o, ws.GetId(), part); st != 201 {
		t.Fatalf("first upload: %d %v", st, e)
	}
	st, e := uploadRaw(t, o, ws.GetId(), part)
	if st != 413 || e.GetCode() != v1.ErrorCode_ERROR_CODE_FILE_QUOTA_EXCEEDED || e.GetReason() != "PLAN_LIMIT" ||
		e.GetLimit() != 1<<20 || e.GetUsed() != part {
		t.Fatalf("over the plan storage: %d %v", st, e)
	}
	// Workspace.plan reports the limit.
	var gw v1.GetWorkspaceResponse
	o.must(200, "GET", "/api/workspaces/"+ws.GetId(), nil, &gw)
	if gw.GetWorkspace().GetPlan().GetLimits().GetStorageMb() != 1 || gw.GetWorkspace().GetPlan().GetPlan() != v1.Plan_PLAN_CUSTOM {
		t.Fatalf("workspace plan: %v", gw.GetWorkspace().GetPlan())
	}
	// TEAM: 300 GiB (owner, 30.09) — the refused upload now fits; BUSINESS (ENTERPRISE): 1 TiB.
	admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_TEAM}, nil)
	o.must(200, "GET", "/api/workspaces/"+ws.GetId(), nil, &gw)
	if gw.GetWorkspace().GetPlan().GetLimits().GetStorageMb() != 300<<10 {
		t.Fatalf("team storage: %v", gw.GetWorkspace().GetPlan())
	}
	if st, e := uploadRaw(t, o, ws.GetId(), part); st != 201 {
		t.Fatalf("upload on team: %d %v", st, e)
	}
	admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_ENTERPRISE}, nil)
	o.must(200, "GET", "/api/workspaces/"+ws.GetId(), nil, &gw)
	if gw.GetWorkspace().GetPlan().GetLimits().GetStorageMb() != 1<<20 {
		t.Fatalf("business storage: %v", gw.GetWorkspace().GetPlan())
	}
}

// Superadmin API: 404 for everyone else; search, detail, plan change (validated, logged,
// WORKSPACE_UPDATE with the new limits to the members), log; Me.is_superadmin.
func TestAdminPlans(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob := register(t, invite(t, o, ws.GetId()))
	wid := ws.GetId()
	base := "/api/admin/workspaces/" + wid

	// Not a superadmin (even the owner): every admin route is 404, like an unknown route.
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/admin/workspaces?q=" + ws.GetSlug()}, {"GET", base}, {"PUT", base + "/plan"}, {"GET", base + "/plan/log"},
	} {
		if st, e := o.apiErr(c.method, c.path); st != 404 || e.GetCode() != v1.ErrorCode_ERROR_CODE_NOT_FOUND {
			t.Errorf("%s %s by owner: %d", c.method, c.path, st)
		}
	}
	var me v1.GetMeResponse
	o.must(200, "GET", "/api/me", nil, &me)
	if me.GetMe().GetIsSuperadmin() {
		t.Fatal("owner is not a superadmin")
	}

	admin := superadminUser(t)
	admin.must(200, "GET", "/api/me", nil, &me)
	if !me.GetMe().GetIsSuperadmin() {
		t.Fatal("me.is_superadmin not set")
	}
	if !dialGW(t).identify(admin.token).GetMe().GetIsSuperadmin() {
		t.Fatal("READY me.is_superadmin not set")
	}

	// Search by slug, name (case-insensitive) and owner email; LIKE wildcards are literal.
	ownerEmail := mustEmail(t, o)
	for _, q := range []string{ws.GetSlug(), "TEAM", ownerEmail} {
		var sr v1.AdminSearchWorkspacesResponse
		admin.must(200, "GET", "/api/admin/workspaces?q="+q, nil, &sr)
		found := false
		for _, aw := range sr.GetWorkspaces() {
			if aw.GetWorkspace().GetId() == wid {
				found = true
				if aw.GetOwnerEmail() != ownerEmail || aw.GetUsage().GetMembers() != 2 || aw.GetWorkspace().GetPlan().GetPlan() != v1.Plan_PLAN_FREE {
					t.Fatalf("search row: %v", aw)
				}
			}
		}
		if !found || len(sr.GetWorkspaces()) > 50 {
			t.Fatalf("q=%s: found %v, %d rows", q, found, len(sr.GetWorkspaces()))
		}
	}
	var none v1.AdminSearchWorkspacesResponse
	admin.must(200, "GET", "/api/admin/workspaces?q=%25%25nothing-matches%25", nil, &none)
	if len(none.GetWorkspaces()) != 0 {
		t.Fatalf("wildcards not escaped: %d rows", len(none.GetWorkspaces()))
	}

	// Detail with usage.
	msgRoom := voiceRoom(t, o, wid, "chat", 0)
	send(t, o, msgRoom, "hello", "")
	var gr v1.AdminGetWorkspaceResponse
	admin.must(200, "GET", base, nil, &gr)
	if u := gr.GetWorkspace().GetUsage(); u.GetRooms() != 1 || u.GetMembers() != 2 || u.GetLastActivity() == nil {
		t.Fatalf("usage: %v", u)
	}
	admin.must(404, "GET", "/api/admin/workspaces/01890000-0000-7000-8000-000000000000", nil, nil)

	// Validation.
	for name, req := range map[string]*v1.AdminSetPlanRequest{
		"no plan":           {},
		"limits for team":   {Plan: v1.Plan_PLAN_TEAM, Limits: &v1.PlanLimits{RoomMembers: 3}},
		"custom w/o limits": {Plan: v1.Plan_PLAN_CUSTOM},
		"bad bound":         {Plan: v1.Plan_PLAN_CUSTOM, Limits: &v1.PlanLimits{RoomMembers: 5000}},
		"past valid_until":  {Plan: v1.Plan_PLAN_TEAM, ValidUntil: timestamppb.New(time.Now().Add(-time.Hour))},
		"long note":         {Plan: v1.Plan_PLAN_TEAM, Note: string(bytes.Repeat([]byte{'n'}, 501))},
	} {
		if st := admin.do("PUT", base+"/plan", req, nil); st != 422 {
			t.Errorf("%s: %d, want 422", name, st)
		}
	}

	// A change reaches every member as WORKSPACE_UPDATE with the new limits.
	g := dialGW(t)
	g.identify(bob.token)
	until := time.Now().Add(30 * 24 * time.Hour).Truncate(time.Second)
	var put v1.AdminSetPlanResponse
	admin.must(200, "PUT", base+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM,
		Limits:     &v1.PlanLimits{RoomMembers: 12, StreamMaxPreset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080, StorageMb: 2048},
		ValidUntil: timestamppb.New(until), Note: "invoice 42"}, &put)
	if p := put.GetWorkspace().GetWorkspace().GetPlan(); p.GetPlan() != v1.Plan_PLAN_CUSTOM || p.GetLimits().GetRoomMembers() != 12 ||
		!p.GetValidUntil().AsTime().Equal(until) || put.GetWorkspace().GetPlanNote() != "invoice 42" || put.GetWorkspace().GetPlanUpdatedBy() != admin.id {
		t.Fatalf("put response: %v", put.GetWorkspace())
	}
	ev := g.wait("WORKSPACE_UPDATE with limits", func(e *v1.DispatchEvent) bool {
		w := e.GetWorkspaceUpdate().GetWorkspace()
		return w.GetId() == wid && w.GetPlan().GetLimits().GetRoomMembers() == 12
	})
	if ev.GetWorkspaceUpdate().GetWorkspace().GetPlan().GetLimits().GetStreamMaxPreset() != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080 {
		t.Fatalf("event plan: %v", ev.GetWorkspaceUpdate().GetWorkspace().GetPlan())
	}
	// A later workspace PATCH keeps the plan in its WORKSPACE_UPDATE.
	name := "Renamed"
	o.must(200, "PATCH", "/api/workspaces/"+wid, &v1.UpdateWorkspaceRequest{Name: &name}, nil)
	g.wait("WORKSPACE_UPDATE rename keeps the plan", func(e *v1.DispatchEvent) bool {
		w := e.GetWorkspaceUpdate().GetWorkspace()
		return w.GetName() == name && w.GetPlan().GetLimits().GetRoomMembers() == 12
	})

	admin.must(200, "PUT", base+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_FREE, Note: "downgrade"}, nil)
	var lg v1.AdminPlanLogResponse
	admin.must(200, "GET", base+"/plan/log", nil, &lg)
	e := lg.GetEntries()
	if len(e) != 2 || e[0].GetNote() != "downgrade" || e[0].GetPlan() != v1.Plan_PLAN_FREE || e[1].GetLimits().GetRoomMembers() != 12 ||
		e[1].GetActorEmail() != superadminEmail || !e[1].GetValidUntil().AsTime().Equal(until) {
		t.Fatalf("log: %v", e)
	}
	// FREE logs the free limits in force (the harness runs them unlimited).
	if e[0].GetLimits() == nil {
		t.Fatal("free entry without limits")
	}
}
