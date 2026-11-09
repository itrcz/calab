//go:build integration

package rtc

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/voice"
)

// ADR-0166: a participant in LiveKit without Redis voice state is re-added only after a fresh
// identity check. An undecided check (a database stall) neither re-adds nor evicts it — the
// next pass retries; a decision of the gate still removes it at once.
func TestReconcileUndecidedIdentityKeepsParticipant(t *testing.T) {
	wid, rid := uuid.New(), uuid.New()
	uid, sid := uuid.New(), uuid.New()
	identity := voice.Identity(uid, sid)
	room := voice.RoomName(wid, rid)
	lk := &fakeLK{rooms: map[string][]Participant{room: {{Identity: identity}}}}
	s, rc := testService(t, lk)
	s.IdentityAccess = func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		return httpx.Unavailable(context.DeadlineExceeded)
	}
	if err := s.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if lk.wasRemoved(room, identity) {
		t.Fatal("an undecided identity check removed the participant")
	}
	if got := roomOf(t, s, wid, sid); got != uuid.Nil {
		t.Fatalf("an undecided identity check re-added the voice state (room %v)", got)
	}

	// The next pass decides: denied → removed.
	if err := rc.Do(context.Background(), rc.B().Del().Key(redisx.Key("rtc:reconcile")).Build()).Error(); err != nil {
		t.Fatal(err)
	}
	s.IdentityAccess = func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		return errors.Join(httpx.Forbidden("denied"), identitypolicy.ErrDenied)
	}
	if err := s.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !lk.wasRemoved(room, identity) {
		t.Fatal("a denial did not remove the participant")
	}
}
