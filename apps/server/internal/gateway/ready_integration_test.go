//go:build integration

package gateway

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// Board #145: READY must not drop a workspace the user still has because of a transient
// failure («I got disconnected, it threw me to the create-workspace page, then everything
// came back»). A failed check fails READY ("try again"); a pending lease is listed as pending;
// only a real "not a member" leaves the workspace out silently.
func TestReadyTransientFailureIsNotNoWorkspace(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	uid, ws := uuid.New(), uuid.New()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name)VALUES($1,$2,'Ready Fixture')`, []any{uid, uid.String() + "@ready.test"}},
		{`INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'Ready',$3)`, []any{ws, "ready-" + ws.String()[:12], uid}},
		{`INSERT INTO workspace_members(workspace_id,user_id,role)VALUES($1,$2,'owner')`, []any{ws, uid}},
	} {
		if _, err := d.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws)
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, uid)
	})

	h := New(Config{}, d, rc, nil, nil)
	h.checkPrincipal = func(_ context.Context, id auth.Identity) (identitypolicy.Principal, time.Time, error) {
		return id.Principal, time.Now(), nil
	}
	allow := func(_ context.Context, id auth.Identity, _ uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		now := time.Now()
		return identitypolicy.Decision{Allowed: true, Reason: identitypolicy.Allowed, ValidUntil: now.Add(time.Hour), Versions: identitypolicy.Versions{Session: id.Principal.Version}}, now, nil
	}
	member := func(context.Context, uuid.UUID, uuid.UUID) (perm.Member, error) {
		return perm.NewMember(uid.String(), perm.Role("owner"), nil), nil
	}
	session := func() *Session {
		s := testSession()
		s.user = uid
		s.hub = h
		s.asess = uuid.New()
		s.principal = identitypolicy.Principal{SessionID: s.asess, UserID: uid, Authority: identitypolicy.LocalAccount, Version: 1, ExpiresAt: time.Now().Add(time.Hour)}
		s.refreshSessionLease(ctx)
		return s
	}
	build := func(check func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error)) (*Session, *v1.Ready, error) {
		h.checkWorkspace = check
		s := session()
		r, err := h.buildReady(ctx, s, uid)
		return s, r, err
	}

	h.readyMember = member
	_, r, err := build(allow)
	if err != nil || len(r.GetWorkspaces()) != 1 || len(r.GetPendingWorkspaceIds()) != 0 {
		t.Fatalf("baseline: err %v, workspaces %d, pending %v", err, len(r.GetWorkspaces()), r.GetPendingWorkspaceIds())
	}

	// (b) The access check times out: READY fails (the client retries the connect and keeps
	// its state) instead of carrying a DEPENDENCY_UNAVAILABLE lock without the snapshot.
	timeout := func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, time.Time{}, context.DeadlineExceeded
	}
	if _, r, err := build(timeout); err == nil {
		t.Fatalf("transient access check: READY built (workspaces %d, access %v)", len(r.GetWorkspaces()), r.GetIdentityAccess())
	}
	// A definitive denial still closes the workspace in READY (not weakened).
	denied := func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		return identitypolicy.Decision{Reason: identitypolicy.SSORequired}, time.Now(), identitypolicy.ErrDenied
	}
	if _, r, err := build(denied); err != nil || len(r.GetWorkspaces()) != 0 || len(r.GetIdentityAccess()) != 1 ||
		r.GetIdentityAccess()[0].GetReason() != v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SSO_REQUIRED || len(r.GetPendingWorkspaceIds()) != 0 {
		t.Fatalf("denial: err %v, ready %v", err, r)
	}

	// (c) The member read times out: READY fails, not "not a member".
	h.readyMember = func(context.Context, uuid.UUID, uuid.UUID) (perm.Member, error) {
		return perm.Member{}, fmt.Errorf("perm: load member: %w", context.DeadlineExceeded)
	}
	if _, r, err := build(allow); err == nil {
		t.Fatalf("transient member read: READY built (workspaces %d)", len(r.GetWorkspaces()))
	}
	// Really not a member (left since the list): left out, as before.
	h.readyMember = func(context.Context, uuid.UUID, uuid.UUID) (perm.Member, error) {
		return perm.Member{}, perm.ErrNotMember
	}
	if _, r, err := build(allow); err != nil || len(r.GetWorkspaces()) != 0 || len(r.GetPendingWorkspaceIds()) != 0 {
		t.Fatalf("not a member: err %v, ready %v", err, r)
	}
	h.readyMember = member

	// (a) Allowed, but every evaluation is raced by an invalidation: left out as pending —
	// listed in pending_workspace_ids, no access entry (not a lock), omitted for its events.
	var s *Session
	raced := func(ctx context.Context, id auth.Identity, w uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		s.leases.mu.Lock()
		s.leases.revision++
		s.leases.mu.Unlock()
		return allow(ctx, id, w)
	}
	h.checkWorkspace = raced
	s = session()
	r, err = h.buildReady(ctx, s, uid)
	if err != nil || len(r.GetWorkspaces()) != 0 || len(r.GetIdentityAccess()) != 0 || len(r.GetPendingWorkspaceIds()) != 1 || r.GetPendingWorkspaceIds()[0] != ws.String() {
		t.Fatalf("pending lease: err %v, ready %v", err, r)
	}
	if got := s.omittedWorkspaces(); len(got) != 1 || got[0] != ws {
		t.Fatalf("pending workspace not omitted: %v", got)
	}
}
