package gateway

import (
	"context"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
)

// A lease is owned by one exact Session, never shared by user ID. until retains
// time.Now's monotonic component; the absolute DB deadline can only shorten it.
type identityLease struct {
	session, user, workspace uuid.UUID
	versions                 identitypolicy.Versions
	until                    time.Time
	revision                 uint64
}
type identityLeases struct {
	refresh    sync.Mutex
	revision   uint64
	cursor     uuid.UUID // sweep rotation of probes (dueWorkspaceChecks)
	mu         sync.Mutex
	session    identityLease
	workspaces map[uuid.UUID]identityLease
	receipts   map[uuid.UUID]receiptPolicyState // actual own receipts only; never workspace access
	// billing: until when the session's owner may get BILLING_UPDATE of a workspace whose
	// workspace lease a billing suspension denies (ADR-0080 §12: the owner's recovery scope).
	// It opens nothing else.
	billing map[uuid.UUID]time.Time
}

func (s *Session) lease(d identitypolicy.Decision, ws uuid.UUID, started, evaluated time.Time, revision uint64) identityLease {
	if !d.Allowed || d.ValidUntil.IsZero() || d.Versions.Session != s.principal.Version {
		return identityLease{}
	}
	now := time.Now()
	if now.After(evaluated) {
		evaluated = now
	}
	elapsed := time.Since(started)
	duration := min(identitypolicy.ReadLeaseTTL, d.ValidUntil.Sub(evaluated), s.principal.ExpiresAt.Sub(evaluated)) - elapsed
	if duration <= 0 {
		return identityLease{}
	}
	return identityLease{session: s.asess, user: s.user, workspace: ws, versions: d.Versions, until: now.Add(duration), revision: revision}
}
func (s *Session) validLease(l identityLease, ws uuid.UUID) bool {
	return l.session == s.asess && l.user == s.user && l.workspace == ws && l.versions.Session == s.principal.Version && time.Now().Before(l.until)
}
func (s *Session) sessionLeaseAllows() bool {
	s.leases.mu.Lock()
	ok := s.validLease(s.leases.session, uuid.Nil)
	s.leases.mu.Unlock()
	if !ok {
		s.requestIdentityRefresh()
	}
	return ok
}
func (s *Session) workspaceLeaseAllows(ws uuid.UUID) bool {
	if ws == uuid.Nil || (s.principal.Authority != identitypolicy.LocalAccount && s.principal.WorkspaceID != ws) {
		return false
	}
	s.leases.mu.Lock()
	ok := s.validLease(s.leases.workspaces[ws], ws)
	s.leases.mu.Unlock()
	if !ok {
		s.requestIdentityRefresh()
	}
	return ok
}
func (s *Session) requestIdentityRefresh() {
	select {
	case s.hub.identityWake <- struct{}{}:
	default:
	}
}

// refreshWorkspaceLease evaluates durable access and stores the lease. An evaluation
// that raced an invalidation (revision bump) is discarded and re-run once more after
// it, so a fresh, still-authorized connection is not left with a positive decision but
// no lease (its READY would then be closed by allowsEvent). Bounded: a stream of
// invalidations still fails closed.
func (s *Session) refreshWorkspaceLease(ctx context.Context, ws uuid.UUID) (identitypolicy.Decision, error) {
	s.leases.refresh.Lock()
	defer s.leases.refresh.Unlock()
	var d identitypolicy.Decision
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		var raced bool
		if d, raced, err = s.refreshWorkspaceLeaseOnce(ctx, ws); !raced || err != nil {
			break
		}
	}
	return d, err
}

// refreshWorkspaceLeaseOnce is one evaluation; s.leases.refresh must be held. raced
// reports that an invalidation arrived meanwhile and the result was not stored.
func (s *Session) refreshWorkspaceLeaseOnce(ctx context.Context, ws uuid.UUID) (identitypolicy.Decision, bool, error) {
	started := time.Now()
	s.leases.mu.Lock()
	revision := s.leases.revision
	s.leases.mu.Unlock()
	var d identitypolicy.Decision
	evaluated := started
	var err error
	if s.hub.checkWorkspace != nil {
		d, evaluated, err = s.hub.checkWorkspace(ctx, s.identity(), ws)
	} else {
		d, err = s.hub.auth.CheckWorkspaceDecision(ctx, s.identity(), ws, identitypolicy.WorkspaceRead)
		if err == nil {
			evaluated, err = s.hub.db.Q.IdentityDatabaseNow(ctx)
		}
	}
	l := identityLease{}
	// A late result is stale, but a definitive denial still holds: the deadline must not turn
	// it into a transient failure that keeps the positive lease.
	if ctx.Err() != nil && ((err == nil && d.Allowed) || identityTransient(d, err)) {
		err = ctx.Err()
	}
	if identityTransient(d, err) {
		// Keep the stored lease (it expires on its own): a slow DB is not a revocation.
		return d, false, err
	}
	if err == nil {
		l = s.lease(d, ws, started, evaluated, revision)
	}
	billingUntil := s.billingRecoveryLease(ctx, d, ws, started, revision)
	s.leases.mu.Lock()
	defer s.leases.mu.Unlock()
	if s.leases.revision != revision {
		return d, true, err
	}
	if billingUntil.IsZero() {
		delete(s.leases.billing, ws)
	} else {
		if s.leases.billing == nil {
			s.leases.billing = map[uuid.UUID]time.Time{}
		}
		s.leases.billing[ws] = billingUntil
	}
	if s.leases.workspaces == nil {
		s.leases.workspaces = map[uuid.UUID]identityLease{}
	}
	// A replica/cache decision older than a received durable notice cannot
	// resurrect access, even when refresh began after that notice.
	oldVersion := s.leases.workspaces[ws].versions
	if l.versions.Policy < oldVersion.Policy || l.versions.Access < oldVersion.Access {
		l = identityLease{}
	}
	// Retain bounded version tombstones so duplicate invalidations cannot revoke again.
	if l.session == uuid.Nil {
		old := s.leases.workspaces[ws]
		old.until = time.Time{}
		if old.session != uuid.Nil {
			s.leases.workspaces[ws] = old
		}
	} else {
		// Positive decisions prove durable membership, rather than imposing a
		// fixed product cap that silently drops READY for supported memberships.
		s.leases.workspaces[ws] = l
	}
	return d, false, err
}
func (s *Session) refreshSessionLease(ctx context.Context) {
	s.leases.refresh.Lock()
	defer s.leases.refresh.Unlock()
	started := time.Now()
	s.leases.mu.Lock()
	revision := s.leases.revision
	s.leases.mu.Unlock()
	var p identitypolicy.Principal
	evaluated := started
	var err error
	if s.hub.checkPrincipal != nil {
		p, evaluated, err = s.hub.checkPrincipal(ctx, s.identity())
	} else {
		p, err = s.hub.auth.ResolvePrincipal(ctx, s.identity())
		if err == nil {
			var now time.Time
			now, err = s.hub.db.Q.IdentityDatabaseNow(ctx)
			evaluated = now
			if err == nil && !identitypolicy.CheckSession(now, p).Allowed {
				p.Revoked = true
			}
		}
	}
	if identityTransient(identitypolicy.Decision{}, err) {
		return // keep the session lease; it expires on its own (ReadLeaseTTL)
	}
	l := identityLease{}
	if err == nil && p.Authority == s.principal.Authority && p.WorkspaceID == s.principal.WorkspaceID && p.ConnectionID == s.principal.ConnectionID && p.SessionID == s.asess && p.UserID == s.user {
		l = s.lease(identitypolicy.CheckSession(evaluated, p), uuid.Nil, started, evaluated, revision)
	}
	s.leases.mu.Lock()
	s.leases.session = l
	s.leases.mu.Unlock()
}

// Fixed preparation workers replace per-recipient goroutines. Overflow fails closed
// and makes the session require a fresh IDENTIFY rather than growing pending memory.
func (h *Hub) runPreparations(ctx context.Context) {
	for i := 0; i < 8; i++ {
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case f := <-h.preparations:
					f()
				}
			}
		}()
	}
}
func (h *Hub) prepareAsync(f func()) bool {
	select {
	case h.preparations <- f:
		return true
	default:
		return false
	}
}
func (s *Session) preparationFailed(marker *pauseMark) {
	s.broken.Store(true)
	s.resumeMany(marker, nil)
	s.mu.Lock()
	if s.conn != nil {
		s.conn.closeNow(4000, "resync required")
	}
	s.mu.Unlock()
}

// Called outside gateway locks when an event cannot fit the bounded preparation budget.
func (s *Session) requireIdentityResync() { s.requireResync("identity resync required") }

// requireResync makes the session catch up with a full READY: events were lost for it. It is
// no longer resumable and its socket (if any) closes with 4000. Called without s.mu held.
func (s *Session) requireResync(why string) {
	s.broken.Store(true)
	s.mu.Lock()
	if s.conn != nil {
		s.conn.closeNow(4000, why)
	}
	s.mu.Unlock()
}

// billingRecoveryLease: when a billing suspension denied the workspace lease, the owner's
// billing scope (identitypolicy.BillingRead, every other identity check included) is evaluated
// separately; its lease lets only BILLING_UPDATE through (billingLeaseAllows). Zero: none.
func (s *Session) billingRecoveryLease(ctx context.Context, d identitypolicy.Decision, ws uuid.UUID, started time.Time, revision uint64) time.Time {
	if d.Allowed || d.Reason != identitypolicy.BillingSuspended || s.hub.auth == nil || ctx.Err() != nil {
		return time.Time{}
	}
	bd, err := s.hub.auth.CheckWorkspaceDecision(ctx, s.identity(), ws, identitypolicy.BillingRead)
	if err != nil || !bd.Allowed {
		return time.Time{}
	}
	evaluated, err := s.hub.db.Q.IdentityDatabaseNow(ctx)
	if err != nil {
		return time.Time{}
	}
	return s.lease(bd, ws, started, evaluated, revision).until
}

// billingLeaseAllows: the owner's billing recovery lease of ws is valid (see billingRecoveryLease).
func (s *Session) billingLeaseAllows(ws uuid.UUID) bool {
	if ws == uuid.Nil || (s.principal.Authority != identitypolicy.LocalAccount && s.principal.WorkspaceID != ws) {
		return false
	}
	s.leases.mu.Lock()
	until := s.leases.billing[ws]
	s.leases.mu.Unlock()
	return time.Now().Before(until)
}
