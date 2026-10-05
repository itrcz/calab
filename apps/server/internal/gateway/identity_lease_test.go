package gateway

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

func leaseTestHub() *Hub {
	h := New(Config{}, nil, nil, nil, nil)
	h.checkPrincipal = func(_ context.Context, id auth.Identity) (identitypolicy.Principal, time.Time, error) {
		return id.Principal, time.Now(), nil
	}
	h.checkWorkspace = func(_ context.Context, id auth.Identity, _ uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		now := time.Now()
		return identitypolicy.Decision{Allowed: true, ValidUntil: now.Add(time.Hour), Versions: identitypolicy.Versions{Session: id.Principal.Version, Policy: 1, Access: 1, Connection: 1, Identity: 1, Entitlement: 1}}, now, nil
	}
	return h
}
func leasedSession(h *Hub, ws uuid.UUID) *Session {
	s := testSession()
	s.hub = h
	s.asess = uuid.New()
	s.ready = true
	s.principal = identitypolicy.Principal{SessionID: s.asess, UserID: s.user, Authority: identitypolicy.LocalAccount, Version: 1, ExpiresAt: time.Now().Add(time.Hour)}
	s.refreshSessionLease(context.Background())
	_, _ = s.refreshWorkspaceLease(context.Background(), ws)
	h.mu.Lock()
	h.sessions[s.id] = s
	h.byUser[s.user] = map[*Session]bool{s: true}
	h.mu.Unlock()
	h.joinWorkspace(s, ws)
	return s
}
func leaseEvent(ws uuid.UUID) *encEvent {
	return newScopedEnc(ws, &v1.DispatchEvent{Event: &v1.DispatchEvent_CategoryDelete{CategoryDelete: &v1.CategoryDelete{WorkspaceId: ws.String(), CategoryId: uuid.NewString()}}})
}

func TestIdentityLeaseSlowRefreshDoesNotSerializeFanout(t *testing.T) {
	h := leaseTestHub()
	a, b := uuid.New(), uuid.New()
	h.states[a] = &wsState{}
	h.states[b] = &wsState{}
	sessions := make([]*Session, 120)
	for i := range sessions {
		sessions[i] = leasedSession(h, a)
	}
	unrelated := leasedSession(h, b)
	var calls atomic.Int32
	blocked := make(chan struct{})
	release := make(chan struct{})
	h.checkWorkspace = func(ctx context.Context, _ auth.Identity, _ uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		if calls.Add(1) == 1 {
			close(blocked)
		}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return identitypolicy.Decision{}, time.Now(), errors.New("slow database")
	}
	var workers sync.WaitGroup
	jobs := make(chan *Session, 120)
	for _, s := range sessions {
		jobs <- s
	}
	close(jobs)
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for s := range jobs {
				_, _ = s.refreshWorkspaceLease(context.Background(), a)
			}
		}()
	}
	<-blocked
	started := time.Now()
	done := make(chan struct{})
	go func() {
		h.routeWorkspace(a, uuid.New(), leaseEvent(a).ev)
		h.routeWorkspace(b, uuid.New(), leaseEvent(b).ev)
		h.leaveWorkspace(sessions[0], a)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		close(release)
		workers.Wait()
		t.Fatal("slow dependency held workspace/session fanout locks")
	}
	t.Logf("120 recipients and unrelated workspace progressed in %s with %d blocked refreshes", time.Since(started), calls.Load())
	for _, s := range sessions {
		if len(drain(s)) != 1 {
			t.Fatal("warm 120-recipient fanout changed")
		}
	}
	if len(drain(unrelated)) != 1 {
		t.Fatal("unrelated workspace blocked")
	}
	if calls.Load() > 8 {
		t.Fatalf("refresh concurrency unbounded: %d", calls.Load())
	}
	close(release)
	workers.Wait()
	// A dependency failure is not a revocation (incident 2026-10-05): the stored lease
	// stays until it expires. A definitive denial drops it at once.
	for _, s := range sessions[1:] { // sessions[0] left the workspace above
		if !s.allowsEvent(leaseEvent(a)) {
			t.Fatal("transient refresh error dropped a positive lease")
		}
	}
	h.checkWorkspace = func(context.Context, auth.Identity, uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		return identitypolicy.Decision{Reason: identitypolicy.MembershipRequired}, time.Now(), nil
	}
	_, _ = sessions[1].refreshWorkspaceLease(context.Background(), a)
	if sessions[1].allowsEvent(leaseEvent(a)) {
		t.Fatal("denial kept positive lease")
	}
}

func TestIdentityLeaseExpiryInvalidationScopeAndPending(t *testing.T) {
	h := leaseTestHub()
	a, b := uuid.New(), uuid.New()
	s := leasedSession(h, a)
	if s.allowsEvent(leaseEvent(b)) || s.allowsEvent(newEnc(&v1.DispatchEvent{})) {
		t.Fatal("unknown scope allowed")
	}
	s.principal.Authority = identitypolicy.WorkspaceSSO
	s.principal.WorkspaceID = a
	s.principal.ConnectionID = uuid.New()
	global := newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{PresenceUpdate: &v1.PresenceUpdate{Presence: &v1.Presence{UserId: s.user.String()}}}})
	h.prepareEvent(context.Background(), global)
	if s.allowsEvent(global) {
		t.Fatal("scoped session saw global/DM authority")
	}
	marker := s.pause()
	s.dispatchEnc(uuid.New(), leaseEvent(a))
	s.leases.mu.Lock()
	l := s.leases.workspaces[a]
	l.until = time.Now().Add(-time.Second)
	s.leases.workspaces[a] = l
	s.leases.mu.Unlock()
	s.resumeMany(marker, nil)
	if len(drain(s)) != 0 {
		t.Fatal("expired pending frame escaped at actual emission")
	}
	_, _ = s.refreshWorkspaceLease(context.Background(), a)
	before := s.leases.workspaces[a].until
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":2}`, a.String()))
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":2}`, a.String()))
	if s.allowsEvent(leaseEvent(a)) {
		t.Fatal("invalidation kept lease")
	}
	if !s.leases.workspaces[a].until.IsZero() || before.IsZero() {
		t.Fatal("invalidation did not revoke without extension")
	}
}

func TestIdentityLeaseClockAndExactSessionDeadlines(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	started := time.Now()
	dbNow := started.Add(time.Hour)
	d := identitypolicy.Decision{Allowed: true, ValidUntil: dbNow.Add(2 * time.Second), Versions: identitypolicy.Versions{Session: 1}}
	s.principal.ExpiresAt = dbNow.Add(time.Hour)
	l := s.lease(d, ws, started, dbNow, 0)
	if remaining := time.Until(l.until); remaining <= 0 || remaining > 2*time.Second {
		t.Fatalf("ahead DB clock extended exact deadline: %s", remaining)
	}
	s.principal.ExpiresAt = dbNow.Add(100 * time.Millisecond)
	if remaining := time.Until(s.lease(d, ws, started, dbNow, 0).until); remaining > 100*time.Millisecond {
		t.Fatal("session expiry not capped")
	}
	d.Versions.Session = 2
	if s.lease(d, ws, started, dbNow, 0).session != uuid.Nil {
		t.Fatal("different authority version reused")
	}
	l.session = uuid.New()
	if s.validLease(l, ws) {
		t.Fatal("different device lease reused")
	}
}

func TestIdentityLeaseSessionExpiryAndBounds(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	s.leases.mu.Lock()
	s.leases.session.until = time.Now().Add(-time.Second)
	s.leases.mu.Unlock()
	if s.allowsEvent(leaseEvent(ws)) {
		t.Fatal("expired session allowed workspace")
	}
	for i := 0; i < 266; i++ {
		_, _ = s.refreshWorkspaceLease(context.Background(), uuid.New())
	}
	if len(s.leases.workspaces) != 267 {
		t.Fatal("supported durable memberships lost their positive leases")
	}
	s.ready = false
	s.hub = nil // queue bounding is independent of identity
	for i := 0; i < bufferQueue+10; i++ {
		s.dispatch(uuid.New(), roomEv(i))
	}
	if len(s.pending) > bufferQueue || !s.broken.Load() {
		t.Fatal("pending overflow not bounded")
	}
}

func TestIdentityLeaseUserPreparationOrderDedupAndRevocation(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	event := leaseEvent(ws).ev
	id := uuid.New()
	h.routeUser(s.user, id, event)
	h.routeUser(s.user, id, event) // duplicate cannot reserve another marker
	h.routeUser(s.user, uuid.New(), event)
	if len(h.preparations) != 2 {
		t.Fatal("duplicate preparation not bounded/deduped")
	}
	first, second := <-h.preparations, <-h.preparations
	second() // completion order cannot reorder the original sentinel
	s.dispatchEnc(uuid.New(), leaseEvent(ws))
	if len(drain(s)) != 0 {
		t.Fatal("later workspace event overtook user preparation")
	}
	first()
	frames := drain(s)
	if len(frames) != 3 || frames[0].id != id || frames[0].seq != 1 || frames[1].seq != 2 || frames[2].seq != 3 {
		t.Fatal("preparation order/dedup changed sequence")
	}
	h.routeUser(s.user, uuid.New(), event)
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":2}`, ws.String()))
	(<-h.preparations)()
	if len(drain(s)) != 0 {
		t.Fatal("invalidated asynchronous event escaped")
	}
}

func TestIdentityLeaseBacklogRechecksBeforeEmission(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	st := &wsState{loading: true}
	h.states[ws] = st
	h.routeWorkspace(ws, uuid.New(), leaseEvent(ws).ev)
	if len(st.backlog) != 1 || len(drain(s)) != 0 {
		t.Fatal("loading workspace did not retain event")
	}
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":2}`, ws.String()))
	st.mu.Lock()
	p := st.backlog[0]
	h.routeLocked(st, ws, p.id, p.enc.ev)
	st.loading = false
	st.mu.Unlock()
	if len(drain(s)) != 0 {
		t.Fatal("invalidated backlog payload emitted")
	}
}

func TestIdentityLeaseScopedInvalidationPreservesIndependentBAndDM(t *testing.T) {
	h := leaseTestHub()
	a, b := uuid.New(), uuid.New()
	s := leasedSession(h, a)
	h.joinWorkspace(s, b)
	_, _ = s.refreshWorkspaceLease(context.Background(), b)
	global := newEnc(&v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{PresenceUpdate: &v1.PresenceUpdate{Presence: &v1.Presence{UserId: s.user.String()}}}})
	h.prepareEvent(context.Background(), global)
	before := s.leases.workspaces[b].until
	payload := fmt.Sprintf(`{"workspace":%q,"policy_version":2}`, a.String())
	h.identityNotification(payload)
	h.identityNotification(payload)
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":1}`, a.String()))
	h.IdentityChanged() // direct outbox callback with no attribution cannot deny global authority
	if !s.allowsEvent(leaseEvent(b)) || !s.allowsEvent(global) {
		t.Fatal("A churn denied independent B/global DM authority")
	}
	if s.allowsEvent(leaseEvent(a)) {
		t.Fatal("advanced A policy retained positive lease")
	}
	if !s.leases.workspaces[b].until.Equal(before) {
		t.Fatal("notification extended independent B deadline")
	}
}

func countingChecks(h *Hub) (map[uuid.UUID]int, func() int, *sync.Mutex) {
	var mu sync.Mutex
	seen := map[uuid.UUID]int{}
	original := h.checkWorkspace
	h.checkWorkspace = func(ctx context.Context, id auth.Identity, ws uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		mu.Lock()
		seen[ws]++
		mu.Unlock()
		return original(ctx, id, ws)
	}
	total := func() int {
		mu.Lock()
		defer mu.Unlock()
		n := 0
		for _, c := range seen {
			n += c
		}
		return n
	}
	return seen, total, &mu
}

// A user in many workspaces: every lease is re-evaluated before it lapses (the per-pass
// budget covers all of them within the refresh horizon), while fresh leases cost nothing.
func TestIdentitySweepCoversAllWorkspacesWithinLease(t *testing.T) {
	h := leaseTestHub()
	ids := make([]uuid.UUID, 40)
	for i := range ids {
		ids[i] = uuid.New()
	}
	s := leasedSession(h, ids[0])
	for _, ws := range ids[1:] {
		h.joinWorkspace(s, ws)
		_, _ = s.refreshWorkspaceLease(context.Background(), ws)
	}
	h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return append([]uuid.UUID{}, ids...), nil }
	seen, total, mu := countingChecks(h)
	h.EnforceIdentity(context.Background())
	if n := total(); n != 0 {
		t.Fatalf("fresh leases re-evaluated: %d checks", n)
	}
	// All leases now inside the refresh horizon (e.g. they were granted together).
	s.leases.mu.Lock()
	for _, ws := range ids {
		l := s.leases.workspaces[ws]
		l.until = time.Now().Add(identityRefreshAhead - 3*time.Second)
		s.leases.workspaces[ws] = l
	}
	s.leases.mu.Unlock()
	budget := (2*len(ids)*int(identityPass) + int(identityRefreshAhead) - 1) / int(identityRefreshAhead)
	h.EnforceIdentity(context.Background())
	if n := total(); n != budget {
		t.Fatalf("first pass: %d checks, want the budget %d", n, budget)
	}
	h.EnforceIdentity(context.Background())
	mu.Lock()
	if len(seen) != len(ids) {
		t.Fatalf("%d of %d leases not re-evaluated within two passes", len(ids)-len(seen), len(ids))
	}
	for ws, n := range seen {
		if n != 1 {
			t.Fatalf("workspace %s checked %d times", ws, n)
		}
	}
	mu.Unlock()
	for _, ws := range ids {
		if !s.workspaceLeaseAllows(ws) {
			t.Fatal("lease lapsed")
		}
	}
	h.EnforceIdentity(context.Background())
	if n := total(); n != len(ids) {
		t.Fatalf("refreshed leases re-evaluated again: %d checks", n-len(ids))
	}
}

// Workspaces the session may not read are probed a bounded number per pass, rotating, so a
// step-up is noticed without a DB query per denied workspace per pass.
func TestIdentitySweepDeniedWorkspaceProbesRotate(t *testing.T) {
	h := leaseTestHub()
	a := uuid.New()
	leasedSession(h, a)
	denied := map[uuid.UUID]bool{}
	ids := []uuid.UUID{a}
	for i := 0; i < 10; i++ {
		ws := uuid.New()
		denied[ws] = true
		ids = append(ids, ws)
	}
	original := h.checkWorkspace
	h.checkWorkspace = func(ctx context.Context, id auth.Identity, ws uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		if denied[ws] {
			return identitypolicy.Decision{Reason: identitypolicy.SSORequired}, time.Now(), identitypolicy.ErrDenied
		}
		return original(ctx, id, ws)
	}
	h.identityWorkspaces = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return append([]uuid.UUID{}, ids...), nil }
	seen, total, mu := countingChecks(h)
	for pass := 1; pass <= 3; pass++ {
		h.EnforceIdentity(context.Background())
		if n := total(); n != pass*identityProbes {
			t.Fatalf("pass %d: %d checks", pass, n)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if seen[a] != 0 || len(seen) != len(denied) {
		t.Fatalf("probes did not rotate over all denied workspaces: %d of %d (leased checked %d)", len(seen), len(denied), seen[a])
	}
}

// Events of a workspace left out of READY (its lease was pending), queued while READY was
// built, are dropped instead of closing the session; its WORKSPACE_CREATE ends the omission.
func TestIdentityOmittedWorkspaceEventsDropped(t *testing.T) {
	h := leaseTestHub()
	a, omitted := uuid.New(), uuid.New()
	s := leasedSession(h, a)
	_, _ = s.refreshWorkspaceLease(context.Background(), omitted)
	s.mu.Lock()
	s.ready = false
	s.mu.Unlock()
	s.dispatchEnc(uuid.New(), leaseEvent(omitted)) // allowed now, queued
	s.dispatchEnc(uuid.New(), leaseEvent(a))
	s.omitWorkspace(omitted)
	s.leases.mu.Lock()
	l := s.leases.workspaces[omitted]
	l.until = time.Time{} // the lease lapsed before emission
	s.leases.workspaces[omitted] = l
	s.leases.mu.Unlock()
	s.mu.Lock()
	s.ready = true
	s.flushPending(nil)
	s.mu.Unlock()
	if s.broken.Load() {
		t.Fatal("omitted workspace event closed the session")
	}
	out := drain(s)
	if len(out) != 1 || out[0].workspace != a {
		t.Fatalf("delivered %d events", len(out))
	}
	// Still omitted: a leased event of it before WORKSPACE_CREATE is dropped too.
	_, _ = s.refreshWorkspaceLease(context.Background(), omitted)
	s.dispatchEnc(uuid.New(), leaseEvent(omitted))
	if len(drain(s)) != 0 {
		t.Fatal("event delivered before the workspace snapshot")
	}
	snap := &v1.WorkspaceSnapshot{Workspace: &v1.Workspace{Id: omitted.String()}}
	s.dispatchScoped(omitted, uuid.New(), &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceCreate{WorkspaceCreate: &v1.WorkspaceCreate{Snapshot: snap}}})
	s.dispatchEnc(uuid.New(), leaseEvent(omitted))
	if out := drain(s); len(out) != 2 || s.broken.Load() {
		t.Fatalf("after WORKSPACE_CREATE: %d events, broken %v", len(out), s.broken.Load())
	}
}

// Access versions are per (workspace, user): removing member A (A's version 1 → 2)
// must not tombstone member B's lease at version 2, which B's own durable version (1)
// could never satisfy again — B's READY/events were closed with "identity resync
// required" and the sweep sent B a spurious WORKSPACE_DELETE (CI TestJoinRevalidation).
func TestIdentityLeaseAccessNoticeScopedToItsUser(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	removed, other := leasedSession(h, ws), leasedSession(h, ws)
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"user":%q,"policy_version":1,"access_version":2}`, ws.String(), removed.user.String()))
	if removed.allowsEvent(leaseEvent(ws)) {
		t.Fatal("the target user's lease survived its access invalidation")
	}
	if !other.allowsEvent(leaseEvent(ws)) {
		t.Fatal("another member's lease was revoked by a notice about a different user")
	}
	_, _ = removed.refreshWorkspaceLease(context.Background(), ws)
	if removed.allowsEvent(leaseEvent(ws)) {
		t.Fatal("a lower durable access version resurrected the removed user's lease")
	}
	// A workspace-wide notice (no user) advances policy for everyone, never per-user access.
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"user":"","policy_version":1,"access_version":5}`, ws.String()))
	if !other.allowsEvent(leaseEvent(ws)) {
		t.Fatal("a workspace-wide notice compared per-user access versions")
	}
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"user":"","policy_version":2}`, ws.String()))
	if other.allowsEvent(leaseEvent(ws)) {
		t.Fatal("a workspace-wide policy notice kept a positive lease")
	}
	// Legacy payloads without the user field stay fail-closed for every session.
	h.identityNotification(fmt.Sprintf(`{"workspace":%q,"policy_version":2,"access_version":3}`, ws.String()))
	_, _ = other.refreshWorkspaceLease(context.Background(), ws)
	if other.allowsEvent(leaseEvent(ws)) {
		t.Fatal("legacy unattributed access notice did not fail closed")
	}
}

// A positive decision that raced an invalidation (revision bump) is re-evaluated after it,
// so a fresh, still-authorized connection gets its lease instead of a READY close.
func TestIdentityLeaseRefreshRetriesAfterConcurrentInvalidation(t *testing.T) {
	h := leaseTestHub()
	ws := uuid.New()
	s := leasedSession(h, ws)
	original := h.checkWorkspace
	calls := 0
	h.checkWorkspace = func(ctx context.Context, id auth.Identity, w uuid.UUID) (identitypolicy.Decision, time.Time, error) {
		calls++
		if calls == 1 {
			// The policy advances while this evaluation (begun before it) is in flight.
			h.identityNotification(fmt.Sprintf(`{"workspace":%q,"user":"","policy_version":2}`, ws.String()))
		}
		d, now, err := original(ctx, id, w)
		d.Versions.Policy = 2
		return d, now, err
	}
	d, err := s.refreshWorkspaceLease(context.Background(), ws)
	if err != nil || !d.Allowed || !s.allowsEvent(leaseEvent(ws)) {
		t.Fatalf("authorized refresh lost to a concurrent revision bump (calls %d)", calls)
	}
}

// User-channel (unattributed) profile/presence events are only about the recipient; another
// person's would bypass the lease of the workspace they share (ADR-0054).
func TestIdentityUserChannelPresenceOnlyAboutSelf(t *testing.T) {
	h := leaseTestHub()
	s := leasedSession(h, uuid.New())
	other := uuid.NewString()
	for _, c := range []struct {
		ev   *v1.DispatchEvent
		want bool
	}{
		{&v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{PresenceUpdate: &v1.PresenceUpdate{Presence: &v1.Presence{UserId: s.user.String()}}}}, true},
		{&v1.DispatchEvent{Event: &v1.DispatchEvent_PresenceUpdate{PresenceUpdate: &v1.PresenceUpdate{Presence: &v1.Presence{UserId: other}}}}, false},
		{&v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{Me: &v1.Me{}}}}, true},
		{&v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{UserUpdate: &v1.UserUpdate{User: &v1.User{Id: other}}}}, false},
		// A reminder of the user's own imported event (ADR-0045 amendment 3); an empty one is denied.
		{&v1.DispatchEvent{Event: &v1.DispatchEvent_EventReminder{EventReminder: &v1.CalendarEventReminder{ExternalEvent: &v1.ExternalEvent{Uid: "u"}, Minutes: 5}}}, true},
		{&v1.DispatchEvent{Event: &v1.DispatchEvent_EventReminder{EventReminder: &v1.CalendarEventReminder{Minutes: 5}}}, false},
	} {
		enc := newEnc(c.ev)
		h.prepareEvent(context.Background(), enc)
		if got := s.allowsEvent(enc); got != c.want {
			t.Errorf("%v: allowed %v, want %v", c.ev, got, c.want)
		}
	}
}
