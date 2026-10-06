package rtc

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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

func TestIdentitySweepSlowDependencyMultipleRooms(t *testing.T) {
	denied, allowed := uuid.New(), uuid.New()
	f := &identitySFU{people: map[string][]Participant{}, removed: map[string]int{}}
	for i := 0; i < 8; i++ {
		ws := denied
		if i == 7 {
			ws = allowed
		}
		room := voice.RoomName(ws, uuid.New())
		f.rooms = append(f.rooms, Room{Name: room})
		for j := 0; j < 2; j++ {
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
	// A slow gate is a transient failure: the first sweep keeps everyone, a sweep after
	// identityTransientGrace of unbroken failures evicts. Both stay within budget.
	now := time.Now()
	svc.identitySweep.now = func() time.Time { return now }
	for sweep := 0; sweep < 2; sweep++ {
		if sweep == 1 {
			if len(f.removed) != 0 {
				t.Fatalf("first slow sweep evicted %d participants", len(f.removed))
			}
			now = now.Add(identityTransientGrace)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		start := time.Now()
		if err := svc.EnforceIdentity(ctx); err != nil {
			cancel()
			t.Fatal(err)
		}
		cancel()
		if time.Since(start) > 4*time.Second {
			t.Fatal("slow dependency starved later rooms")
		}
	}
	if maxInFlight.Load() > identityParticipantWorkers {
		t.Fatalf("unbounded concurrency: %d", maxInFlight.Load())
	}
	for i, room := range f.rooms {
		for _, p := range f.people[room.Name] {
			want := 1
			if i == 7 {
				want = 0
			}
			if got := f.removed[room.Name+p.Identity]; got != want {
				t.Fatalf("room %d removal=%d want=%d", i, got, want)
			}
		}
	}
}

func TestIdentitySweepCancellationDoesNotDetachRemoval(t *testing.T) {
	f := &identitySFU{rooms: []Room{{Name: voice.RoomName(uuid.New(), uuid.New())}}, people: map[string][]Participant{}, removed: map[string]int{}}
	f.people[f.rooms[0].Name] = []Participant{{Identity: voice.Identity(uuid.New(), uuid.New())}}
	ctx, cancel := context.WithCancel(context.Background())
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		cancel()
		return errors.New("denied")
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
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error { return errors.New("revoked") }}
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
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error { return errors.New("revoked") }}
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
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error { return errors.New("revoked") }}
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
		return errors.New("DB access denied")
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

func identityOneParticipant(t *testing.T) (*identitySFU, string) {
	t.Helper()
	room := voice.RoomName(uuid.New(), uuid.New())
	f := &identitySFU{rooms: []Room{{Name: room}}, people: map[string][]Participant{}, removed: map[string]int{}}
	id := voice.Identity(uuid.New(), uuid.New())
	f.people[room] = []Participant{{Identity: id}}
	return f, room + id
}

func identitySweepAt(t *testing.T, svc *Service, at time.Time) {
	t.Helper()
	svc.identitySweep.now = func() time.Time { return at }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := svc.EnforceIdentity(ctx); err != nil {
		t.Fatal(err)
	}
}

// A database stall (503 from the gate) must not drop people from calls; an outage that
// outlasts the grace still evicts.
func TestIdentitySweepTransientFailureWaitsForGrace(t *testing.T) {
	f, key := identityOneParticipant(t)
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		return httpx.Unavailable(errors.New("pool timeout"))
	}}
	t0 := time.Now()
	identitySweepAt(t, svc, t0)
	identitySweepAt(t, svc, t0.Add(identityTransientGrace-time.Second))
	if f.removed[key] != 0 {
		t.Fatal("transient failure evicted before the grace")
	}
	identitySweepAt(t, svc, t0.Add(identityTransientGrace))
	if f.removed[key] != 1 {
		t.Fatalf("unbroken failure past the grace: removal=%d want 1", f.removed[key])
	}
}

func TestIdentitySweepDenialEvictsAtOnce(t *testing.T) {
	for name, deny := range map[string]error{
		"forbidden": httpx.Forbidden("account disabled"),
		"not found": httpx.NotFound("room"),
		"unknown":   errors.New("denied"),
		// the gate wraps these decisions in 503
		"session revoked": httpx.Unavailable(auth.ErrSessionRevoked),
		"user gone":       httpx.Unavailable(pgx.ErrNoRows),
		"policy denial":   httpx.Unavailable(identitypolicy.ErrDenied),
	} {
		t.Run(name, func(t *testing.T) {
			f, key := identityOneParticipant(t)
			svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error { return deny }}
			identitySweepAt(t, svc, time.Now())
			if f.removed[key] != 1 {
				t.Fatalf("denial: removal=%d want 1", f.removed[key])
			}
		})
	}
}

// A successful check ends the run: failures before and after a success do not add up.
func TestIdentitySweepSuccessResetsTransientRun(t *testing.T) {
	f, key := identityOneParticipant(t)
	var fail atomic.Bool
	svc := &Service{lk: f, IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
		if fail.Load() {
			return httpx.Unavailable(errors.New("stall"))
		}
		return nil
	}}
	t0 := time.Now()
	fail.Store(true)
	identitySweepAt(t, svc, t0)
	fail.Store(false)
	identitySweepAt(t, svc, t0.Add(identityTransientGrace/2))
	fail.Store(true)
	identitySweepAt(t, svc, t0.Add(identityTransientGrace))
	if f.removed[key] != 0 {
		t.Fatal("failures separated by a success were summed")
	}
}

func TestIdentityWorkersStayBelowDBPool(t *testing.T) {
	if got := (&Service{}).identityWorkers(); got != identityParticipantWorkers {
		t.Fatalf("no pool: %d workers, want %d", got, identityParticipantWorkers)
	}
	for _, c := range []struct{ conns, want int }{{1, 1}, {2, 1}, {5, 4}, {9, 8}, {20, identityParticipantWorkers}} {
		cfg, err := pgxpool.ParseConfig(fmt.Sprintf("postgres://calaba@127.0.0.1:1/calaba?pool_max_conns=%d", c.conns))
		if err != nil {
			t.Fatal(err)
		}
		pool, err := pgxpool.NewWithConfig(context.Background(), cfg) // lazy: never dials here
		if err != nil {
			t.Fatal(err)
		}
		got := (&Service{db: &db.DB{Pool: pool}}).identityWorkers()
		pool.Close()
		if got != c.want {
			t.Fatalf("pool of %d: %d workers, want %d", c.conns, got, c.want)
		}
	}
}

func TestIdentitySweepRoomBatchChecksEachRoomInOneCall(t *testing.T) {
	ws := uuid.New()
	small, big := voice.RoomName(ws, uuid.New()), voice.RoomName(ws, uuid.New())
	f := &identitySFU{rooms: []Room{{Name: small}, {Name: big}}, people: map[string][]Participant{}, removed: map[string]int{}}
	for range 3 {
		f.people[small] = append(f.people[small], Participant{Identity: voice.Identity(uuid.New(), uuid.New())})
	}
	for range identityRoomBatch + 6 {
		f.people[big] = append(f.people[big], Participant{Identity: voice.Identity(uuid.New(), uuid.New())})
	}
	denied := f.people[small][1].Identity
	var mu sync.Mutex
	calls := map[uuid.UUID][]int{}
	svc := &Service{lk: f,
		IdentityAccess: func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) error {
			t.Error("per-device gate called while the room gate is set")
			return nil
		},
		IdentityAccessRoom: func(_ context.Context, _, room uuid.UUID, people []IdentityKey) []error {
			mu.Lock()
			calls[room] = append(calls[room], len(people))
			mu.Unlock()
			out := make([]error, len(people))
			for i, p := range people {
				if voice.Identity(p.User, p.Session) == denied {
					out[i] = httpx.Forbidden("revoked")
				}
			}
			return out
		}}
	if err := svc.EnforceIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	_, smallID, _ := voice.ParseRoomName(small)
	_, bigID, _ := voice.ParseRoomName(big)
	if got := calls[smallID]; len(got) != 1 || got[0] != 3 {
		t.Fatalf("small room batches=%v, want [3]", got)
	}
	if got := calls[bigID]; len(got) != 2 || got[0]+got[1] != identityRoomBatch+6 || max(got[0], got[1]) != identityRoomBatch {
		t.Fatalf("big room batches=%v, want one full batch of %d and the rest", got, identityRoomBatch)
	}
	if len(f.removed) != 1 || f.removed[small+denied] != 1 {
		t.Fatalf("removed=%v, want only the denied device", f.removed)
	}
}

func TestIdentitySweepRoomBatchTransientWaitsForGrace(t *testing.T) {
	room := identityNumberedRoom(1)
	f := &identitySFU{rooms: []Room{{Name: room}}, people: map[string][]Participant{}, removed: map[string]int{}}
	for range 4 {
		f.people[room] = append(f.people[room], Participant{Identity: voice.Identity(uuid.New(), uuid.New())})
	}
	verdicts := 4
	svc := &Service{lk: f, IdentityAccessRoom: func(_ context.Context, _, _ uuid.UUID, _ []IdentityKey) []error {
		out := make([]error, verdicts)
		for i := range out {
			out[i] = httpx.Unavailable(errors.New("db down"))
		}
		return out
	}}
	now := time.Now()
	svc.identitySweep.now = func() time.Time { return now }
	if err := svc.EnforceIdentity(context.Background()); err != nil || len(f.removed) != 0 {
		t.Fatalf("first undecided sweep: err=%v removed=%v", err, f.removed)
	}
	// A gate that answers the wrong number of verdicts is undecided too, never a denial.
	verdicts = 1
	if err := svc.EnforceIdentity(context.Background()); err != nil || len(f.removed) != 0 {
		t.Fatalf("broken gate evicted: err=%v removed=%v", err, f.removed)
	}
	now = now.Add(identityTransientGrace)
	if err := svc.EnforceIdentity(context.Background()); err != nil || len(f.removed) != 4 {
		t.Fatalf("after grace: err=%v removed=%d, want 4", err, len(f.removed))
	}
}
