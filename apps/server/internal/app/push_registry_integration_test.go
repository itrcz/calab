//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type pushSink struct{}

func (pushSink) Send(context.Context, push.Endpoint, push.Payload) push.Result {
	panic("registry test must not dispatch")
}
func pushServer(t *testing.T) *httptest.Server {
	t.Helper()
	a := app.New(app.Deps{Config: testCfg, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec,
		Push: map[v1.PushProvider]push.Provider{v1.PushProvider_PUSH_PROVIDER_FCM: {AppID: "ru.calab.test", Environment: "production", Sender: pushSink{}}}})
	server := httptest.NewServer(a.Handler)
	t.Cleanup(server.Close)
	return server
}
func pushHTTP(t *testing.T, server *httptest.Server, u *user, status int, method, path string, in, out proto.Message) {
	t.Helper()
	var data []byte
	var err error
	if in != nil {
		data, err = protojson.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, server.URL+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+u.token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Forwarded-For", u.ip)
	result, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = result.Body.Close() }()
	body, err := io.ReadAll(result.Body)
	if err != nil {
		t.Fatal(err)
	}
	if result.StatusCode != status {
		t.Fatalf("%s %s: status%d want%d", method, path, result.StatusCode, status)
	}
	if out != nil {
		if err := protojson.Unmarshal(body, out); err != nil {
			t.Fatal(err)
		}
	}
}
func registerPush(t *testing.T, server *httptest.Server, u *user, installation, token string, status int) *v1.RegisterPushDeviceResponse {
	t.Helper()
	result := &v1.RegisterPushDeviceResponse{}
	var out proto.Message
	if status == 200 {
		out = result
	}
	pushHTTP(t, server, u, status, "POST", "/api/me/push-devices", &v1.RegisterPushDeviceRequest{Provider: v1.PushProvider_PUSH_PROVIDER_FCM, Environment: "production", AppId: "ru.calab.test", InstallationId: installation, Token: token, NotificationsEnabled: true, CallsEnabled: false, MentionsEnabled: proto.Bool(true), AllEnabled: true}, out)
	if status == 200 {
		// Each integration test owns its registered endpoints; receipts/backlog must not
		// bleed into another test's real global dispatcher.
		t.Cleanup(func() {
			_, _ = testDB.Pool.Exec(context.Background(), "DELETE FROM push_devices WHERE id=$1 AND user_id=$2 AND session_id=$3", result.Id, u.id, u.session)
		})
	}
	return result
}
func TestPushRegistryOwnershipRotationAndLogout(t *testing.T) {
	server := pushServer(t)
	u := owner(t)
	other := secondDevice(t, u)
	const installation = "00000000-0000-0000-0000-000000000011"
	const installation2 = "00000000-0000-0000-0000-000000000012"
	first := registerPush(t, server, u, installation, "routing-token-original", 200)
	repeated := registerPush(t, server, u, installation, "routing-token-original", 200)
	if first.Id != repeated.Id || first.Version != repeated.Version {
		t.Fatal("idempotent registration rotated")
	}
	registerPush(t, server, other, installation2, "routing-token-original", 409)
	pushHTTP(t, server, other, 404, "DELETE", "/api/me/push-devices/"+first.Id, &v1.UnregisterPushDeviceRequest{Version: first.Version}, nil)
	rotated := registerPush(t, server, u, installation, "routing-token-rotated", 200)
	if rotated.Id != first.Id || rotated.Version != first.Version+1 {
		t.Fatal("rotation lost binding/version")
	}
	pushHTTP(t, server, u, 404, "DELETE", "/api/me/push-devices/"+first.Id, &v1.UnregisterPushDeviceRequest{Version: first.Version}, nil)
	latest := registerPush(t, server, other, installation2, "routing-token-original", 200)
	other.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{RefreshToken: other.refresh}, nil)
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_devices WHERE id=$1", latest.Id).Scan(&count); err != nil || count != 0 {
		t.Fatalf("logout cleanup count=%d err=%v", count, err)
	}
	pushHTTP(t, server, u, 204, "DELETE", "/api/me/push-devices/"+rotated.Id, &v1.UnregisterPushDeviceRequest{Version: rotated.Version}, nil)
}
func TestPushRegistrationDoesNotTrustCachedSession(t *testing.T) {
	server := pushServer(t)
	u := secondDevice(t, owner(t))
	var caps v1.PushCapabilitiesResponse
	pushHTTP(t, server, u, 200, "GET", "/api/me/push-capabilities", nil, &caps)
	if len(caps.Providers) != 1 {
		t.Fatal("configured fake capability missing")
	}
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE sessions SET revoked_at=$2 WHERE id=$1", u.session, time.Now()); err != nil {
		t.Fatal(err)
	}
	registerPush(t, server, u, "00000000-0000-0000-0000-000000000013", "late-registration", 401)
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM push_devices WHERE session_id=$1", u.session).Scan(&count); err != nil || count != 0 {
		t.Fatalf("revoked registration count=%d err=%v", count, err)
	}
}

// The cleanup statement starts with committed expired facts while a renewal owns
// the row lock. It must skip the locked owner, never delete its newly current row.
func TestPushCleanupDoesNotDeleteConcurrentRenewal(t *testing.T) {
	server := pushServer(t)
	for _, mode := range []string{"same-token-refresh", "token-rotation", "session-renewal"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			u := secondDevice(t, owner(t))
			endpoint := registerPush(t, server, u, uuid.NewString(), "cleanup-"+mode, 200)
			column, table, id := "expires_at", "push_devices", endpoint.Id
			switch mode {
			case "session-renewal":
				table = "sessions"
				id = u.session
			}
			if _, err := testDB.Pool.Exec(ctx, "UPDATE "+table+" SET "+column+"=now()-interval '1 minute' WHERE id=$1", id); err != nil {
				t.Fatal(err)
			}
			renewal, err := testDB.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = renewal.Rollback(context.Background()) }()
			switch mode {
			case "session-renewal":
				_, err = renewal.Exec(ctx, "UPDATE sessions SET expires_at=now()+interval '1 day' WHERE id=$1", id)
			case "token-rotation":
				_, err = renewal.Exec(ctx, "UPDATE push_devices SET version=version+1,expires_at=now()+interval '1 day' WHERE id=$1", id)
			default:
				_, err = renewal.Exec(ctx, "UPDATE push_devices SET expires_at=now()+interval '1 day' WHERE id=$1", id)
			}
			if err != nil {
				t.Fatal(err)
			}
			cleanup, err := testDB.Pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup.Release()
			type outcome struct {
				rows int64
				err  error
			}
			done := make(chan outcome, 1)
			go func() { rows, err := sqlc.New(cleanup).CleanupPushDevices(ctx); done <- outcome{rows, err} }()
			// Observe a real blocked cleanup before releasing renewal (old SQL), or its
			// immediate SKIP LOCKED completion (correct SQL), without a timing assumption.
			var result *outcome
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			observed := false
			for !observed {
				select {
				case value := <-done:
					result = &value
					observed = true
				case <-ticker.C:
					var waiting bool
					if err := testDB.Pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')", cleanup.Conn().PgConn().PID()).Scan(&waiting); err != nil {
						t.Fatal(err)
					}
					observed = waiting
				case <-ctx.Done():
					t.Fatal("cleanup neither completed nor acquired a real lock wait")
				}
			}
			if err := renewal.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if result == nil {
				select {
				case value := <-done:
					result = &value
				case <-ctx.Done():
					t.Fatal("cleanup did not settle")
				}
			}
			if result.err != nil {
				t.Fatal(result.err)
			}
			var exists bool
			if err := testDB.Pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM push_devices WHERE id=$1)", endpoint.Id).Scan(&exists); err != nil {
				t.Fatal(err)
			}
			if !exists {
				t.Fatalf("cleanup deleted renewed endpoint (%s), rows=%d", mode, result.rows)
			}
			pushHTTP(t, server, u, 204, "DELETE", "/api/me/push-devices/"+endpoint.Id, &v1.UnregisterPushDeviceRequest{Version: endpoint.Version + boolVersion(mode == "token-rotation")}, nil)
		})
	}
}
func boolVersion(rotated bool) uint64 {
	if rotated {
		return 1
	}
	return 0
}

func TestPushRegistryRejectsDifferentUserOwnership(t *testing.T) {
	server := pushServer(t)
	u := owner(t)
	ws := createWorkspace(t, u, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	stranger := register(t, invite(t, u, ws.Id))
	endpoint := registerPush(t, server, u, uuid.NewString(), "cross-user-endpoint", 200)
	registerPush(t, server, stranger, uuid.NewString(), "cross-user-endpoint", 409)
	pushHTTP(t, server, stranger, 404, "DELETE", "/api/me/push-devices/"+endpoint.Id, &v1.UnregisterPushDeviceRequest{Version: endpoint.Version}, nil)
	pushHTTP(t, server, u, 204, "DELETE", "/api/me/push-devices/"+endpoint.Id, &v1.UnregisterPushDeviceRequest{Version: endpoint.Version}, nil)
}
