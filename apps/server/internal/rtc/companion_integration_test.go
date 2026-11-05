//go:build integration

package rtc

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/voice"
)

// The companion connection (ADR-0149 §3) of the lost fixture's device: "<user>:<session>:web".

// sipRecorder counts PersonLeft: the phone line of a room must not hear about a companion.
type sipRecorder struct {
	SIPHook
	mu   sync.Mutex
	left int
}

func (r *sipRecorder) PersonLeft(context.Context, uuid.UUID, uuid.UUID) {
	r.mu.Lock()
	r.left++
	r.mu.Unlock()
}

func (r *sipRecorder) SIPRoomFinished(context.Context, uuid.UUID) {}

// listener: the rights a companion needs.
const listener = perm.ViewRoom | perm.Connect

func (f *lostFixture) companion() string { return voice.CompanionIdentity(f.uid, f.sid) }

// companionEvent delivers a LiveKit event of the fixture device's companion connection sid.
func (f *lostFixture) companionEvent(t *testing.T, event, connSID string, reason DisconnectReason) {
	t.Helper()
	if err := f.s.HandleEvent(context.Background(), &WebhookEvent{
		Event: event, Room: &Room{Name: f.lkRoom},
		Participant: &Participant{Sid: connSID, Identity: f.companion(), DisconnectReason: reason},
	}); err != nil {
		t.Fatal(err)
	}
}

// inLiveKit puts participants into the fixture room's LiveKit listing.
func (f *lostFixture) inLiveKit(ps ...Participant) {
	f.lk.mu.Lock()
	f.lk.rooms[f.lkRoom] = ps
	f.lk.mu.Unlock()
}

func (f *lostFixture) published() int {
	f.pub.mu.Lock()
	defer f.pub.mu.Unlock()
	return len(f.pub.got)
}

func (f *lostFixture) companionRemoved() bool { return f.lk.wasRemoved(f.lkRoom, f.companion()) }

// The token needs this session's seat in the room — pending, connected or held — and writes
// nothing; another room's seat or none at all is 409.
func TestCompanionNeedsSeat(t *testing.T) {
	f := newLostFixture(t)
	ctx := context.Background()
	f.s.cfg.APIKey, f.s.cfg.Secret, f.s.cfg.PublicURL = "key", "secret", "wss://livekit.test"
	before := stateOf(t, f.s, f.wid, f.sid)
	resp, err := f.s.companion(ctx, f.wid, f.rid, f.uid, f.sid, listener, "")
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetIdentity() != f.companion() || resp.GetToken() == "" || resp.GetUrl() != "wss://livekit.test" {
		t.Fatalf("response: %v", resp)
	}
	if after := stateOf(t, f.s, f.wid, f.sid); *after != *before || f.published() != 0 {
		t.Fatalf("the token changed the seat: %+v → %+v, %d published", before, after, f.published())
	}

	// Held after a drop: still a seat.
	f.drop(t, "CONNECTION_TIMEOUT")
	if _, err := f.s.companion(ctx, f.wid, f.rid, f.uid, f.sid, listener, ""); err != nil {
		t.Fatalf("held seat: %v", err)
	}

	conflict := func(name string, err error) {
		t.Helper()
		var he *httpx.Error
		if !errors.As(err, &he) || he.Status != 409 {
			t.Fatalf("%s: %v, want 409", name, err)
		}
	}
	// Another room of the workspace.
	_, err = f.s.companion(ctx, f.wid, uuid.New(), f.uid, f.sid, listener, "")
	conflict("another room", err)
	// No seat: never in voice, or left.
	other := uuid.New()
	_, err = f.s.companion(ctx, f.wid, f.rid, other, other, listener, "")
	conflict("no seat", err)
	leaveReq(t, f.s, f.uid, f.sid, f.rid)
	_, err = f.s.companion(ctx, f.wid, f.rid, f.uid, f.sid, listener, "")
	conflict("after leave", err)
	if st := stateOf(t, f.s, f.wid, f.sid); st != nil {
		t.Fatalf("a refused token recorded a seat: %+v", st)
	}

	// Pending (just joined, not connected yet).
	pend := uuid.New()
	if _, _, err := recordFixturePending(ctx, t, f.s, f.room, pend, pend, admission{}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.companion(ctx, f.wid, f.rid, pend, pend, listener, ""); err != nil {
		t.Fatalf("pending seat: %v", err)
	}
}

// A companion joining and leaving — any reason — leaves the device's voice state, its grace
// (ADR-0150), the published state (others' cues) and the phone line alone.
func TestCompanionJoinLeaveLeavesVoiceUntouched(t *testing.T) {
	f := newLostFixture(t)
	sip := &sipRecorder{}
	f.s.SIP = sip
	f.inLiveKit(Participant{Sid: "PA_1", Identity: f.ident}, Participant{Sid: "PC_1", Identity: f.companion()})
	before := stateOf(t, f.s, f.wid, f.sid)
	f.companionEvent(t, EventParticipantJoined, "PC_1", "")
	for _, reason := range []DisconnectReason{"CONNECTION_TIMEOUT", "CLIENT_INITIATED", "PARTICIPANT_REMOVED", ""} {
		f.companionEvent(t, EventParticipantLeft, "PC_1", reason)
	}
	f.companionEvent(t, EventParticipantAborted, "PC_1", "JOIN_FAILURE")
	if after := stateOf(t, f.s, f.wid, f.sid); after == nil || *after != *before {
		t.Fatalf("companion events changed the seat: %+v → %+v", before, after)
	}
	if f.companionRemoved() || f.lk.wasRemoved(f.lkRoom, f.ident) {
		t.Fatal("a companion with a seat was removed")
	}

	// The device drops: its seat is held; the companion's own join and leave do not end or
	// extend the grace.
	f.drop(t, "CONNECTION_TIMEOUT")
	held := stateOf(t, f.s, f.wid, f.sid)
	if held == nil || !held.Lost {
		t.Fatalf("seat not held: %+v", held)
	}
	n := f.published()
	f.companionEvent(t, EventParticipantJoined, "PC_2", "")
	f.companionEvent(t, EventParticipantLeft, "PC_2", "CLIENT_INITIATED")
	if st := stateOf(t, f.s, f.wid, f.sid); st == nil || *st != *held {
		t.Fatalf("companion events changed a held seat: %+v → %+v", held, st)
	}
	if f.published() != n || f.companionRemoved() {
		t.Fatalf("published %d updates or removed the companion of a held seat", f.published()-n)
	}
	sip.mu.Lock()
	defer sip.mu.Unlock()
	if sip.left != 0 {
		t.Fatalf("the phone line heard %d leaves", sip.left)
	}
	f.noLeave(t)
}

// A newer companion of the same session (DUPLICATE_IDENTITY in LiveKit) supersedes only the
// older companion: the device keeps its connection and seat, nothing is removed or published.
func TestCompanionDuplicateSupersedesOnlyCompanion(t *testing.T) {
	f := newLostFixture(t)
	f.inLiveKit(Participant{Sid: "PA_1", Identity: f.ident}, Participant{Sid: "PC_1", Identity: f.companion()})
	before := stateOf(t, f.s, f.wid, f.sid)
	f.companionEvent(t, EventParticipantJoined, "PC_1", "")
	f.inLiveKit(Participant{Sid: "PA_1", Identity: f.ident}, Participant{Sid: "PC_2", Identity: f.companion()})
	f.companionEvent(t, EventParticipantJoined, "PC_2", "")
	f.companionEvent(t, EventParticipantLeft, "PC_1", "DUPLICATE_IDENTITY")
	if st := stateOf(t, f.s, f.wid, f.sid); st == nil || *st != *before {
		t.Fatalf("seat changed: %+v → %+v", before, st)
	}
	f.lk.mu.Lock()
	removed := len(f.lk.removed)
	f.lk.mu.Unlock()
	if removed != 0 || f.published() != 0 {
		t.Fatalf("removed %d participants, published %d updates", removed, f.published())
	}
}

// A companion without its session's seat in the room is removed: at its join and by reconcile;
// one with a seat (also one recorded after reconcile's snapshot) stays. A publish removes it.
func TestCompanionWithoutSeatRemoved(t *testing.T) {
	f := newLostFixture(t)
	stranger := uuid.New()
	ghost := voice.CompanionIdentity(stranger, stranger)
	if err := f.s.HandleEvent(context.Background(), &WebhookEvent{
		Event: EventParticipantJoined, Room: &Room{Name: f.lkRoom}, Participant: &Participant{Sid: "PC_9", Identity: ghost},
	}); err != nil {
		t.Fatal(err)
	}
	if !f.lk.wasRemoved(f.lkRoom, ghost) {
		t.Fatal("a companion without a seat was admitted")
	}
	if st := stateOf(t, f.s, f.wid, stranger); st != nil {
		t.Fatalf("a companion recorded a seat: %+v", st)
	}

	// Reconcile: the stranger's companion goes, the device's own stays.
	f.lk.mu.Lock()
	f.lk.removed = nil
	f.lk.mu.Unlock()
	f.inLiveKit(Participant{Sid: "PA_1", Identity: f.ident}, Participant{Sid: "PC_1", Identity: f.companion()}, Participant{Sid: "PC_9", Identity: ghost})
	f.reconcile(t)
	if !f.lk.wasRemoved(f.lkRoom, ghost) || f.companionRemoved() || f.lk.wasRemoved(f.lkRoom, f.ident) {
		t.Fatalf("reconcile removed %v", f.lk.removed)
	}
	if st := stateOf(t, f.s, f.wid, stranger); st != nil {
		t.Fatalf("reconcile recorded a companion as a device: %+v", st)
	}

	// A companion that publishes a track is removed (its grant has no source).
	before := stateOf(t, f.s, f.wid, f.sid)
	f.companionEvent(t, EventTrackPublished, "PC_1", "")
	if !f.companionRemoved() {
		t.Fatal("a publishing companion stayed")
	}
	if st := stateOf(t, f.s, f.wid, f.sid); st == nil || *st != *before {
		t.Fatalf("a companion's track touched the seat: %+v", st)
	}
}

// Every path that takes the device out of the room takes its companion out too. (A connected
// device's seat itself goes with its participant_left, not under test here.)
func TestCompanionRemovedWithDevice(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		run  func(t *testing.T, f *lostFixture)
	}{
		{"leave", func(t *testing.T, f *lostFixture) { leaveReq(t, f.s, f.uid, f.sid, f.rid) }},
		{"own disconnect", func(t *testing.T, f *lostFixture) { f.drop(t, "CLIENT_INITIATED") }},
		{"kicked by LiveKit removal", func(t *testing.T, f *lostFixture) { f.drop(t, "PARTICIPANT_REMOVED") }},
		{"revoke or lost access", func(_ *testing.T, f *lostFixture) {
			f.s.disconnect(ctx, f.wid, func(st voice.SessionState) bool { return st.SessionID == f.sid })
		}},
		{"revoke of a held seat", func(t *testing.T, f *lostFixture) {
			f.drop(t, "CONNECTION_TIMEOUT")
			f.s.disconnect(ctx, f.wid, func(st voice.SessionState) bool { return st.SessionID == f.sid })
		}},
		{"other device", func(_ *testing.T, f *lostFixture) { f.s.takeOutDevice(ctx, f.wid, f.rid, f.uid, f.sid) }},
		{"grace expiry", func(t *testing.T, f *lostFixture) {
			f.drop(t, "CONNECTION_TIMEOUT")
			if err := f.s.setFlag(ctx, f.wid, f.rid, f.uid, f.sid, func(n *voice.SessionState) {
				n.Hold = time.Now().Add(-time.Second).UnixMilli()
			}); err != nil {
				t.Fatal(err)
			}
			f.inLiveKit(Participant{Sid: "PC_1", Identity: f.companion()})
			f.reconcile(t)
		}},
		{"identity sweep", func(t *testing.T, f *lostFixture) {
			f.s.IdentityAccess = func(_ context.Context, _, _, _, sid uuid.UUID) error {
				if sid == f.sid {
					return httpx.Forbidden("session revoked")
				}
				return nil
			}
			if err := f.s.EnforceIdentity(ctx); err != nil {
				t.Fatal(err)
			}
		}},
		{"pending never connected", func(t *testing.T, f *lostFixture) {
			if err := f.s.setFlag(ctx, f.wid, f.rid, f.uid, f.sid, func(n *voice.SessionState) { n.Pending = true }); err != nil {
				t.Fatal(err)
			}
			st := stateOf(t, f.s, f.wid, f.sid)
			f.inLiveKit(Participant{Sid: "PC_1", Identity: f.companion()})
			f.s.confirmConnect(f.wid, f.rid, f.uid, f.sid, st.JoinedAt)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newLostFixture(t)
			f.inLiveKit(Participant{Sid: "PA_1", Identity: f.ident}, Participant{Sid: "PC_1", Identity: f.companion()})
			tc.run(t, f)
			if !f.companionRemoved() {
				t.Fatalf("companion stayed; removed %v", f.lk.removed)
			}
		})
	}
}

// A held seat keeps its companion (the WebView may stay while native audio reconnects); a drop
// does not remove it.
func TestCompanionStaysWithHeldSeat(t *testing.T) {
	f := newLostFixture(t)
	f.inLiveKit(Participant{Sid: "PC_1", Identity: f.companion()})
	f.drop(t, "CONNECTION_TIMEOUT")
	f.reconcile(t)
	if f.companionRemoved() {
		t.Fatal("the companion of a held seat was removed")
	}
	if st := stateOf(t, f.s, f.wid, f.sid); st == nil || !st.Lost {
		t.Fatalf("seat: %+v", st)
	}
}

// grantLK records UpdatePermission per identity.
type grantLK struct {
	presenceLK
	grants map[string]Permission
}

func (g *grantLK) UpdatePermission(_ context.Context, _, identity string, p Permission) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.grants[identity] = p
	return nil
}

// A grant push for a companion identity is the companion grant (never a device's sources); a
// failed identity check removes the companion; lost rights remove it.
func TestCompanionGrantPush(t *testing.T) {
	f := newLostFixture(t)
	lk := &grantLK{presenceLK: f.lk, grants: map[string]Permission{}}
	f.s.lk = lk
	all := perm.ViewRoom | perm.Connect | perm.Speak | perm.Stream | perm.Video
	if err := f.s.pushGrant(context.Background(), f.lkRoom, f.companion(), f.wid, f.uid, all, true); err != nil {
		t.Fatal(err)
	}
	if g := lk.grants[f.companion()]; !g.CanSubscribe || !g.CanPublishData || g.CanPublish || len(g.CanPublishSources) != 0 {
		t.Fatalf("companion grant: %+v", g)
	}
	if err := f.s.pushGrant(context.Background(), f.lkRoom, f.companion(), f.wid, uuid.New(), all, true); err == nil {
		t.Fatal("a companion grant for another user was pushed")
	}
	if err := f.s.syncCompanionGrant(context.Background(), f.lkRoom, f.uid, f.sid, 0); err != nil {
		t.Fatal(err)
	}
	if !f.companionRemoved() {
		t.Fatal("a companion without CONNECT stayed")
	}
}

// Seat removals outside the device's own LiveKit leave take the companion at once, not on the
// next reconcile pass: a stale seat reconcile removes, and a device that /joins another room
// (pending in the old one, its connect wait replaced).
func TestCompanionDroppedWithSeatChange(t *testing.T) {
	// Reconcile: the seat is old and absent from LiveKit, only its companion is there.
	f := newLostFixture(t)
	f.inLiveKit(Participant{Sid: "PC_1", Identity: f.companion()})
	f.reconcile(t)
	if st := stateOf(t, f.s, f.wid, f.sid); st != nil {
		t.Fatalf("stale seat kept: %+v", st)
	}
	if !f.companionRemoved() {
		t.Fatalf("reconcile removed the seat but kept its companion: %v", f.lk.removed)
	}

	// Pending in room A, then /join room B before connecting.
	f = newLostFixture(t)
	ctx := context.Background()
	if err := f.s.setFlag(ctx, f.wid, f.rid, f.uid, f.sid, func(n *voice.SessionState) { n.Pending = true }); err != nil {
		t.Fatal(err)
	}
	f.inLiveKit(Participant{Sid: "PC_1", Identity: f.companion()})
	other := wsRoom{Room: sqlc.Room{ID: uuid.New()}, WorkspaceID: f.wid}
	if _, _, err := recordFixturePending(ctx, t, f.s, other, f.uid, f.sid, admission{}); err != nil {
		t.Fatal(err)
	}
	if !f.companionRemoved() {
		t.Fatalf("the companion stayed in the room the device left: %v", f.lk.removed)
	}
	if f.lk.wasRemoved(voice.RoomName(f.wid, other.ID), f.companion()) {
		t.Fatal("the companion was removed from the room the device joined")
	}
	// A repeated /join of the same room removes nothing.
	f.lk.mu.Lock()
	f.lk.removed = nil
	f.lk.mu.Unlock()
	if _, _, err := recordFixturePending(ctx, t, f.s, other, f.uid, f.sid, admission{}); err != nil {
		t.Fatal(err)
	}
	f.lk.mu.Lock()
	n := len(f.lk.removed)
	f.lk.mu.Unlock()
	if n != 0 {
		t.Fatalf("a repeated /join removed %d participants", n)
	}
}
