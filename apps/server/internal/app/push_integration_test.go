//go:build integration

package app_test

import (
	"context"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"google.golang.org/protobuf/proto"
	"testing"
)

func TestPushUnconfiguredPreservesOrdinaryServer(t *testing.T) {
	u := owner(t)
	var intentsBefore int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_intents").Scan(&intentsBefore); err != nil {
		t.Fatal(err)
	}
	var before int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_devices").Scan(&before); err != nil {
		t.Fatal(err)
	}
	var capabilities v1.PushCapabilitiesResponse
	u.must(200, "GET", "/api/me/push-capabilities", nil, &capabilities)
	if len(capabilities.GetProviders()) != 0 {
		t.Fatal("unconfigured providers became enabled")
	}
	u.must(503, "POST", "/api/me/push-devices", &v1.RegisterPushDeviceRequest{
		Provider: v1.PushProvider_PUSH_PROVIDER_APNS, Environment: "production", AppId: "ru.calab.test",
		InstallationId: "00000000-0000-0000-0000-000000000001", Token: "never-send-this-test-token", NotificationsEnabled: true, CallsEnabled: false, MentionsEnabled: proto.Bool(true), AllEnabled: true,
	}, nil)
	ws := createWorkspace(t, u, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	room := textRoom(t, u, ws.Id, "disabled-push", false)
	dmPost(t, u, room, "ordinary path while providers absent")
	var intentsAfter int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_intents").Scan(&intentsAfter); err != nil || intentsAfter != intentsBefore {
		t.Fatal("unconfigured publisher accumulated routing outbox")
	}
	var rows int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_devices").Scan(&rows); err != nil || rows != before {
		t.Fatalf("disabled registry: rows=%d err=%v", rows, err)
	}
}
