package auth

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
)

// Revocation of a person's session reaches its access tokens in two ways (docs/04 «Auth»):
//
//   - the Valkey marker auth:revoked:<sid> (afterRevoke) — instant, checked on every request;
//   - sessions.revoked_at in Postgres — the source of truth, checked at most once per
//     sessionRecheck per session and instance.
//
// The second bounds what a lost marker costs. A marker is lost when Valkey refuses the SET
// at the moment of the revocation (outage, budget exhausted); before, the tokens then lived
// until they expired — up to ACCESS_TOKEN_TTL, which is 24 h since 2026-09-29. Now they die
// within sessionRecheck. It also keeps REST working while Valkey reads fail: the DB answers
// instead. A session the DB cannot confirm (Postgres error, cache entry expired) fails
// closed (503).
const sessionRecheck = 30 * time.Second

// liveSessions remembers sessions the DB confirmed as not revoked, until the recheck time.
// Session ids are globally unique, so one cache serves every Service of the process.
var liveSessions = &liveCache{until: map[uuid.UUID]time.Time{}, principals: map[uuid.UUID]identitypolicy.Principal{}}

// liveCacheMax bounds the cache; past it, expired entries are pruned on insert.
const liveCacheMax = 50_000

type liveCache struct {
	mu         sync.Mutex
	until      map[uuid.UUID]time.Time
	principals map[uuid.UUID]identitypolicy.Principal
}

func (c *liveCache) fresh(sid uuid.UUID, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	u, ok := c.until[sid]
	return ok && now.Before(u)
}

func (c *liveCache) put(sess sqlc.Session, now time.Time) {
	sid := sess.ID
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.until) >= liveCacheMax {
		for k, u := range c.until {
			if !now.Before(u) {
				delete(c.until, k)
				delete(c.principals, k)
			}
		}
		if len(c.until) >= liveCacheMax {
			clear(c.until)
			clear(c.principals)
		}
	}
	until := now.Add(sessionRecheck)
	if sess.ExpiresAt.Before(until) {
		until = sess.ExpiresAt
	}
	c.until[sid] = until
	if c.principals == nil {
		c.principals = map[uuid.UUID]identitypolicy.Principal{}
	}
	c.principals[sid] = SessionPrincipal(sess)
}

func (c *liveCache) drop(sid uuid.UUID) {
	c.mu.Lock()
	delete(c.until, sid)
	delete(c.principals, sid)
	c.mu.Unlock()
}

// CheckSession is checkSession for callers outside the package: the gateway rechecks a
// live socket's session on every heartbeat (hub), so a revocation whose marker and socket
// event were both lost still closes the socket within sessionRecheck + a heartbeat.
func (s *Service) CheckSession(ctx context.Context, sid uuid.UUID) error {
	return s.checkSession(ctx, sid)
}

// ForgetSessionChecks drops every cached DB confirmation, as if sessionRecheck had passed
// for all sessions (integration tests of the lost-marker path).
func ForgetSessionChecks() {
	liveSessions.mu.Lock()
	clear(liveSessions.until)
	clear(liveSessions.principals)
	liveSessions.mu.Unlock()
}

// checkSession rejects an access token whose session was revoked: a RevokedError
// (errors.Is ErrSessionRevoked) with the reason, or a dependency error when it cannot be
// told (fail closed). A revoked session passes for at most sessionRecheck after its
// revocation when the marker is missing (lost SET, Valkey unreadable) — never longer: the
// cache entry is stamped with the time taken before the DB read that confirmed it, and a
// DB error is not a confirmation.
func (s *Service) checkSession(ctx context.Context, sid uuid.UUID) error {
	reason, revoked, rerr := s.revokedReason(ctx, sid)
	if rerr == nil && revoked {
		return &RevokedError{Reason: reason}
	}
	now := s.now()
	if liveSessions.fresh(sid, now) {
		// Valkey unreadable included: a revocation it could not mark is bounded by the
		// cache entry (≤ sessionRecheck), and the DB is not hit on every request.
		return nil
	}
	sess, err := s.db.Q.GetSession(ctx, sid)
	switch {
	case db.IsNotFound(err):
		return ErrSessionRevoked // deleted with its user
	case err != nil:
		// Neither a confirmation nor a refusal: fail closed (503), both for a Postgres blip
		// alone (the marker may have been lost) and with Valkey down too.
		if rerr != nil {
			slog.WarnContext(ctx, "revocation marker unreadable", "session_id", sid, "err", rerr)
		}
		return err
	case sess.RevokedAt != nil:
		liveSessions.drop(sid)
		return &RevokedError{Reason: deref(sess.RevokedReason)}
	}
	if !identitypolicy.CheckSession(now, SessionPrincipal(sess)).Allowed {
		return ErrSessionRevoked
	}
	if rerr != nil {
		slog.WarnContext(ctx, "revocation marker unreadable, checked the session in the DB", "session_id", sid, "err", rerr)
	}
	liveSessions.put(sess, now)
	if now.Sub(sess.LastSeenAt) > touchEvery {
		// «Настройки → Сеансы» shows the last activity; refreshes alone are a day apart now.
		// The same activity keeps the user's guest memberships alive (ADR-0098).
		if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
			if err := guarded.TouchSession(ctx, sid); err != nil {
				return err
			}
			return guarded.TouchGuestMemberships(ctx, sess.UserID)
		}); err != nil {
			slog.WarnContext(ctx, "session touch failed", "session_id", sid, "err", err)
		}
	}
	return nil
}

// touchEvery is how stale sessions.last_seen_at may get before a request bumps it (the
// query repeats the bound, so racing instances write once).
const touchEvery = 5 * time.Minute

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
