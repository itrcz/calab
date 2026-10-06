package rtc

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/voice"
	"github.com/google/uuid"
	"github.com/redis/rueidis"
)

// checkIdentity is session-specific and separate from member permission computation.
func (s *Service) checkIdentity(ctx context.Context, ws, room, user, session uuid.UUID) error {
	if s.IdentityAccess == nil {
		return errors.New("RTC identity gate unavailable")
	}
	return s.IdentityAccess(ctx, ws, room, user, session)
}

// Each gate check runs several sequential queries on the shared DB pool, and its budget
// starts before the first one. More workers than free pool connections only queue the
// checks inside the pool, where the wait eats their budget: with a remote database
// (a few ms per round trip) the tail of a sweep timed out and was evicted after the
// grace period (2026-10-06: 64 workers on a pool of 5). identityWorkers caps the
// workers below the pool size, leaving a connection for requests.
const (
	identityRoomWorkers        = 8
	identityParticipantWorkers = 8
)

func (s *Service) identityWorkers() int {
	n := identityParticipantWorkers
	if s.db != nil && s.db.Pool != nil {
		n = min(n, max(1, int(s.db.Pool.Config().MaxConns)-1))
	}
	return n
}

// A context-aware semaphore serializes sweeps without holding a mutex over I/O.
// Its owner also owns the cursor, including when a sweep exhausts its budget.
type identitySweepState struct {
	once     sync.Once
	token    chan struct{}
	lastRoom string

	// failing: room + SFU identity -> unbroken run of transient gate failures (timeout,
	// 5xx). Per replica; another replica's sweep only delays the eviction.
	failMu  sync.Mutex
	failing map[string]failureRun
	now     func() time.Time // tests
}

type failureRun struct{ first, last time.Time }

// identityTransientGrace: how long the gate may keep failing transiently for one
// participant before the sweep evicts anyway. A blip of the shared database (seconds)
// must not empty every call, while an outage still cannot keep a revoked session for long.
const identityTransientGrace = 30 * time.Second

func (st *identitySweepState) clock() time.Time {
	if st.now != nil {
		return st.now()
	}
	return time.Now()
}

// transientFailureExpired records a transient failure for key and reports whether its
// unbroken run has lasted identityTransientGrace.
func (st *identitySweepState) transientFailureExpired(key string) bool {
	now := st.clock()
	st.failMu.Lock()
	defer st.failMu.Unlock()
	if st.failing == nil {
		st.failing = map[string]failureRun{}
	}
	run, ok := st.failing[key]
	if !ok {
		run.first = now
	}
	run.last = now
	st.failing[key] = run
	return now.Sub(run.first) >= identityTransientGrace
}

func (st *identitySweepState) clearFailure(key string) {
	st.failMu.Lock()
	delete(st.failing, key)
	st.failMu.Unlock()
}

// pruneFailures forgets runs not seen for a while: the participant left the SFU.
func (st *identitySweepState) pruneFailures() {
	cutoff := st.clock().Add(-10 * identityTransientGrace)
	st.failMu.Lock()
	for key, run := range st.failing {
		if run.last.Before(cutoff) {
			delete(st.failing, key)
		}
	}
	st.failMu.Unlock()
}

// transientIdentityError: the gate could not decide (its budget ran out or a dependency
// failed), as opposed to deciding "no". The gate wraps a revoked session and a missing
// user or room in 503 too; those are decisions. Unknown errors stay denials.
func transientIdentityError(err error) bool {
	if errors.Is(err, auth.ErrSessionRevoked) || errors.Is(err, identitypolicy.ErrDenied) || db.IsNotFound(err) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var he *httpx.Error
	return errors.As(err, &he) && he.Status >= 500
}

// EnforceIdentity enumerates the SFU independently of Redis. Lost pubsub, a lost webhook
// and an unavailable voice-state store cannot keep a denied participant connected.
// A denial from the gate evicts at once; a transient gate failure (timeout, 5xx) evicts
// only after identityTransientGrace of unbroken failures, so a short database stall does
// not drop everyone in every call. SFU removal failures remain visible and are retried.
func (s *Service) EnforceIdentity(ctx context.Context) error {
	state := &s.identitySweep
	state.once.Do(func() { state.token = make(chan struct{}, 1) })
	select {
	case state.token <- struct{}{}:
		defer func() { <-state.token }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	state.pruneFailures()
	rooms, err := s.lk.ListRooms(ctx)
	if err != nil {
		return err
	}
	// SFU ordering is not stable. Keep only a name cursor between sweeps and resume
	// after the last scheduled room, rather than retrying a slow prefix forever.
	names := make([]string, 0, len(rooms))
	for _, room := range rooms {
		if _, _, ok := voice.ParseRoomName(room.Name); ok {
			names = append(names, room.Name)
		}
	}
	sort.Strings(names)
	start := sort.Search(len(names), func(i int) bool { return names[i] > state.lastRoom })
	if start == len(names) {
		start = 0
	}
	type roomParticipants struct {
		room    string
		ws, rid uuid.UUID
		people  []Participant
	}
	type participantJob struct {
		room    string
		ws, rid uuid.UUID
		person  Participant
	}
	var mu sync.Mutex
	var firstErr error
	record := func(err error) {
		if err != nil {
			mu.Lock()
			if firstErr == nil {
				firstErr = err
			}
			mu.Unlock()
		}
	}
	roomJobs := make(chan string)
	results := make(chan roomParticipants)
	var enumeration sync.WaitGroup
	for range identityRoomWorkers {
		enumeration.Add(1)
		go func() {
			defer enumeration.Done()
			for room := range roomJobs {
				if ctx.Err() != nil {
					return
				}
				ws, rid, _ := voice.ParseRoomName(room)
				request, cancel := context.WithTimeout(ctx, time.Second)
				people, err := s.lk.ListParticipants(request, room)
				cancel()
				record(err)
				if err != nil {
					people = nil
				}
				select {
				case results <- roomParticipants{room, ws, rid, people}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	jobs := make(chan participantJob)
	var enforcement sync.WaitGroup
	for range s.identityWorkers() {
		enforcement.Add(1)
		go func() {
			defer enforcement.Done()
			for job := range jobs {
				if ctx.Err() != nil {
					return
				}
				uid, sid, ok := voice.ParseIdentity(job.person.Identity)
				if !ok {
					continue
				}
				gate, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
				err := s.checkIdentity(gate, job.ws, job.rid, uid, sid)
				cancel()
				runKey := job.room + "\x00" + job.person.Identity
				if err == nil {
					state.clearFailure(runKey)
					continue
				}
				if ctx.Err() != nil {
					return
				}
				if transientIdentityError(err) {
					if !state.transientFailureExpired(runKey) {
						slog.DebugContext(ctx, "RTC identity check undecided, keeping participant", "room", job.room, "err", err)
						continue
					}
					slog.WarnContext(ctx, "RTC identity check undecided past grace, evicting", "room", job.room, "grace", identityTransientGrace, "err", err)
				}
				remove, done := context.WithTimeout(ctx, 2*time.Second)
				err = s.lk.RemoveParticipant(remove, job.room, job.person.Identity)
				done()
				if err != nil && !IsNotFound(err) {
					record(err)
					continue
				}
				state.clearFailure(runKey)
				// Redis is bookkeeping after authoritative SFU eviction, never its prerequisite.
				if s.voice.C != nil {
					clean, done := context.WithTimeout(ctx, 100*time.Millisecond)
					_ = s.update(clean, job.ws, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
						if cur != nil && cur.RoomID == job.rid {
							return nil
						}
						return cur
					})
					done()
				}
			}
		}()
	}
	// Stream discovered rooms immediately into enforcement, round-robin over at most
	// eight room responses. Backpressure bounds retained responses to this queue plus
	// one per enumerator, instead of accumulating every room's participants.
	groups := make([]roomParticipants, 0, identityRoomWorkers)
	scheduled, pending := 0, 0
	for scheduled < len(names) || pending > 0 || len(groups) > 0 {
		if ctx.Err() != nil {
			break
		}
		var sendRoom chan string
		var nextRoom string
		if scheduled < len(names) {
			sendRoom = roomJobs
			nextRoom = names[(start+scheduled)%len(names)]
		}
		var receiveRoom chan roomParticipants
		if len(groups) < identityRoomWorkers {
			receiveRoom = results
		}
		var sendPerson chan participantJob
		var nextPerson participantJob
		if len(groups) > 0 {
			group := groups[0]
			sendPerson = jobs
			nextPerson = participantJob{group.room, group.ws, group.rid, group.people[0]}
		}
		select {
		case sendRoom <- nextRoom:
			state.lastRoom = nextRoom
			scheduled++
			pending++
		case group := <-receiveRoom:
			pending--
			if len(group.people) > 0 {
				groups = append(groups, group)
			}
		case sendPerson <- nextPerson:
			group := groups[0]
			group.people = group.people[1:]
			copy(groups, groups[1:])
			groups[len(groups)-1] = roomParticipants{}
			groups = groups[:len(groups)-1]
			if len(group.people) > 0 {
				groups = append(groups, group)
			}
		case <-ctx.Done():
		}
	}
	close(roomJobs)
	enumeration.Wait()
	close(jobs)
	enforcement.Wait()
	record(ctx.Err())
	return firstErr
}

// Cluster-wide sweep claims (Valkey): one replica sweeps per period instead of every
// replica re-checking every participant. A wake (revocation notice, delivered to all
// replicas) claims separately and briefly, so a periodic claim never delays it.
const (
	identitySweepPeriod = 5 * time.Second
	identitySweepHold   = identitySweepPeriod - 500*time.Millisecond
	identityWakeHold    = time.Second
)

// claimIdentitySweep reports whether this replica runs the sweep. Valkey errors other
// than "already claimed" sweep locally: losing the lock store must not stop enforcement.
func (s *Service) claimIdentitySweep(ctx context.Context, key string, hold time.Duration) bool {
	if s.redis == nil {
		return true
	}
	err := s.redis.Do(ctx, s.redis.B().Set().Key(redisx.Key(key)).Value("1").Nx().Px(hold).Build()).Error()
	return err == nil || !rueidis.IsRedisNil(err)
}

// RunIdentityEnforcement supplements immediate mutation hooks with a short DB/SFU sweep.
func (s *Service) RunIdentityEnforcement(ctx context.Context) {
	ticker := time.NewTicker(identitySweepPeriod)
	defer ticker.Stop()
	var retry <-chan time.Time
	for {
		key, hold := "rtc:identity:sweep", identitySweepHold
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.identityWake:
			key, hold = "rtc:identity:wake", identityWakeHold
		case <-retry:
			retry = nil
			key, hold = "rtc:identity:wake", identityWakeHold
		}
		claim, cancel := context.WithTimeout(ctx, time.Second)
		ok := s.claimIdentitySweep(claim, key, hold)
		cancel()
		if !ok {
			// Another replica is sweeping for a wake; it may have read the DB before
			// this notice, so try once more after its claim expires.
			if key == "rtc:identity:wake" && retry == nil {
				retry = time.After(hold)
			}
			continue
		}
		work, done := context.WithTimeout(ctx, 20*time.Second)
		if err := s.EnforceIdentity(work); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "RTC identity sweep failed", "err", err)
		}
		done()
	}
}

// IdentityChanged coalesces versioned revocations; the next sweep reads the DB source.
func (s *Service) IdentityChanged() {
	select {
	case s.identityWake <- struct{}{}:
	default:
	}
}
