// Package calls implements one-to-one calls (ADR-0034): a call is a voice session of a DM
// room. Signalling state lives in Valkey (store.go; the server stays stateless), media goes
// through the rtc package (LiveKit room "dm:<room_id>", POST /api/rooms/{id}/join only for a
// participant of the DM's ACTIVE call). Every finished call leaves a CallCard system message
// in the DM.
//
// Timers: a ringing call is MISSED after RingTimeout (45 s) — a timer on the instance that
// placed it, and the sweeper (every 15 s, one instance at a time) as the fallback when that
// instance is gone. An ACTIVE call whose participant has no device in the voice session for
// LostGrace (30 s) — left and did not come back, or never joined after the answer — is ENDED
// with reason "lost": the rtc package reports every join / leave of the session
// (VoiceChanged), a timer checks after the grace, the sweeper again as the fallback; before
// ending, the voice state is re-read so a missed event cannot end a live call.
package calls

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Defaults (ADR-0034 §2).
const (
	DefaultRingTimeout = 45 * time.Second
	DefaultLostGrace   = 30 * time.Second
	DefaultTick        = 15 * time.Second
)

// Media is the voice side of calls (the rtc service); nil without LiveKit — then calls are
// signalled but never lost (nobody can join anyway).
type Media interface {
	// InCall reports whether u has a device (connected or connecting) in the DM's session.
	InCall(ctx context.Context, dmRoomID, u uuid.UUID) (bool, error)
	// EndCall disconnects everyone from the DM's session (the call ended).
	EndCall(ctx context.Context, dmRoomID uuid.UUID)
}

// Service serves the call routes and runs the call timers.
type Service struct {
	db      *db.DB
	store   Store
	redis   rueidis.Client
	events  events.Publisher
	system  *messages.System
	limiter *redisx.RateLimiter // calls a user places, in all
	perDM   *redisx.RateLimiter // calls a user places in one DM (ring spam)
	// Media: set by the app when LiveKit is configured.
	Media Media
	// Presence announces a user's presence after on_call changed (the gateway).
	Presence func(ctx context.Context, u uuid.UUID)

	ring, lost, tick atomic.Int64 // durations
	noTimers         atomic.Bool  // tests: only the sweeper settles calls
	// Tests: the periodic sweep (Run) is paused; sweepMu is held by Run around each sweep so
	// that pausing waits for a sweep in flight.
	noSweep atomic.Bool
	sweepMu sync.Mutex
}

// New creates the call service; limiter bounds how many calls a user places in all, perDM
// how many they place in one DM (keyed by caller and DM: re-ringing the same person).
func New(d *db.DB, r rueidis.Client, ev events.Publisher, limiter, perDM *redisx.RateLimiter) *Service {
	s := &Service{db: d, store: Store{C: r}, redis: r, events: ev, system: messages.NewSystem(d, ev), limiter: limiter, perDM: perDM}
	s.SetTimeouts(DefaultRingTimeout, DefaultLostGrace, DefaultTick)
	return s
}

// SetTimeouts changes the ring timeout, the lost grace and the sweeper period (tests); the
// period applies from the next Run.
func (s *Service) SetTimeouts(ring, lost, tick time.Duration) {
	s.ring.Store(int64(ring))
	s.lost.Store(int64(lost))
	s.tick.Store(int64(tick))
}

// SetInstanceTimers turns the per-instance timers on or off (tests of the sweeper fallback).
func (s *Service) SetInstanceTimers(on bool) { s.noTimers.Store(!on) }

// SetPeriodicSweep pauses or resumes the sweeps of Run (tests: a call settles only by the
// instance timer, or only by an explicit Sweep). Pausing returns after a sweep in flight.
func (s *Service) SetPeriodicSweep(on bool) {
	s.noSweep.Store(!on)
	s.sweepMu.Lock()
	s.sweepMu.Unlock() //nolint:staticcheck // barrier: wait out a sweep in flight
}

func (s *Service) ringTimeout() time.Duration { return time.Duration(s.ring.Load()) }
func (s *Service) lostGrace() time.Duration   { return time.Duration(s.lost.Load()) }

// Store gives read access to the call state (the gateway: READY.call).
func (s *Service) Store() Store { return s.store }

// Routes registers the call routes; wrap must apply auth + the perm resolver.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/dms/{id}/call", wrap(httpx.HandlerFunc(s.start)))
	mux.Handle("POST /api/calls/{id}/accept", wrap(s.action(Accept)))
	mux.Handle("POST /api/calls/{id}/decline", wrap(s.action(Decline)))
	mux.Handle("POST /api/calls/{id}/cancel", wrap(s.action(Cancel)))
	mux.Handle("POST /api/calls/{id}/hangup", wrap(s.action(Hangup)))
}

var (
	errBusy   = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_BUSY, "the user is in another call")
	errInCall = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_IN_CALL, "you are already in a call")
)

// start: POST /api/dms/{id}/call (see call.proto).
func (s *Service) start(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	id := auth.MustFromContext(ctx)
	if id.IsBot {
		return auth.ErrBotNotAllowed
	}
	roomID, err := httpx.PathUUID(r, "id", "dm")
	if err != nil {
		return err
	}
	me, err := s.db.Q.GetUser(ctx, id.UserID)
	if err != nil {
		return err
	}
	if me.IsGuest {
		return httpx.Forbidden("calls are not available for guest accounts")
	}
	peerID, err := s.db.Q.GetDMPeer(ctx, sqlc.GetDMPeerParams{RoomID: roomID, UserID: id.UserID})
	if db.IsNotFound(err) {
		return httpx.NotFound("dm")
	}
	if err != nil {
		return err
	}
	if err := s.mayCall(ctx, id.UserID, peerID); err != nil {
		return err
	}
	if err := s.limiter.Take(ctx, id.UserID.String()); err != nil {
		return err
	}
	// Ring spam (cancel and call again, each ring a ringtone and a card for the callee) is
	// bounded per DM, well below the overall limit.
	if err := s.perDM.Take(ctx, id.UserID.String()+":"+roomID.String()); err != nil {
		return err
	}
	now := time.Now()
	rec := Record{ID: uuid.Must(uuid.NewV7()), DM: roomID, Caller: id.UserID, Callee: peerID,
		State: v1.CallState_CALL_STATE_RINGING, Created: now.UnixMilli()}
	res, err := s.store.Start(ctx, rec, now.Add(s.ringTimeout()))
	if err != nil {
		return httpx.Unavailable(err)
	}
	post := context.WithoutCancel(ctx)
	switch res {
	case inCall:
		return errInCall
	case busy:
		rec.State, rec.Ended = v1.CallState_CALL_STATE_BUSY, now.UnixMilli()
		s.postCard(post, rec)
		return errBusy
	case started:
	default:
		return httpx.Unavailable(errors.New("calls: unexpected start result " + res))
	}
	s.armRing(rec.ID)
	s.events.User(post, peerID, &v1.DispatchEvent{Event: &v1.DispatchEvent_CallRing{CallRing: &v1.CallRing{Call: rec.Proto(), Caller: pbconv.User(me)}}})
	s.publishState(post, rec)
	httpx.Write(w, http.StatusCreated, &v1.StartCallResponse{Call: rec.Proto()})
	return nil
}

// mayCall is the «можно писать» rule of a call (ADR-0034 §2): the peer is a person (not a
// bot, guest or disabled account) sharing a workspace with the caller as full members.
func (s *Service) mayCall(ctx context.Context, me, peerID uuid.UUID) error {
	peer, err := s.db.Q.GetUser(ctx, peerID)
	if err != nil {
		return err
	}
	switch {
	case peer.IsBot:
		return httpx.Forbidden("bots cannot be called")
	case peer.IsGuest, peer.DisabledAt != nil:
		return httpx.Forbidden("this user cannot be called")
	}
	shared, err := s.db.Q.ShareWorkspace(ctx, sqlc.ShareWorkspaceParams{UserID: me, OtherID: peerID})
	if err != nil {
		return err
	}
	if !shared {
		return httpx.Forbidden("you share no workspace with this user any more")
	}
	return dms.CheckPersonDM(ctx, s.db.Q, me, peerID) // ADR-0154
}

// action serves POST /api/calls/{id}/{accept|decline|cancel|hangup}.
func (s *Service) action(a Action) http.Handler {
	return httpx.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		ctx := r.Context()
		me := auth.MustFromContext(ctx)
		if me.IsBot {
			return auth.ErrBotNotAllowed
		}
		callID, err := httpx.PathUUID(r, "id", "call")
		if err != nil {
			return err
		}
		before, after, err := s.store.Update(ctx, callID, func(cur Record) (Record, error) {
			return cur.Apply(a, me.UserID, time.Now())
		})
		switch {
		case errors.Is(err, ErrNotFound), errors.Is(err, ErrNotParticipant):
			return httpx.NotFound("call")
		case errors.Is(err, ErrWrongSide):
			return httpx.Forbidden("only the other side of the call can do this")
		case errors.Is(err, ErrState):
			return httpx.Conflict("the call is " + stateName(before.State))
		case err != nil:
			return httpx.Unavailable(err)
		}
		s.settled(context.WithoutCancel(ctx), before, after)
		httpx.Write(w, http.StatusOK, &v1.CallActionResponse{Call: after.Proto()})
		return nil
	})
}

func stateName(st v1.CallState) string {
	switch st {
	case v1.CallState_CALL_STATE_RINGING:
		return "ringing"
	case v1.CallState_CALL_STATE_ACTIVE:
		return "active"
	}
	return "over"
}

// settled does everything that follows a transition: CALL_STATE to both sides; on the
// answer presence (on_call); at the end the call card, and for a call that was ACTIVE
// presence and the media session.
func (s *Service) settled(ctx context.Context, before, after Record) {
	if before.State == after.State {
		return
	}
	s.publishState(ctx, after)
	switch {
	case after.State == v1.CallState_CALL_STATE_ACTIVE:
		s.presence(ctx, after)
		s.armLost(after.ID)
	case Terminal(after.State):
		s.postCard(ctx, after)
		if before.State == v1.CallState_CALL_STATE_ACTIVE {
			if s.Media != nil {
				s.Media.EndCall(ctx, after.DM)
			}
			s.presence(ctx, after)
		}
	}
}

func (s *Service) publishState(ctx context.Context, r Record) {
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_CallState{CallState: &v1.CallStateUpdate{Call: r.Proto()}}}
	s.events.User(ctx, r.Caller, ev)
	s.events.User(ctx, r.Callee, ev)
}

func (s *Service) presence(ctx context.Context, r Record) {
	if s.Presence != nil {
		s.Presence(ctx, r.Caller)
		s.Presence(ctx, r.Callee)
	}
}

// postCard writes the call's log line into the DM (ADR-0034 §5). A MISSED call stays unread
// for the callee and takes the DM out of their archive, like an incoming message. Every
// other outcome is read at once: for the caller (its author) always, for the callee when the
// DM had nothing unread for them — moving their marker past messages they have not seen
// would lose those.
func (s *Service) postCard(ctx context.Context, r Record) {
	readers := []uuid.UUID{r.Caller}
	missed := r.State == v1.CallState_CALL_STATE_MISSED
	if !missed && s.nothingUnread(ctx, r.Callee, r.DM) {
		readers = append(readers, r.Callee)
	}
	payload := &v1.SystemMessage{Payload: &v1.SystemMessage_Call{Call: r.Card()}}
	if _, err := s.system.PostDM(ctx, r.DM, r.Caller, []uuid.UUID{r.Caller, r.Callee}, readers, payload); err != nil {
		slog.WarnContext(ctx, "post call card", "call", r.ID, "err", err)
		return
	}
	if !missed {
		return
	}
	states, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) ([]sqlc.DmState, error) {
		return guarded.UnarchiveDMForRecipients(ctx, sqlc.UnarchiveDMForRecipientsParams{RoomID: r.DM, AuthorID: r.Caller})
	})
	if err != nil {
		slog.WarnContext(ctx, "unarchive DM after a missed call", "call", r.ID, "err", err)
		return
	}
	for _, st := range states {
		s.events.User(ctx, st.UserID, dms.StateEvent(st))
	}
}

// nothingUnread reports whether u has no unread message in the DM (false on errors).
func (s *Service) nothingUnread(ctx context.Context, u, dm uuid.UUID) bool {
	rows, err := s.db.Q.ListDMs(ctx, sqlc.ListDMsParams{UserID: u, RoomID: &dm, Lim: 1})
	return err == nil && len(rows) == 1 && rows[0].UnreadCount == 0
}

// ---- server-side transitions ----

func (s *Service) armRing(id uuid.UUID) {
	if s.noTimers.Load() {
		return
	}
	time.AfterFunc(s.ringTimeout(), func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.expire(ctx, id, time.Now())
	})
}

func (s *Service) armLost(id uuid.UUID) {
	if s.noTimers.Load() || s.Media == nil {
		return
	}
	time.AfterFunc(s.lostGrace()+100*time.Millisecond, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.checkLost(ctx, id, time.Now())
	})
}

// expire makes a ringing call MISSED once its ring timeout is over.
func (s *Service) expire(ctx context.Context, id uuid.UUID, now time.Time) {
	before, after, err := s.store.Update(ctx, id, func(cur Record) (Record, error) {
		if cur.State != v1.CallState_CALL_STATE_RINGING || now.Before(time.UnixMilli(cur.Created).Add(s.ringTimeout())) {
			return cur, nil // answered / ended meanwhile, or not due yet
		}
		return cur.Apply(Timeout, uuid.Nil, now)
	})
	if errors.Is(err, ErrNotFound) {
		_ = s.store.Forget(ctx, id)
		return
	}
	if err != nil {
		slog.WarnContext(ctx, "expire a ringing call", "call", id, "err", err)
		return
	}
	s.settled(ctx, before, after)
}

// checkLost ends an ACTIVE call whose participant has been out of the voice session for
// the lost grace. The voice state is re-read first: a participant who is in the session
// after all (a missed join event) is marked present instead.
func (s *Service) checkLost(ctx context.Context, id uuid.UUID, now time.Time) {
	if s.Media == nil {
		return
	}
	rec, err := s.store.Get(ctx, id)
	if errors.Is(err, ErrNotFound) {
		_ = s.store.Forget(ctx, id)
		return
	}
	if err != nil || rec.State != v1.CallState_CALL_STATE_ACTIVE {
		return
	}
	since, away := rec.LostSince()
	if !away || now.Sub(since) < s.lostGrace() {
		return
	}
	gone := false
	for _, u := range []uuid.UUID{rec.Caller, rec.Callee} {
		if _, ok := rec.Away[u.String()]; !ok {
			continue
		}
		in, err := s.Media.InCall(ctx, rec.DM, u)
		if err != nil {
			return // voice state unknown: decide on the next check
		}
		if in {
			s.setAway(ctx, rec.DM, u, true)
			continue
		}
		gone = true
	}
	if !gone {
		return
	}
	before, after, err := s.store.Update(ctx, id, func(cur Record) (Record, error) {
		since, away := cur.LostSince()
		if cur.State != v1.CallState_CALL_STATE_ACTIVE || !away || now.Sub(since) < s.lostGrace() {
			return cur, nil // back meanwhile, or hung up
		}
		return cur.Apply(Lost, uuid.Nil, now)
	})
	if err != nil {
		if !errors.Is(err, ErrNotFound) {
			slog.WarnContext(ctx, "end a lost call", "call", id, "err", err)
		}
		return
	}
	s.settled(ctx, before, after)
}

// ---- rtc hooks ----

// ActiveParticipant reports whether u takes part in the ACTIVE call of the DM (the gate of
// POST /api/rooms/{id}/join for a DM room).
func (s *Service) ActiveParticipant(ctx context.Context, dmRoomID, u uuid.UUID) (bool, error) {
	rec, ok, err := s.store.Current(ctx, u)
	if err != nil || !ok {
		return false, err
	}
	return rec.State == v1.CallState_CALL_STATE_ACTIVE && rec.DM == dmRoomID, nil
}

// VoiceChanged is called by the rtc service when u's presence in a DM's voice session
// changes (first device in / last device out, pending devices included).
func (s *Service) VoiceChanged(ctx context.Context, dmRoomID, u uuid.UUID, present bool) {
	if s.setAway(ctx, dmRoomID, u, present) && !present {
		rec, ok, err := s.store.Current(ctx, u)
		if err == nil && ok {
			s.armLost(rec.ID)
		}
	}
}

// setAway records u's presence in the session of the DM's ACTIVE call; reports a change.
func (s *Service) setAway(ctx context.Context, dmRoomID, u uuid.UUID, present bool) bool {
	rec, ok, err := s.store.Current(ctx, u)
	if err != nil || !ok || rec.DM != dmRoomID || rec.State != v1.CallState_CALL_STATE_ACTIVE {
		return false
	}
	changed := false
	_, _, err = s.store.Update(ctx, rec.ID, func(cur Record) (Record, error) {
		next, ch := cur.SetAway(u, present, time.Now())
		changed = ch
		return next, nil
	})
	if err != nil && !errors.Is(err, ErrNotFound) {
		slog.WarnContext(ctx, "record call presence", "call", rec.ID, "user", u, "err", err)
	}
	return err == nil && changed
}

// ---- sweeper ----

// Run sweeps due calls every tick until ctx is done (one instance per tick: Valkey lock).
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(time.Duration(s.tick.Load()))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		hold := max(time.Duration(s.tick.Load())-100*time.Millisecond, 50*time.Millisecond)
		lock := s.redis.B().Set().Key(redisx.Key("calls:sweep")).Value("1").Nx().Px(hold).Build()
		if s.redis.Do(ctx, lock).Error() != nil {
			continue
		}
		s.sweepMu.Lock()
		if !s.noSweep.Load() {
			s.Sweep(ctx)
		}
		s.sweepMu.Unlock()
	}
}

// Sweep settles ringing calls past their timeout and ACTIVE calls lost for the grace.
func (s *Service) Sweep(ctx context.Context) {
	now := time.Now()
	if ids, err := s.store.DueRinging(ctx, now); err == nil {
		for _, id := range ids {
			s.expire(ctx, id, now)
		}
	}
	if s.Media == nil {
		return
	}
	if ids, err := s.store.ActiveIDs(ctx); err == nil {
		for _, id := range ids {
			s.checkLost(ctx, id, now)
		}
	}
}
