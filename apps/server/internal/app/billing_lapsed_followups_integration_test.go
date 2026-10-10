//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/voice"
)

// multipartStatus sends one multipart "file" with method to path as token and returns the status
// and the decoded ApiError reason of a failure.
func multipartStatus(t *testing.T, method, path, token, name string, data []byte) (int, string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), method, srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var e v1.ApiError
	if resp.StatusCode >= 400 {
		_ = protojson.Unmarshal(raw, &e)
	}
	return resp.StatusCode, e.GetReason()
}

// The pictures made of an upload are closed in the restricted mode too (ADR-0086 amendment 1):
// a new background, an achievement picture (new, or replaced by an edit), a replaced sticker and
// a bot avatar answer 403 WORKSPACE_PLAN_INACTIVE; renaming an achievement stays open, and
// everything works again once the mode is over.
func TestBillingLapsedPictureUploads(t *testing.T) {
	withBilling(t, newFakeSeats(), true)
	a, wsPB := wsOwner(t)
	ws := wsPB.GetId()
	png := achievementPNG(t, false)
	medal := newAchievement(t, a, ws, "Medal")
	pic := achievementUpload(t, a, ws, "again.png", png)
	bgFile := bgUpload(t, a, ws, png)
	pack := createPack(t, a, ws, "Faces")
	_, up, _ := uploadStickers(t, a, pack.GetId(), stickerFile{"😀", "s.webp", stickerFixture(t, "sun.webp")})
	sticker := up.GetAdded()[0].GetId()
	bot := createBot(t, a, ws, "avatarbot")

	account := billingAccount(t, ws, "stopped", false)
	setLapsed(t, ws, account, true)

	wantPlanInactive(t, a.client, "POST", "/api/workspaces/"+ws+"/backgrounds", &v1.CreateBackgroundRequest{Name: "Late", FileId: bgFile})
	wantPlanInactive(t, a.client, "POST", "/api/workspaces/"+ws+"/achievements", &v1.CreateAchievementRequest{Title: "Late", FileId: pic})
	wantPlanInactive(t, a.client, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{FileId: &pic})
	title := "Renamed"
	a.must(200, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{Title: &title}, nil)
	st, reason := multipartStatus(t, "PUT", "/api/sticker-packs/"+pack.GetId()+"/stickers/"+sticker, a.token, "s.webp", stickerFixture(t, "sun.webp"))
	if st != 403 || reason != billing.ReasonWorkspacePlanInactive {
		t.Fatalf("sticker replacement: %d %q, want 403 %s", st, reason, billing.ReasonWorkspacePlanInactive)
	}
	st, reason = multipartStatus(t, "POST", "/api/workspaces/"+ws+"/bots/"+bot.id+"/avatar", a.token, "a.png", png)
	if st != 403 || reason != billing.ReasonWorkspacePlanInactive {
		t.Fatalf("bot avatar: %d %q, want 403 %s", st, reason, billing.ReasonWorkspacePlanInactive)
	}

	setLapsed(t, ws, account, false)
	newBackground(t, a, ws, "On time", bgUpload(t, a, ws, png))
	a.must(200, "PATCH", "/api/achievements/"+medal.GetId(), &v1.UpdateAchievementRequest{FileId: &pic}, nil)
	if st, _ := multipartStatus(t, "POST", "/api/workspaces/"+ws+"/bots/"+bot.id+"/avatar", a.token, "a.png", png); st != 200 {
		t.Fatalf("bot avatar after the mode: %d", st)
	}
}

// A meeting recording that is running when the workspace enters the restricted mode stops with
// reason plan_inactive: at once from the billing hook, and from the worker's Maintain pass for a
// row the hook missed (another instance, a restart). Other workspaces' recordings are left alone.
func TestBillingLapsedStopsRecording(t *testing.T) {
	withBilling(t, newFakeSeats(), true)
	ctx := context.Background()
	a, wsPB := wsOwner(t)
	ws := wsPB.GetId()
	other, otherPB := wsOwner(t)
	running := func(owner *user, wsID, room string) uuid.UUID {
		t.Helper()
		if _, err := testDB.Pool.Exec(ctx, `UPDATE rooms SET allow_recording = true WHERE id = $1`, room); err != nil {
			t.Fatal(err)
		}
		id := uuid.New()
		starter := uuid.MustParse(owner.id)
		if _, err := testDB.Q.InsertRecording(ctx, sqlc.InsertRecordingParams{ID: id, WorkspaceID: uuid.MustParse(wsID), RoomID: uuid.MustParse(room), StartedBy: &starter, File: id.String() + ".ogg"}); err != nil {
			t.Fatal(err)
		}
		egress := "EG_" + id.String()
		egFake.mu.Lock() // an egress LiveKit reports as running, so the reconcile pass leaves the row alone
		egFake.items[egress] = &livekit.EgressInfo{EgressId: egress, RoomName: voice.RoomName(uuid.MustParse(wsID), uuid.MustParse(room)),
			Status: livekit.EgressStatus_EGRESS_ACTIVE, StartedAt: time.Now().UnixNano()}
		egFake.mu.Unlock()
		if _, err := testDB.Q.MarkRecordingStarted(ctx, sqlc.MarkRecordingStartedParams{ID: id, EgressID: &egress}); err != nil {
			t.Fatal(err)
		}
		return id
	}
	stopReason := func(id uuid.UUID) (string, bool) {
		t.Helper()
		var reason string
		var stopped *time.Time
		if err := testDB.Pool.QueryRow(ctx, `SELECT stop_reason, stopped_at FROM room_recordings WHERE id = $1`, id).Scan(&reason, &stopped); err != nil {
			t.Fatal(err)
		}
		return reason, stopped != nil
	}
	lateRoom := voiceRoom(t, a, ws, "Late meeting", 0) // creating rooms is closed once restricted
	mine, theirs := running(a, ws, voiceRoom(t, a, ws, "Meeting", 0)), running(other, otherPB.GetId(), voiceRoom(t, other, otherPB.GetId(), "Theirs", 0))
	defer func() { // do not leave live rows for the worker of other tests
		_, _ = testDB.Pool.Exec(ctx, `UPDATE room_recordings SET status = 'failed', error = 'test' WHERE id = ANY($1)`, []uuid.UUID{mine, theirs})
	}()

	// Not restricted: Maintain keeps both.
	testApp.Recording.Maintain(ctx)
	if _, stopped := stopReason(mine); stopped {
		t.Fatal("stopped without the restricted mode")
	}

	account := billingAccount(t, ws, "stopped", false)
	setLapsed(t, ws, account, true)
	testApp.Recording.StopPlanInactive(ctx, uuid.MustParse(ws)) // the billing hook
	if reason, stopped := stopReason(mine); !stopped || reason != "plan_inactive" {
		t.Fatalf("hook: stopped=%v reason=%q", stopped, reason)
	}
	if !egFake.stopped("EG_" + mine.String()) {
		t.Fatal("the egress was not told to stop")
	}
	if _, stopped := stopReason(theirs); stopped {
		t.Fatal("another workspace's recording stopped")
	}

	// The worker catches a row the hook never saw.
	late := running(a, ws, lateRoom)
	defer func() {
		_, _ = testDB.Pool.Exec(ctx, `UPDATE room_recordings SET status = 'failed', error = 'test' WHERE id = $1`, late)
	}()
	testApp.Recording.Maintain(ctx)
	if reason, stopped := stopReason(late); !stopped || reason != "plan_inactive" {
		t.Fatalf("Maintain: stopped=%v reason=%q", stopped, reason)
	}
	if _, stopped := stopReason(theirs); stopped {
		t.Fatal("Maintain stopped another workspace's recording")
	}
}

// Creating an OAuth client (a route public for the identity gate) is refused in the restricted
// mode after the provider's own authorization, and works again once the mode is over.
func TestBillingLapsedOAuthClient(t *testing.T) {
	f := identitySetup(t, "optional")
	idApp, base := identityHTTP(t) // its own App: billing is switched on there, not on testApp
	idApp.SetBilling(newFakeSeats(), true, true)
	t.Cleanup(func() { idApp.SetBilling(nil, false, false) })
	o := owner(t)
	ensureFixtureLocalProof(t, o, base, &quotaOwnerProofUntil)
	create := &v1.CreateOAuthClientRequest{Name: "Lapsed client", Type: v1.OAuthClientType_OAUTH_CLIENT_TYPE_PUBLIC_SPA, RedirectUris: []string{"https://client.example/callback"}, AllowedOrigins: []string{"https://client.example"}, Scopes: []string{"openid"}}
	post := func() (int, []byte) {
		status, raw, _ := identityRequest(t, base, "POST", "/api/workspaces/"+f.a.Id+"/oauth/clients", o.token, "https://app.example.com", nil, create)
		return status, raw
	}

	account := billingAccount(t, f.a.Id, "stopped", false)
	setLapsed(t, f.a.Id, account, true)
	idApp.Plans.Invalidate(context.Background(), uuid.MustParse(f.a.Id))
	status, raw := post()
	var e v1.ApiError
	if status != 403 || protojson.Unmarshal(raw, &e) != nil || e.GetReason() != billing.ReasonWorkspacePlanInactive {
		t.Fatalf("lapsed: %d %s, want 403 %s", status, raw, billing.ReasonWorkspacePlanInactive)
	}
	setLapsed(t, f.a.Id, account, false)
	idApp.Plans.Invalidate(context.Background(), uuid.MustParse(f.a.Id))
	if status, raw = post(); status != 201 {
		t.Fatalf("after the mode: %d %s", status, raw)
	}
}
