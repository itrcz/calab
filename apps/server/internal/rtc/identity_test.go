package rtc

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
)

type identitySFU struct {
	LiveKit
	rooms   []Room
	people  map[string][]Participant
	mu      sync.Mutex
	removed map[string]int
}

func (f *identitySFU) ListRooms(context.Context) ([]Room, error) { return f.rooms, nil }
func (f *identitySFU) ListParticipants(_ context.Context, room string) ([]Participant, error) {
	return f.people[room], nil
}
func (f *identitySFU) RemoveParticipant(ctx context.Context, room, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed[room+id]++
	return nil
}

// Incident 2026-10-05: a slow DB made every check time out and the sweep evicted everyone.
// A timeout says nothing about access: nobody is evicted, concurrency stays bounded and the
// sweep ends within its budget (the cursor resumes next time).
func TestIdentitySweepSlowDependencyMultipleRooms(t *testing.T) {
	slow, allowed := uuid.New(), uuid.New()
	f := &identitySFU{people: map[string][]Participant{}, removed: map[string]int{}}
	for i := 0; i < 8; i++ {
		ws := slow
		if i == 7 {
			ws = allowed
		}
		room := voice.RoomName(ws, uuid.New())
		f.rooms = append(f.rooms, Room{Name: room})
		for j := 0; j < 20; j++ {
			f.people[room] = append(f.people[room], Participant{Identity: voice.Identity(uuid.New(), uuid.New())})
		}
	}
	var inFlight, maxInFlight atomic.Int32
	svc := &Service{lk: f, IdentityAccess: func(ctx context.Context, ws, _, _, _ uuid.UUID) error {
		if ws == allowed {
			return nil
		}
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for old := maxInFlight.Load(); n > old; old = maxInFlight.Load() {
			if maxInFlight.CompareAndSwap(old, n) {
				break
			}
		}
		<-ctx.Done()
		return ctx.Err()
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	start := time.Now()
	if err := svc.EnforceIdentity(ctx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if time.Since(start) > 4*time.Second {
		t.Fatal("sweep outlived its budget")
	}
	if maxInFlight.Load() > identityParticipantWorkers {
		t.Fatalf("unbounded concurrency: %d", maxInFlight.Load())
	}
	if len(f.removed) != 0 {
		t.Fatalf("a slow dependency evicted %d participants", len(f.removed))
	}
}

// Only a definitive denial evicts; a dependency failure keeps the participant.
func TestIdentitySweepEvictsOnlyOnDenial(t *testing.T) {
	cases := map[string]struct {
		err  error
		want int
	}{
		"forbidden":       {httpx.Forbidden("revoked"), 1},
		"unauthenticated": {httpx.Unauthenticated("session revoked"), 1},
		"not found":       {httpx.NotFound("workspace"), 1},
		"plan limit":      {httpx.Conflict("entitlement").WithDetails(httpx.ReasonPlanLimit, 0, 0), 1},
		"unavailable":     {httpx.Unavailable(errors.New("pool timeout")), 0},
		"deadline":        {context.DeadlineExceeded, 0},
		"plain error":     {errors.New("dial tcp: connection refused"), 0},
		"conflict":        {httpx.Conflict("busy"), 0},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			room := voice.RoomName(uuid.New(), uuid.New())
			f := &identitySFU{rooms: []Room{{Name: room}}, people: map[string][]Participant{room: {{Identity: voice.Identity(uuid.New(), uuid.New())}}}, removed: map[string]int{}}
			svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error { return c.err }}
			if err := svc.EnforceIdentity(context.Background()); err != nil {
				t.Fatal(err)
			}
			if got := len(f.removed); got != c.want {
				t.Fatalf("removed=%d want=%d", got, c.want)
			}
		})
	}
}

func TestIdentitySweepCancellationDoesNotDetachRemoval(t *testing.T) {
	f := &identitySFU{rooms: []Room{{Name: voice.RoomName(uuid.New(), uuid.New())}}, people: map[string][]Participant{}, removed: map[string]int{}}
	f.people[f.rooms[0].Name] = []Participant{{Identity: voice.Identity(uuid.New(), uuid.New())}}
	ctx, cancel := context.WithCancel(context.Background())
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		cancel()
		return httpx.Forbidden("denied")
	}}
	if err := svc.EnforceIdentity(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("want cancellation, got %v", err)
	}
	if len(f.removed) != 0 {
		t.Fatal("removal detached from canceled sweep")
	}
}

// Retain the reviewer topology and both production-budget sweeps from rtc-review.go.
type reviewerSlowEnumeration struct {
	*identitySFU
	healthy      string
	firstRemoval time.Time
}

func (f *reviewerSlowEnumeration) ListParticipants(ctx context.Context, room string) ([]Participant, error) {
	if room == f.healthy {
		return f.people[room], nil
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func (f *reviewerSlowEnumeration) RemoveParticipant(ctx context.Context, room, id string) error {
	if err := f.identitySFU.RemoveParticipant(ctx, room, id); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.firstRemoval.IsZero() {
		f.firstRemoval = time.Now()
	}
	return nil
}

func TestReviewerSlowRoomEnumerationCannotDeferHealthyEviction(t *testing.T) {
	healthy := voice.RoomName(uuid.MustParse("ffffffff-ffff-ffff-ffff-ffffffffffff"), uuid.New())
	person := voice.Identity(uuid.New(), uuid.New())
	base := &identitySFU{rooms: []Room{{Name: healthy}}, people: map[string][]Participant{healthy: {{Identity: person}}}, removed: map[string]int{}}
	for range 168 {
		base.rooms = append(base.rooms, Room{Name: voice.RoomName(uuid.New(), uuid.New())})
	}
	f := &reviewerSlowEnumeration{identitySFU: base, healthy: healthy}
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		return httpx.Forbidden("revoked")
	}}
	started := time.Now()
	for range 2 {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		err := svc.EnforceIdentity(ctx)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("enumeration errors hidden: %v", err)
		}
		t.Logf("sweep elapsed=%v err=%v removed=%d", time.Since(started), err, base.removed[healthy+person])
	}
	if base.removed[healthy+person] == 0 {
		t.Fatal("healthy known revoked participant still connected after two production-budget sweeps")
	}
	if delay := f.firstRemoval.Sub(started); delay > 25*time.Second {
		t.Fatalf("eviction=%v leaves no room for five-second sweep tick within 30-second lease", delay)
	}
	t.Logf("first authoritative eviction=%v (plus at most 5s sweep tick)", f.firstRemoval.Sub(started))
}

type enumerationIdentitySFU struct {
	*identitySFU
	list   func(context.Context, string) ([]Participant, error)
	remove func(context.Context, string, string) error
}

func (f *enumerationIdentitySFU) ListParticipants(ctx context.Context, room string) ([]Participant, error) {
	return f.list(ctx, room)
}
func (f *enumerationIdentitySFU) RemoveParticipant(ctx context.Context, room, id string) error {
	if f.remove != nil {
		return f.remove(ctx, room, id)
	}
	return f.identitySFU.RemoveParticipant(ctx, room, id)
}

func identityNumberedRoom(n byte) string {
	ws := uuid.UUID{}
	ws[15] = n
	return voice.RoomName(ws, uuid.MustParse("ffffffff-ffff-ffff-ffff-ffffffffffff"))
}

func TestIdentitySweepEvictsBeforeEnumerationBarrier(t *testing.T) {
	healthy := identityNumberedRoom(0)
	person := voice.Identity(uuid.New(), uuid.New())
	base := &identitySFU{rooms: []Room{{Name: healthy}}, people: map[string][]Participant{healthy: {{Identity: person}}}, removed: map[string]int{}}
	for i := byte(1); i <= 7; i++ {
		base.rooms = append(base.rooms, Room{Name: identityNumberedRoom(i)})
	}
	blocked := make(chan struct{})
	var slow, finished atomic.Int32
	f := &enumerationIdentitySFU{identitySFU: base, list: func(ctx context.Context, room string) ([]Participant, error) {
		if room == healthy {
			select {
			case <-blocked:
				return base.people[room], nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if slow.Add(1) == 7 {
			close(blocked)
		}
		<-ctx.Done()
		finished.Add(1)
		return nil, ctx.Err()
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.remove = func(ctx context.Context, room, id string) error {
		if got := finished.Load(); got != 0 {
			t.Errorf("eviction waited for %d unrelated enumerations", got)
		}
		err := base.RemoveParticipant(ctx, room, id)
		cancel()
		return err
	}
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		return httpx.Forbidden("revoked")
	}}
	if err := svc.EnforceIdentity(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation hidden: %v", err)
	}
	if base.removed[healthy+person] != 1 || finished.Load() != 7 {
		t.Fatalf("eviction=%d joined enumerators=%d", base.removed[healthy+person], finished.Load())
	}
}

func TestIdentitySweepResumesAfterSlowPrefixAcrossSweeps(t *testing.T) {
	healthy := identityNumberedRoom(9)
	person := voice.Identity(uuid.New(), uuid.New())
	base := &identitySFU{people: map[string][]Participant{healthy: {{Identity: person}}}, removed: map[string]int{}}
	for i := byte(0); i <= 9; i++ {
		base.rooms = append(base.rooms, Room{Name: identityNumberedRoom(i)})
	}
	ctx, cancel := context.WithCancel(context.Background())
	var enumerated atomic.Int32
	f := &enumerationIdentitySFU{identitySFU: base, list: func(ctx context.Context, room string) ([]Participant, error) {
		if room == healthy {
			return base.people[room], nil
		}
		if enumerated.Add(1) == 8 {
			cancel()
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		return httpx.Forbidden("revoked")
	}}
	if err := svc.EnforceIdentity(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("first budget cancellation=%v", err)
	}
	cancel()
	if base.removed[healthy+person] != 0 {
		t.Fatal("healthy room was not beyond the first sweep budget")
	}
	// Reordering and deleting the cursor room cannot reset progress to the prefix.
	base.rooms = append([]Room{{Name: healthy}}, base.rooms[:7]...)
	base.rooms = append(base.rooms, Room{Name: identityNumberedRoom(8)})
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	healthySeen := make(chan struct{})
	var secondSlow atomic.Int32
	f.list = func(ctx context.Context, room string) ([]Participant, error) {
		if room == healthy {
			close(healthySeen)
			return base.people[room], nil
		}
		if secondSlow.Add(1) == 8 {
			select {
			case <-healthySeen:
			default:
				cancel() // Restarting at zero exhausts all workers before reaching the healthy room.
			}
		}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	f.remove = func(ctx context.Context, room, id string) error {
		err := base.RemoveParticipant(ctx, room, id)
		cancel()
		return err
	}
	if err := svc.EnforceIdentity(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("second sweep cancellation=%v", err)
	}
	if base.removed[healthy+person] != 1 {
		t.Fatal("later healthy room starved again after budget reset")
	}
}

func TestIdentitySweepPreservesAllowedWorkspaceAndDM(t *testing.T) {
	denied, allowed, dm := uuid.New(), uuid.New(), uuid.New()
	base := &identitySFU{rooms: []Room{{Name: voice.RoomName(denied, uuid.New())}, {Name: voice.RoomName(allowed, uuid.New())}, {Name: voice.RoomName(dm, dm)}}, people: map[string][]Participant{}, removed: map[string]int{}}
	for _, room := range base.rooms {
		base.people[room.Name] = []Participant{{Identity: voice.Identity(uuid.New(), uuid.New())}}
	}
	var checked atomic.Int32
	svc := &Service{lk: base, IdentityAccess: func(_ context.Context, ws, room, _, _ uuid.UUID) error {
		checked.Add(1)
		if ws == allowed || (ws == dm && room == dm) {
			return nil
		}
		return httpx.Forbidden("DB access denied")
	}}
	if err := svc.EnforceIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if checked.Load() != 3 || len(base.removed) != 1 {
		t.Fatalf("checked=%d removed=%v", checked.Load(), base.removed)
	}
	deniedRoom := base.rooms[0].Name
	if base.removed[deniedRoom+base.people[deniedRoom][0].Identity] != 1 {
		t.Fatal("denied workspace participant survived")
	}
}

func TestIdentitySweepBackpressureAndCancellationBoundWork(t *testing.T) {
	base := &identitySFU{people: map[string][]Participant{}, removed: map[string]int{}}
	for i := byte(0); i < 100; i++ {
		room := identityNumberedRoom(i)
		base.rooms = append(base.rooms, Room{Name: room})
		for range 1000 {
			base.people[room] = append(base.people[room], Participant{Identity: voice.Identity(uuid.New(), uuid.New())})
		}
	}
	var enumerated, checking, peak atomic.Int32
	fullRooms, fullGates := make(chan struct{}), make(chan struct{})
	f := &enumerationIdentitySFU{identitySFU: base, list: func(_ context.Context, room string) ([]Participant, error) {
		n := enumerated.Add(1)
		if n == 2*identityRoomWorkers {
			close(fullRooms)
		}
		if n > 2*identityRoomWorkers {
			t.Errorf("retained more than %d room responses: %d", 2*identityRoomWorkers, n)
		}
		return base.people[room], nil
	}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		n := checking.Add(1)
		defer checking.Add(-1)
		for old := peak.Load(); n > old; old = peak.Load() {
			if peak.CompareAndSwap(old, n) {
				break
			}
		}
		if n == identityParticipantWorkers {
			close(fullGates)
		}
		// Keep the bounded pool occupied until the sweep is cancelled.
		<-ctx.Done()
		return ctx.Err()
	}}
	done := make(chan error, 1)
	go func() { done <- svc.EnforceIdentity(ctx) }()
	guard, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	for _, signal := range []<-chan struct{}{fullRooms, fullGates} {
		select {
		case <-signal:
		case <-guard.Done():
			cancel()
			<-done
			t.Fatal("bounded pipeline did not fill")
		}
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation=%v", err)
	}
	if checking.Load() != 0 || peak.Load() != identityParticipantWorkers || len(base.removed) != 0 {
		t.Fatalf("active=%d peak=%d removals=%d", checking.Load(), peak.Load(), len(base.removed))
	}
}

func TestIdentitySweepReturnsRemovalErrorAndRetries(t *testing.T) {
	room := identityNumberedRoom(0)
	person := voice.Identity(uuid.New(), uuid.New())
	base := &identitySFU{rooms: []Room{{Name: room}}, people: map[string][]Participant{room: {{Identity: person}}}, removed: map[string]int{}}
	failure := errors.New("SFU removal failed")
	f := &enumerationIdentitySFU{identitySFU: base, list: base.ListParticipants,
		remove: func(context.Context, string, string) error { return failure }}
	// A missing DB gate denies, just as an unavailable DB does.
	svc := &Service{lk: f}
	if err := svc.EnforceIdentity(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("removal error hidden: %v", err)
	}
	f.remove = nil
	if err := svc.EnforceIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	if base.removed[room+person] != 1 {
		t.Fatal("failed authoritative removal was not retried")
	}
}

type blockingIdentityRoomsSFU struct {
	LiveKit
	entered chan struct{}
	calls   atomic.Int32
}

func (f *blockingIdentityRoomsSFU) ListRooms(ctx context.Context) ([]Room, error) {
	if f.calls.Add(1) == 1 {
		close(f.entered)
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestIdentitySweepConcurrentCallerCancellationDoesNotStartAnotherPool(t *testing.T) {
	f := &blockingIdentityRoomsSFU{entered: make(chan struct{})}
	svc := &Service{lk: f}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- svc.EnforceIdentity(ctx) }()
	<-f.entered
	waiting, stop := context.WithCancel(context.Background())
	stop()
	if err := svc.EnforceIdentity(waiting); !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting cancellation=%v", err)
	}
	if f.calls.Load() != 1 {
		t.Fatalf("concurrent sweeps performed %d room listings", f.calls.Load())
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("active cancellation=%v", err)
	}
}

func TestIdentitySweepJoinsCancelledRemoval(t *testing.T) {
	room := identityNumberedRoom(0)
	base := &identitySFU{rooms: []Room{{Name: room}}, people: map[string][]Participant{room: {{Identity: voice.Identity(uuid.New(), uuid.New())}}}, removed: map[string]int{}}
	started := make(chan struct{})
	var active atomic.Bool
	f := &enumerationIdentitySFU{identitySFU: base, list: base.ListParticipants,
		remove: func(ctx context.Context, _, _ string) error {
			active.Store(true)
			defer active.Store(false)
			close(started)
			<-ctx.Done()
			return ctx.Err()
		}}
	svc := &Service{lk: f}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- svc.EnforceIdentity(ctx) }()
	<-started
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("removal cancellation=%v", err)
	}
	if active.Load() {
		t.Fatal("removal outlived its sweep")
	}
}
