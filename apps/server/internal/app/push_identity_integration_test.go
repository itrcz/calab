//go:build integration

package app_test

import (
	"context"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

// A proof in another session must not authorize this endpoint, even for the
// same user. The dispatcher and opaque receipt resolver both recheck authority.
func TestPushIdentityExactSessionAndRevocation(t *testing.T) {
	f := identitySetup(t, "enforced")
	s, server, rec := pushHarness(t)
	registerPush(t, server, f.local, uuid.NewString(), "identity-fixture-token", 200)
	registerPush(t, server, f.scoped, uuid.NewString(), "scoped-fixture-token", 403)
	recovery := compatibilityAuthority(t, f.local, "recovery", uuid.MustParse(f.a.Id), nil)
	for _, denied := range []*user{f.scoped, recovery} {
		pushHTTP(t, server, denied, 403, "GET", "/api/me/push-capabilities", nil, nil)
		pushHTTP(t, server, denied, 403, "POST", "/api/me/push-resolve", &v1.ResolvePushRequest{}, nil)
		pushHTTP(t, server, denied, 403, "DELETE", "/api/me/push-devices/"+uuid.NewString(), &v1.UnregisterPushDeviceRequest{Version: 1}, nil)
	}
	pushAll(t, f.local, f.roomA)
	message := func() *v1.Message {
		t.Helper()
		m, err := testDB.Q.InsertMessage(t.Context(), sqlc.InsertMessageParams{RoomID: uuid.MustParse(f.roomA), AuthorID: uuid.MustParse(owner(t).id), Content: "identity fixture"})
		if err != nil {
			t.Fatal(err)
		}
		return &v1.Message{Id: m.ID.String(), RoomId: m.RoomID.String()}
	}
	s.Observe(context.Background(), uuid.Nil, pushMessage(message()))
	deliverPush(t, s)
	if len(rec.sent()) != 0 {
		t.Fatal("another session's corporate proof authorized push")
	}
	sid := uuid.MustParse(f.local.session)
	f.prove(t, sid, time.Now())
	s.Observe(context.Background(), uuid.Nil, pushMessage(message()))
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("own current proof did not authorize push")
	}
	receipt := rec.sent()[0]
	request := &v1.ResolvePushRequest{Binding: receipt.Binding, EventId: receipt.EventID}
	pushHTTP(t, server, f.local, 200, "POST", "/api/me/push-resolve", request, &v1.ResolvePushResponse{})
	// Queue while authorized, then revoke before dispatch and receipt resolution.
	s.Observe(context.Background(), uuid.Nil, pushMessage(message()))
	routePush(t, s)
	if _, err := testDB.Q.RevokeWorkspaceAssurances(t.Context(), sqlc.RevokeWorkspaceAssurancesParams{WorkspaceID: uuid.MustParse(f.a.Id), SessionID: &sid}); err != nil {
		t.Fatal(err)
	}
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("revoked exact-session proof survived dispatch")
	}
	pushHTTP(t, server, f.local, 404, "POST", "/api/me/push-resolve", request, nil)
	// A fresh proof still cannot bypass a disabled managed directory.
	f.prove(t, sid, time.Now())
	ws, uid := uuid.MustParse(f.a.Id), uuid.MustParse(f.local.id)
	dir, err := testDB.Q.CreateIdentityDirectory(t.Context(), sqlc.CreateIdentityDirectoryParams{WorkspaceID: ws, Name: "Push fixture", Host: "directory.identity.test", Url: "ldaps://directory.identity.test:636", Port: 636, AllowedGroupDns: []string{"CN=allowed,DC=identity,DC=test"}, BaseDn: "DC=identity,DC=test", BindDn: "CN=fixture,DC=identity,DC=test", BindSecretBox: []byte("fixture-only"), SyncIntervalSeconds: 300, MaxStalenessSeconds: 3600})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Q.CreateDirectoryObject(t.Context(), sqlc.CreateDirectoryObjectParams{WorkspaceID: ws, DirectoryID: dir.ID, ObjectGuid: uuid.New(), UserID: &uid, DistinguishedName: "CN=member,DC=identity,DC=test", Status: "active"}); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Pool.Exec(t.Context(), "UPDATE workspace_directories SET last_success_at=now(), disabled_at=now() WHERE id=$1", dir.ID); err != nil {
		t.Fatal(err)
	}
	s.Observe(context.Background(), uuid.Nil, pushMessage(message()))
	deliverPush(t, s)
	if len(rec.sent()) != 1 {
		t.Fatal("disabled directory authorized push")
	}
	pushHTTP(t, server, f.local, 404, "POST", "/api/me/push-resolve", request, nil)
}
