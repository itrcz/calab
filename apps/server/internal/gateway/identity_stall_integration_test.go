//go:build integration

package gateway

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/voice"
)

// ADR-0166: the heartbeat recheck of the auth session closes the socket on a revocation at
// once, and on an undecided check only past the transient grace.
func TestSessionRecheckClosesOnDecisionOrPastGrace(t *testing.T) {
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
	h := New(Config{}, d, rc, nil, nil)
	base := leaseTestHub()
	h.checkPrincipal, h.checkWorkspace = base.checkPrincipal, base.checkWorkspace
	h.voice = voice.Store{C: rc}

	undecided := leasedSession(h, uuid.New())
	h.checkSession = func(context.Context, uuid.UUID) error { return context.DeadlineExceeded }
	if h.sessionRevoked(undecided) {
		t.Fatal("an undecided recheck within the grace closed the socket")
	}
	undecided.authConfirmed.Store(time.Now().Add(-h.identityGrace() - time.Second).UnixNano())
	if !h.sessionRevoked(undecided) || !undecided.dead {
		t.Fatal("an undecided recheck past the grace kept the session")
	}

	revoked := leasedSession(h, uuid.New())
	h.checkSession = func(context.Context, uuid.UUID) error { return auth.ErrSessionRevoked }
	if !h.sessionRevoked(revoked) || !revoked.dead {
		t.Fatal("a revoked session kept its socket")
	}
}
