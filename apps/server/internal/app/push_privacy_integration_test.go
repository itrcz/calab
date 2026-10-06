//go:build integration

package app_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

func TestPushPreviewPrivacySettingsAndLegacyClients(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	var current v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &current)
	if current.GetMe().GetSettings().GetHideMessageTextInNotifications() || ws.HideMessageTextInNotifications {
		t.Fatal("new account/workspace must default to previews on")
	}
	var changed v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{HideMessageTextInNotifications: proto.Bool(true)}, &changed)
	if !changed.GetMe().GetSettings().GetHideMessageTextInNotifications() {
		t.Fatal("personal privacy not returned")
	}
	// Old clients send a complete audio settings replacement without the new field.
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_VAD}}, &changed)
	if !changed.GetMe().GetSettings().GetHideMessageTextInNotifications() {
		t.Fatal("legacy settings reset privacy")
	}
	var other v1.GetMeResponse
	secondDevice(t, bob).must(200, "GET", "/api/me", nil, &other)
	if !other.GetMe().GetSettings().GetHideMessageTextInNotifications() {
		t.Fatal("personal preference not persisted across sessions")
	}
	bob.must(403, "PATCH", "/api/workspaces/"+ws.Id, &v1.UpdateWorkspaceRequest{HideMessageTextInNotifications: proto.Bool(true)}, nil)
	var workspace v1.UpdateWorkspaceResponse
	o.must(200, "PATCH", "/api/workspaces/"+ws.Id, &v1.UpdateWorkspaceRequest{HideMessageTextInNotifications: proto.Bool(true)}, &workspace)
	if !workspace.GetWorkspace().GetHideMessageTextInNotifications() {
		t.Fatal("workspace policy not returned")
	}
	o.must(200, "PATCH", "/api/workspaces/"+ws.Id, &v1.UpdateWorkspaceRequest{Name: proto.String("Renamed")}, &workspace)
	if !workspace.GetWorkspace().GetHideMessageTextInNotifications() {
		t.Fatal("unrelated workspace update reset privacy")
	}
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{HideMessageTextInNotifications: proto.Bool(false)}, &changed)
	o.must(200, "PATCH", "/api/workspaces/"+ws.Id, &v1.UpdateWorkspaceRequest{HideMessageTextInNotifications: proto.Bool(false)}, &workspace)
	if changed.GetMe().GetSettings().GetHideMessageTextInNotifications() || workspace.GetWorkspace().GetHideMessageTextInNotifications() {
		t.Fatal("explicit false did not persist")
	}
}

func TestPushPreviewPrivacyAtDispatchAndRetry(t *testing.T) {
	for _, mode := range []string{"personal", "workspace", "dm-shared-workspace", "retry"} {
		t.Run(mode, func(t *testing.T) {
			s, server, rec := pushHarness(t)
			o, bob, ws, room := setupTeam(t)
			roomID := room.Id
			if mode == "dm-shared-workspace" {
				roomID = openDM(t, o, bob.id, 201).GetRoom().GetId()
			}
			pushAll(t, bob, roomID)
			registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
			const secret = "Private message caption never copied into hidden push"
			msg := dmPost(t, o, roomID, secret)
			s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
			routePush(t, s)
			if mode == "retry" {
				rec.result = push.Result{Retry: true, RetryAfter: time.Minute}
				deliverPush(t, s)
				if len(rec.sent()) != 1 || rec.sent()[0].Body != secret {
					t.Fatal("default preview missing on first attempt")
				}
				rec.result = push.Result{Accepted: true}
			}
			if mode == "personal" || mode == "retry" {
				bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{HideMessageTextInNotifications: proto.Bool(true)}, nil)
			} else {
				o.must(200, "PATCH", "/api/workspaces/"+ws.Id, &v1.UpdateWorkspaceRequest{HideMessageTextInNotifications: proto.Bool(true)}, nil)
			}
			if mode == "retry" {
				if _, err := testDB.Pool.Exec(context.Background(), "UPDATE push_deliveries SET not_before=now() WHERE reference_id=$1 AND delivered_at IS NULL", msg.Id); err != nil {
					t.Fatal(err)
				}
			}
			deliverPush(t, s)
			sent := rec.sent()
			want := 1
			if mode == "retry" {
				want = 2
			}
			if len(sent) != want {
				t.Fatalf("deliveries=%d want %d", len(sent), want)
			}
			last := sent[len(sent)-1]
			if last.Body != "New message" || last.Title == "" {
				t.Fatalf("hidden payload presentation %q / %q", last.Title, last.Body)
			}
			raw, err := json.Marshal(last)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(raw), secret) {
				t.Fatal("hidden text remained in serialized provider data")
			}
		})
	}
}

func TestPushMutedDeliveredMessageStillResolves(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, _, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
	msg := dmPost(t, o, room.Id, "Delivered before DND")
	s.Observe(context.Background(), uuid.Nil, pushMessage(msg))
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("missing initial delivery")
	}
	receipt := rec.sent()[0]
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET presence_status=3,presence_until=NULL WHERE id=$1", bob.id); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE room_notification_settings SET level='none',muted_until='infinity' WHERE user_id=$1 AND room_id=$2", bob.id, room.Id); err != nil {
		t.Fatal(err)
	}
	request := &v1.ResolvePushRequest{Binding: receipt.Binding, EventId: receipt.EventID}
	var route v1.ResolvePushResponse
	pushHTTP(t, server, bob, 200, "POST", "/api/me/push-resolve", request, &route)
	if route.MessageId != msg.Id {
		t.Fatal("wrong navigation")
	}
	later := dmPost(t, o, room.Id, "Quiet new delivery")
	s.Observe(context.Background(), uuid.Nil, pushMessage(later))
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("tap fix disabled delivery mute")
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE messages SET deleted_at=now() WHERE id=$1", msg.Id); err != nil {
		t.Fatal(err)
	}
	pushHTTP(t, server, bob, 404, "POST", "/api/me/push-resolve", request, nil)
}

func TestPushHiddenAttachmentCaptionAndFilename(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, ws, room := setupTeam(t)
	pushAll(t, bob, room.Id)
	registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{HideMessageTextInNotifications: proto.Bool(true)}, nil)
	code, file, _ := upload(t, o, "/api/workspaces/"+ws.Id+"/files", "private-filename.png", pngBytes(8, 8))
	if code != 201 {
		t.Fatalf("upload status %d", code)
	}
	var created v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+room.Id+"/messages", &v1.CreateMessageRequest{Content: "private-caption", AttachmentIds: []string{file.GetId()}}, &created)
	s.Observe(context.Background(), uuid.Nil, pushMessage(created.GetMessage()))
	deliverPush(t, s)
	if len(rec.sent()) != 1 || rec.sent()[0].Body != "Photo" {
		t.Fatal("hidden attachment must use kind only")
	}
	raw, _ := json.Marshal(rec.sent()[0])
	if strings.Contains(string(raw), "private-caption") || strings.Contains(string(raw), "private-filename") {
		t.Fatal("attachment privacy leak")
	}
}

func TestPushDMPrivacyUsesOnlySharedWorkspaces(t *testing.T) {
	s, server, rec := pushHarness(t)
	o, bob, _, _ := setupTeam(t)
	dm := openDM(t, o, bob.id, 201).GetRoom().GetId()
	registerPush(t, server, bob, uuid.NewString(), uuid.NewString(), 200)
	privateWS := createWorkspace(t, bob, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob.must(200, "PATCH", "/api/workspaces/"+privateWS.Id, &v1.UpdateWorkspaceRequest{HideMessageTextInNotifications: proto.Bool(true)}, nil)
	send := func(body string) string {
		t.Helper()
		before := len(rec.sent())
		m := dmPost(t, o, dm, body)
		s.Observe(context.Background(), uuid.Nil, pushMessage(m))
		deliverPush(t, s)
		sent := rec.sent()
		if len(sent) != before+1 {
			t.Fatal("missing DM delivery")
		}
		return sent[len(sent)-1].Body
	}
	if send("Visible outside unrelated space") != "Visible outside unrelated space" {
		t.Fatal("unrelated workspace hid DM")
	}
	// Now both share a strict space as well as their original permissive space.
	o.must(200, "POST", "/api/invites/"+invite(t, bob, privateWS.Id)+"/join", nil, nil)
	if send("Hidden under strict shared space") != "New message" {
		t.Fatal("strictest shared policy did not win")
	}
}
