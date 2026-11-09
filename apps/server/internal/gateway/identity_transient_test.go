package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Incident 2026-10-05: a dependency failure is not a revocation, a decision is.
func TestIdentityTransientClassification(t *testing.T) {
	none := identitypolicy.Decision{}
	for _, c := range []struct {
		name      string
		d         identitypolicy.Decision
		err       error
		transient bool
	}{
		{"deadline", none, context.DeadlineExceeded, true},
		{"canceled", none, context.Canceled, true},
		{"unknown", none, errors.New("conn reset"), true},
		{"503", none, httpx.Unavailable(errors.New("db")), true},
		{"wrapped 503", none, fmt.Errorf("check: %w", httpx.Unavailable(errors.New("db"))), true},
		{"409 other", none, httpx.Conflict("busy"), true},
		{"unavailable decision", identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, nil, true},
		{"401", none, httpx.Unauthenticated("x"), false},
		{"403", none, httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "x"), false},
		{"404", none, httpx.NotFound("workspace"), false},
		{"409 plan limit", none, httpx.Conflict("x").WithDetails(httpx.ReasonPlanLimit, 0, 0), false},
		{"denied", identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, fmt.Errorf("x: %w", identitypolicy.ErrDenied), false},
		{"revoked", none, auth.ErrSessionRevoked, false},
		{"no rows", none, fmt.Errorf("load: %w", pgx.ErrNoRows), false},
		{"denial decision", identitypolicy.Decision{Reason: identitypolicy.MembershipRequired}, nil, false},
		{"allowed", identitypolicy.Decision{Allowed: true, Reason: identitypolicy.Allowed}, nil, false},
	} {
		if got := identityTransient(c.d, c.err); got != c.transient {
			t.Errorf("%s: transient=%v, want %v", c.name, got, c.transient)
		}
	}
}

func workspaceDeletes(t *testing.T, s *Session, ws uuid.UUID) int {
	t.Helper()
	n := 0
	for _, e := range drain(s) {
		if decode(t, e).GetDispatch().GetWorkspaceDelete().GetWorkspaceId() == ws.String() {
			n++
		}
	}
	return n
}

func subscribedTo(s *Session, ws uuid.UUID) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.workspaces[ws]
}

func setLeaseUntil(s *Session, ws uuid.UUID, until time.Time) {
	s.leases.mu.Lock()
	l := s.leases.workspaces[ws]
	l.until = until
	s.leases.workspaces[ws] = l
	s.leases.mu.Unlock()
}

func leaseUntil(s *Session, ws uuid.UUID) time.Time {
	s.leases.mu.Lock()
	defer s.leases.mu.Unlock()
	return s.leases.workspaces[ws].until
}

func setLeaseConfirmed(s *Session, ws uuid.UUID, confirmed time.Time) {
	s.leases.mu.Lock()
	l := s.leases.workspaces[ws]
	l.confirmed = confirmed
	s.leases.workspaces[ws] = l
	s.leases.mu.Unlock()
}

// ADR-0166: an undecided check (a database stall of a few minutes, full or partial) keeps the
// workspace and its events for the transient grace after the last positive decision; past it
// the session fails closed by holding events back and a resync — never by WORKSPACE_DELETE.
func TestIdentitySweepTransientRidesOutWithinGrace(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	drain(s)
	slow := errors.New("timeout: context deadline exceeded")

	// Full stall: the membership read fails. The lease has already lapsed (a skipped pass):
	// ridden out, nothing removed.
	h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return nil, slow }
	setLeaseUntil(s, ws, time.Now().Add(-time.Millisecond))
	h.enforceIdentitySession(context.Background(), s)
	if workspaceDeletes(t, s, ws) != 0 || !s.workspaceLeaseAllows(ws) || !subscribedTo(s, ws) || s.broken.Load() {
		t.Fatal("full stall: the workspace was not kept")
	}

	// Partial stall: membership reads, the lease check fails. Ridden out too.
	h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return []uuid.UUID{ws}, nil }
	h.checkWorkspace = func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, time.Now(), slow
	}
	setLeaseUntil(s, ws, time.Now().Add(-time.Millisecond))
	h.enforceIdentitySession(context.Background(), s)
	if workspaceDeletes(t, s, ws) != 0 || !s.workspaceLeaseAllows(ws) || !subscribedTo(s, ws) || s.broken.Load() {
		t.Fatal("partial stall: the workspace was not kept")
	}
	if !s.allowsEvent(leaseEvent(ws)) {
		t.Fatal("partial stall: events held back within the grace")
	}
	if left := time.Until(leaseUntil(s, ws)); left <= identityRefreshAhead || left > identitypolicy.ReadLeaseTTL {
		t.Fatalf("a ridden-out lease lasts %v, want one ReadLeaseTTL at most", left)
	}

	// Never past the decision's own deadline (an identity proof, a directory scan).
	s.leases.mu.Lock()
	l := s.leases.workspaces[ws]
	l.hard = time.Now().Add(-time.Millisecond)
	l.until = l.hard
	s.leases.workspaces[ws] = l
	s.leases.mu.Unlock()
	_, _ = s.refreshWorkspaceLease(context.Background(), ws)
	if s.workspaceLeaseAllows(ws) {
		t.Fatal("a lease rode past its hard deadline")
	}

	// Past the grace: still no verdict, the lease is gone. Fail closed without a verdict —
	// no WORKSPACE_DELETE; the session resyncs (a fresh READY lists it as pending).
	s.leases.mu.Lock()
	l = s.leases.workspaces[ws]
	l.hard = time.Now().Add(time.Hour)
	l.until = time.Now().Add(-time.Millisecond)
	s.leases.workspaces[ws] = l
	s.leases.mu.Unlock()
	setLeaseConfirmed(s, ws, time.Now().Add(-h.identityGrace()-time.Second))
	h.enforceIdentitySession(context.Background(), s)
	if workspaceDeletes(t, s, ws) != 0 {
		t.Fatal("an undecided check sent WORKSPACE_DELETE")
	}
	if s.workspaceLeaseAllows(ws) || s.allowsEvent(leaseEvent(ws)) {
		t.Fatal("access outlived the transient grace")
	}
	if !s.broken.Load() {
		t.Fatal("past the grace the session was not made to resync")
	}
}

// The event path: an event of a workspace whose lease lapsed during a stall is delivered
// after its refresh rides the lease out, not turned into a resync of the session.
func TestIdentityTransientEventRidesOut(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	drain(s)
	h.checkWorkspace = func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		return identitypolicy.Decision{}, time.Now(), context.DeadlineExceeded
	}
	h.checkPrincipal = func(context.Context, auth.Identity) (identitypolicy.Principal, time.Time, error) {
		return identitypolicy.Principal{}, time.Now(), context.DeadlineExceeded
	}
	setLeaseUntil(s, ws, time.Now().Add(-time.Millisecond))
	s.leases.mu.Lock()
	s.leases.session.until = time.Now().Add(-time.Millisecond)
	s.leases.mu.Unlock()
	s.dispatchEnc(uuid.New(), leaseEvent(ws))
	select {
	case job := <-h.preparations:
		job()
	case <-time.After(time.Second):
		t.Fatal("the event was not prepared")
	}
	if out := drain(s); len(out) != 1 || s.broken.Load() {
		t.Fatalf("event during a stall: delivered %d, broken %v", len(out), s.broken.Load())
	}
}

// The heartbeat recheck of the auth session: undecided keeps the socket within the grace
// (the closing paths: identity_stall_integration_test.go).
func TestSessionRecheckTransientKeepsSocket(t *testing.T) {
	h := leaseTestHub()
	s := leasedSession(h, uuid.New())
	h.checkSession = func(context.Context, uuid.UUID) error { return context.DeadlineExceeded }
	if h.sessionRevoked(s) {
		t.Fatal("a timeout of the session recheck closed the socket")
	}
	before := s.authConfirmed.Load()
	h.checkSession = func(context.Context, uuid.UUID) error { return nil }
	if h.sessionRevoked(s) || s.authConfirmed.Load() < before {
		t.Fatal("a confirmed session was closed or not stamped")
	}
}

func TestIdentitySweepDenialActsAtOnce(t *testing.T) {
	type checkFn = func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error)
	for name, check := range map[string]checkFn{
		"denied": func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
			return identitypolicy.Decision{Reason: identitypolicy.WorkspaceSuspended}, time.Now(), identitypolicy.ErrDenied
		},
		"no rows": func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
			return identitypolicy.Decision{Reason: identitypolicy.StateUnavailable}, time.Now(), pgx.ErrNoRows
		},
		// The decision was made, then the gate deadline passed: still a denial.
		"denied after deadline": func(ctx context.Context, _ auth.Identity, _ uuid.UUID) (identitypolicy.Decision, time.Time, error) {
			<-ctx.Done()
			return identitypolicy.Decision{Reason: identitypolicy.MembershipSuspended}, time.Now(), identitypolicy.ErrDenied
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := leaseTestHub()
			ws := uuid.New()
			s := leasedSession(h, ws)
			drain(s)
			h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return []uuid.UUID{ws}, nil }
			h.checkWorkspace = check
			// The event path (deferIdentityEvent/READY) refreshes a valid lease directly.
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			_, _ = s.refreshWorkspaceLease(ctx, ws)
			cancel()
			if s.workspaceLeaseAllows(ws) {
				t.Fatal("denial kept the positive lease")
			}
			h.enforceIdentitySession(context.Background(), s)
			if workspaceDeletes(t, s, ws) != 1 || subscribedTo(s, ws) {
				t.Fatal("denial did not remove the workspace")
			}
		})
	}

	t.Run("membership removed", func(t *testing.T) {
		h := leaseTestHub()
		ws := uuid.New()
		s := leasedSession(h, ws)
		drain(s)
		h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return nil, nil }
		h.enforceIdentitySession(context.Background(), s)
		if workspaceDeletes(t, s, ws) != 1 || s.workspaceLeaseAllows(ws) {
			t.Fatal("removed member kept the workspace")
		}
	})
}

// A durable invalidation tombstones the lease; neither a transient refresh after it nor
// a stale positive result once the DB is back can resurrect access.
func TestIdentityTransientCannotResurrectInvalidatedLease(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	allow := h.checkWorkspace
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":2,"access_version":1}`, ws))
	if s.allowsEvent(leaseEvent(ws)) {
		t.Fatal("notice did not invalidate")
	}
	h.checkWorkspace = func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		return identitypolicy.Decision{}, time.Now(), context.DeadlineExceeded
	}
	_, _ = s.refreshWorkspaceLease(context.Background(), ws)
	if s.allowsEvent(leaseEvent(ws)) {
		t.Fatal("transient refresh resurrected an invalidated lease")
	}
	h.checkWorkspace = allow // policy version 1 < tombstone 2
	_, _ = s.refreshWorkspaceLease(context.Background(), ws)
	if s.allowsEvent(leaseEvent(ws)) {
		t.Fatal("stale positive decision resurrected an invalidated lease")
	}
}

func TestIdentitySessionLeaseTransientVersusRevoked(t *testing.T) {
	h := leaseTestHub()
	s := leasedSession(h, uuid.New())
	h.checkPrincipal = func(context.Context, auth.Identity) (identitypolicy.Principal, time.Time, error) {
		return identitypolicy.Principal{}, time.Now(), context.DeadlineExceeded
	}
	s.refreshSessionLease(context.Background())
	if !s.sessionLeaseAllows() {
		t.Fatal("transient principal read dropped the session lease")
	}
	// Lapsed during the stall, confirmed within the grace: ridden out (ADR-0166).
	s.leases.mu.Lock()
	s.leases.session.until = time.Now().Add(-time.Millisecond)
	s.leases.mu.Unlock()
	s.refreshSessionLease(context.Background())
	if !s.sessionLeaseAllows() {
		t.Fatal("transient principal read did not ride out a lapsed session lease")
	}
	// Past the grace: no more.
	s.leases.mu.Lock()
	s.leases.session.until = time.Now().Add(-time.Millisecond)
	s.leases.session.confirmed = time.Now().Add(-h.identityGrace() - time.Second)
	s.leases.mu.Unlock()
	s.refreshSessionLease(context.Background())
	if s.sessionLeaseAllows() {
		t.Fatal("transient principal read extended a session lease past the grace")
	}
	h.checkPrincipal = func(_ context.Context, id auth.Identity) (identitypolicy.Principal, time.Time, error) {
		return id.Principal, time.Now(), nil
	}
	s.refreshSessionLease(context.Background())
	if !s.sessionLeaseAllows() {
		t.Fatal("recovered principal read did not restore the session lease")
	}
	h.checkPrincipal = func(context.Context, auth.Identity) (identitypolicy.Principal, time.Time, error) {
		return identitypolicy.Principal{}, time.Now(), auth.ErrSessionRevoked
	}
	s.refreshSessionLease(context.Background())
	if s.sessionLeaseAllows() {
		t.Fatal("revoked session kept its lease")
	}
}
