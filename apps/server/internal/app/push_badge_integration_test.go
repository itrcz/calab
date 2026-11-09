//go:build integration

package app_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

func TestPushBadgeUnreadMentionsReadAndRevocation(t *testing.T) {
	rec := &pushRecorder{result: push.Result{Accepted: true}}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, Events: events.Nop{}, Blob: testStore, LiveKit: lkRec,
		Push: map[v1.PushProvider]push.Provider{v1.PushProvider_PUSH_PROVIDER_APNS: {AppID: "ru.calab.test", Environment: "production", Sender: rec}}})
	server := httptest.NewServer(a.Handler)
	defer server.Close()
	o, bob, ws, room := setupTeam(t)
	dm := openDM(t, o, bob.id, 201).GetRoom().GetId()
	dmPost(t, o, dm, "one")
	lastDM := dmPost(t, o, dm, "two")
	dmPost(t, o, room.Id, "ordinary room text is not in the icon count")
	dmPost(t, o, room.Id, "direct @"+bob.id)
	last := dmPost(t, o, room.Id, "@everyone")
	var private v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.Id+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "private-badge", IsPrivate: true}, &private)
	dmPost(t, o, private.Room.Id, "hidden @"+bob.id)
	var endpoint v1.RegisterPushDeviceResponse
	pushHTTP(t, server, bob, 200, "POST", "/api/me/push-devices", &v1.RegisterPushDeviceRequest{Provider: v1.PushProvider_PUSH_PROVIDER_APNS, AppId: "ru.calab.test", Environment: "production", InstallationId: uuid.NewString(), Token: strings.Repeat("ab", 32), NotificationsEnabled: true, MentionsEnabled: proto.Bool(true), AllEnabled: true}, &endpoint)
	t.Cleanup(func() {
		_, _ = testDB.Pool.Exec(context.Background(), "DELETE FROM push_devices WHERE id=$1", endpoint.Id)
	})
	a.Push.Observe(context.Background(), uuid.Nil, pushMessage(last))
	deliverPush(t, a.Push)
	if sent := rec.sent(); len(sent) != 1 || sent[0].Badge == nil || *sent[0].Badge != 4 {
		t.Fatalf("want 2 DM + 2 visible mentions: %#v", sent)
	}
	awaitBadge := func(want int) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			sent := rec.sent()
			if len(sent) > 0 {
				p := sent[len(sent)-1]
				if p.Kind == "badge" && p.Badge != nil && *p.Badge == want {
					return
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("no silent badge %d: %#v", want, rec.sent())
	}
	pushHTTP(t, server, bob, 204, "PUT", "/api/rooms/"+room.Id+"/read", &v1.UpdateReadStateRequest{MessageId: last.Id}, nil)
	awaitBadge(2)
	pushHTTP(t, server, bob, 204, "PUT", "/api/rooms/"+dm+"/read", &v1.UpdateReadStateRequest{MessageId: lastDM.Id}, nil)
	awaitBadge(0)
	pushHTTP(t, server, bob, 204, "DELETE", "/api/me/push-devices/"+endpoint.Id, &v1.UnregisterPushDeviceRequest{Version: endpoint.Version}, nil)
	before := len(rec.sent())
	a.Push.Observe(context.Background(), uuid.MustParse(bob.id), &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{ReadStateUpdate: &v1.ReadStateUpdate{ReadState: &v1.ReadState{RoomId: dm, LastReadMessageId: lastDM.Id}}}})
	time.Sleep(100 * time.Millisecond)
	if len(rec.sent()) != before {
		t.Fatal("revoked endpoint received a badge")
	}
}

// The local endpoint must not count a workspace merely because another session
// of the same account completed corporate step-up.
func TestPushBadgeExactSessionPolicy(t *testing.T) {
	f := identitySetup(t, "enforced")
	rec := &pushRecorder{result: push.Result{Accepted: true}}
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, Events: events.Nop{}, Blob: testStore, LiveKit: lkRec, Push: map[v1.PushProvider]push.Provider{v1.PushProvider_PUSH_PROVIDER_APNS: {AppID: "ru.calab.test", Environment: "production", Sender: rec}}})
	server := httptest.NewServer(a.Handler)
	defer server.Close()
	var endpoint v1.RegisterPushDeviceResponse
	pushHTTP(t, server, f.local, 200, "POST", "/api/me/push-devices", &v1.RegisterPushDeviceRequest{Provider: v1.PushProvider_PUSH_PROVIDER_APNS, AppId: "ru.calab.test", Environment: "production", InstallationId: uuid.NewString(), Token: strings.Repeat("cd", 32), NotificationsEnabled: true, MentionsEnabled: proto.Bool(true), AllEnabled: true}, &endpoint)
	t.Cleanup(func() {
		_, _ = testDB.Pool.Exec(context.Background(), "DELETE FROM push_devices WHERE id=$1", endpoint.Id)
	})
	for _, room := range []string{f.roomA, f.roomB} {
		m, err := testDB.Q.InsertMessage(t.Context(), sqlc.InsertMessageParams{RoomID: uuid.MustParse(room), AuthorID: uuid.MustParse(owner(t).id), Content: "mention"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = testDB.Pool.Exec(t.Context(), "INSERT INTO message_mentions(user_id,message_id,room_id) VALUES($1,$2,$3)", f.local.id, m.ID, room); err != nil {
			t.Fatal(err)
		}
	}
	check := func(want int) {
		t.Helper()
		before := len(rec.sent())
		a.Push.Observe(t.Context(), uuid.MustParse(f.local.id), &v1.DispatchEvent{Event: &v1.DispatchEvent_ReadStateUpdate{ReadStateUpdate: &v1.ReadStateUpdate{}}})
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			sent := rec.sent()
			if len(sent) > before {
				p := sent[len(sent)-1]
				if p.Kind != "badge" || p.Badge == nil || *p.Badge != want {
					t.Fatalf("want badge %d, got %+v", want, p)
				}
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("badge not sent")
	}
	check(1)
	sid := uuid.MustParse(f.local.session)
	f.prove(t, sid, time.Now())
	check(2)
	if _, err := testDB.Q.RevokeWorkspaceAssurances(t.Context(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: uuid.MustParse(f.a.Id), SessionID: &sid}); err != nil {
		t.Fatal(err)
	}
	check(1)
}
