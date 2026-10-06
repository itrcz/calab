package gateway

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protowire"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// bufferQueue: frames waiting for the Redis buffer writer. Overflow (Redis far behind)
// marks the session unresumable instead of growing memory (security review M4).
const bufferQueue = 512

// encEvent is a DispatchEvent marshalled at most once per instance, however many sessions
// receive it (security review M13); each session only prepends its op and seq.
type encEvent struct {
	workspace uuid.UUID
	// Receipt proofs authorize only this event's own guestView, never workspace data.
	receipts map[uuid.UUID]admissionReceiptProof
	scopes   []uuid.UUID
	scoped   bool
	ev       *v1.DispatchEvent
	once     sync.Once
	b        []byte
	err      error
}

func newEnc(ev *v1.DispatchEvent) *encEvent { return &encEvent{ev: ev} }

// ephemeral: TYPING_START lives 3 s on the client (TypingIndicator). It goes out without a seq
// (gateway.proto: clients skip seq tracking for seq 0 — every client since the first release)
// and never into the resume buffer: a replay after reconnect would only show a stale «печатает»,
// and buffering it cost a 5-command Redis pipeline per recipient per keystroke burst (docs/18
// step 7).
func (e *encEvent) ephemeral() bool {
	_, ok := e.ev.GetEvent().(*v1.DispatchEvent_TypingStart)
	return ok
}

func (e *encEvent) bytes() ([]byte, error) {
	e.once.Do(func() { e.b, e.err = proto.Marshal(e.ev) })
	return e.b, e.err
}

// frameBytes builds a binary GatewayFrame{op: DISPATCH, seq, dispatch: payload} directly
// from the encoded payload (field numbers from gateway.proto: op=1, seq=2, dispatch=24);
// seq 0 (an ephemeral event) is omitted, as proto.Marshal would.
func frameBytes(seq uint64, payload []byte) []byte {
	b := make([]byte, 0, len(payload)+16)
	b = protowire.AppendTag(b, 1, protowire.VarintType)
	b = protowire.AppendVarint(b, uint64(v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH))
	if seq != 0 {
		b = protowire.AppendTag(b, 2, protowire.VarintType)
		b = protowire.AppendVarint(b, seq)
	}
	b = protowire.AppendTag(b, 24, protowire.BytesType)
	return protowire.AppendBytes(b, payload)
}

type pendingEvent struct {
	id   uuid.UUID
	enc  *encEvent
	mark *pauseMark // non-nil: placeholder where a paused preparation's events go (B1)
}

// pauseMark identifies one pause; its sentinel sits in pending at the pause point, so
// overlapping pauses cannot shift each other's insertion position. Not zero-sized: pointers
// to distinct zero-size values may compare equal.
type pauseMark struct{ _ byte }

// Session is a gateway session (one device connection that survives reconnects via RESUME).
// It lives on its owning instance; while detached (no socket) it keeps buffering events for
// up to resumeWindow.
type Session struct {
	id, user, asess uuid.UUID
	principal       identitypolicy.Principal
	bot             bool       // a bot token (ADR-0031): no read receipts (docs/09 #92)
	tab             string     // Identify.tab_id: the browser tab of the auth session (tabs.go)
	client          clientInfo // Identify.device (docs/09 #143); set before register, then read-only
	hub             *Hub

	leases identityLeases

	mu         sync.Mutex
	seq        uint64
	ready      bool           // READY (or resume replay) sent; before that events wait in pending
	paused     int            // >0: events wait in pending (async WORKSPACE_CREATE preparation)
	pending    []pendingEvent //
	conn       *conn
	dead       bool
	workspaces map[uuid.UUID]bool
	subscribed map[uuid.UUID]bool
	// omitted: workspaces left out of READY while their lease was pending. Their events
	// queued before the sweep's WORKSPACE_CREATE are undeliverable and dropped (emit).
	omitted map[uuid.UUID]bool
	dmPeers map[uuid.UUID]uuid.UUID // DM room -> peer; uuid.Nil = not a DM of this user (see Hub.dmPeer)
	status  v1.PresenceStatus
	recent  [128]uuid.UUID
	recentN int
	detachT *time.Timer

	wq     chan entry
	qmu    sync.RWMutex       // guards sends on wq against closeQueue (no send on a closed channel)
	qdone  bool               // wq closed (qmu)
	broken atomic.Bool        // buffer overflow / Redis error: no longer resumable
	skip   map[uuid.UUID]bool // event ids already replayed from the buffer (takeover), until pending drains
}

func newSession(h *Hub, id, user, asess uuid.UUID, bot bool) *Session {
	s := &Session{
		id: id, user: user, asess: asess, hub: h, bot: bot,
		workspaces: map[uuid.UUID]bool{}, subscribed: map[uuid.UUID]bool{}, dmPeers: map[uuid.UUID]uuid.UUID{},
		status: v1.PresenceStatus_PRESENCE_STATUS_ONLINE,
		wq:     make(chan entry, bufferQueue),
	}
	go s.bufferWriter()
	return s
}

// closeQueue stops the buffer writer (idempotent, safe against concurrent sends).
func (s *Session) closeQueue() {
	s.qmu.Lock()
	defer s.qmu.Unlock()
	if !s.qdone {
		s.qdone = true
		close(s.wq)
	}
}

// enqueue offers an entry to the buffer writer without blocking; false if the queue is
// closed or full.
func (s *Session) enqueue(e entry) bool {
	s.qmu.RLock()
	defer s.qmu.RUnlock()
	if s.qdone {
		return false
	}
	select {
	case s.wq <- e:
		return true
	default:
		return false
	}
}

// bufferWriter appends dispatched frames to the Redis session buffer in order.
// An entry with a nil frame and a flush channel acts as a barrier.
func (s *Session) bufferWriter() {
	batch := make([]entry, 0, 64)
	for e := range s.wq {
		batch = batch[:0]
		var barriers []chan struct{}
		collect := func(e entry) {
			if e.flush != nil {
				barriers = append(barriers, e.flush)
				return
			}
			batch = append(batch, e)
		}
		collect(e)
	drain:
		for len(batch) < 64 {
			select {
			case e, ok := <-s.wq:
				if !ok {
					break drain
				}
				collect(e)
			default:
				break drain
			}
		}
		if len(batch) > 0 {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := s.hub.buf.append(ctx, s.id, batch); err != nil {
				slog.Warn("gateway buffer append", "session", s.id, "err", err)
				s.broken.Store(true)
			}
			cancel()
		}
		for _, b := range barriers {
			close(b)
		}
	}
}

// flush waits until everything dispatched so far is in Redis (must not hold s.mu).
func (s *Session) flush() {
	done := make(chan struct{})
	if !s.enqueue(entry{flush: done}) {
		s.broken.Store(true)
		return
	}
	select {
	case <-done:
	case <-time.After(6 * time.Second):
		s.broken.Store(true)
	}
}

func (s *Session) seen(id uuid.UUID) bool {
	for _, r := range s.recent {
		if r == id {
			return true
		}
	}
	s.recent[s.recentN%len(s.recent)] = id
	s.recentN++
	return false
}

// dispatch delivers an event built for this recipient only.
func (s *Session) dispatch(id uuid.UUID, ev *v1.DispatchEvent) { s.dispatchEnc(id, newEnc(ev)) }

// dispatchEnc delivers a (shared) encoded event, deduplicated by event id.
func (s *Session) dispatchEnc(id uuid.UUID, enc *encEvent) {
	if s.identityEnabled() && !s.allowsEvent(enc) {
		s.deferIdentityEvent(id, enc)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead || s.seen(id) {
		return
	}
	if !s.ready || s.paused > 0 {
		if len(s.pending) >= bufferQueue {
			s.broken.Store(true)
			if s.conn != nil {
				s.conn.closeNow(4000, "resync required")
			}
			return
		}
		s.pending = append(s.pending, pendingEvent{id: id, enc: enc})
		return
	}
	s.emit(id, enc)
}

// emit assigns the next seq, buffers the frame and sends it (an ephemeral event: sends only,
// without a seq); s.mu must be held.
func (s *Session) emit(id uuid.UUID, enc *encEvent) {
	if s.dead {
		return
	}
	if s.omittedEventLocked(enc) {
		return
	}
	if s.identityEnabled() && !s.allowsEvent(enc) {
		s.broken.Store(true)
		if s.conn != nil {
			s.conn.closeNow(4000, "identity resync required")
		}
		return
	}
	payload, err := enc.bytes()
	if err != nil {
		return
	}
	if enc.ephemeral() {
		eventsDispatched.Inc()
		if s.conn != nil {
			if typ, b, err := s.conn.codec.transcode(frameBytes(0, payload)); err == nil {
				s.conn.sendEvent(typ, b, s, enc)
			}
		}
		return
	}
	s.seq++
	bin := frameBytes(s.seq, payload)
	if !s.enqueue(entry{id: id, seq: s.seq, frame: bin, workspace: enc.workspace, identityFormat: true}) {
		s.broken.Store(true)
	}
	eventsDispatched.Inc()
	if s.conn != nil {
		typ, b, err := s.conn.codec.transcode(bin)
		if err == nil {
			s.conn.sendEvent(typ, b, s, enc)
		}
	}
}

// omitWorkspace records a workspace left out of READY (see omitted).
func (s *Session) omitWorkspace(ws uuid.UUID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.omitted == nil {
		s.omitted = map[uuid.UUID]bool{}
	}
	s.omitted[ws] = true
}

// omittedEventLocked reports an event of a workspace omitted from READY, emitted before
// that workspace's WORKSPACE_CREATE (which ends the omission); s.mu must be held. The client
// has no state for it and the snapshot supersedes it, so it is dropped rather than closing
// the session with "identity resync required".
func (s *Session) omittedEventLocked(enc *encEvent) bool {
	if len(s.omitted) == 0 || enc == nil || enc.ev == nil {
		return false
	}
	if created := enc.ev.GetWorkspaceCreate(); created != nil {
		delete(s.omitted, parseID(created.GetSnapshot().GetWorkspace().GetId()))
		return false
	}
	if s.omitted[enc.workspace] {
		return true
	}
	for _, ws := range enc.scopes {
		if s.omitted[ws] {
			return true
		}
	}
	return false
}

// flushPending emits queued events once nothing holds them back; s.mu must be held.
// skip (ids already replayed from the buffer after a takeover) is kept on the session until
// the pending queue has actually drained — a pause may postpone the flush (review R6).
func (s *Session) flushPending(skip map[uuid.UUID]bool) {
	if len(skip) > 0 {
		if s.skip == nil {
			s.skip = map[uuid.UUID]bool{}
		}
		for id := range skip {
			s.skip[id] = true
		}
	}
	if !s.ready || s.paused > 0 {
		return
	}
	for _, p := range s.pending {
		if p.mark == nil && !s.skip[p.id] {
			s.emit(p.id, p.enc)
		}
	}
	s.pending, s.skip = nil, nil
}

// pause makes later events wait (in order) until resume; the returned mark's sentinel in
// pending is where the prepared events will be inserted.
func (s *Session) pause() *pauseMark {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pauseLocked()
}

// pauseEvent reserves deduplication at arrival, before preparations can finish out of order.
func (s *Session) pauseEvent(id uuid.UUID) *pauseMark {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead || s.seen(id) {
		return nil
	}
	return s.pauseLocked()
}

func (s *Session) pauseLocked() *pauseMark {
	m := &pauseMark{}
	if len(s.pending) >= bufferQueue {
		s.broken.Store(true)
		if s.conn != nil {
			s.conn.closeNow(4000, "resync required")
		}
		return m
	}
	s.paused++
	s.pending = append(s.pending, pendingEvent{mark: m})
	return m
}

// resume replaces the pause's sentinel with the prepared event and releases the queue.
func (s *Session) resume(m *pauseMark, id uuid.UUID, enc *encEvent) {
	s.resumeMany(m, []pendingEvent{{id: id, enc: enc}})
}

func (s *Session) resumeMany(m *pauseMark, evs []pendingEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead {
		return
	}
	for i, p := range s.pending {
		if p.mark == m {
			s.paused--
			if len(evs)+len(s.pending)-1 > bufferQueue {
				// evs are dropped: the client must resync instead of living on without them.
				evs = nil
				s.broken.Store(true)
				if s.conn != nil {
					s.conn.closeNow(4000, "resync required")
				}
			}
			rest := append([]pendingEvent{}, s.pending[i+1:]...)
			s.pending = append(append(s.pending[:i], evs...), rest...)
			break
		}
	}
	s.flushPending(nil)
}

// detach drops the socket but keeps the session resumable for resumeWindow.
func (s *Session) detach(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead || s.conn != c {
		return
	}
	s.conn = nil
	s.hub.sockets(-1)
	if s.detachT != nil {
		s.detachT.Stop()
	}
	s.detachT = time.AfterFunc(resumeWindow, func() { s.hub.destroy(s, 0, "") })
}

// attachLocked binds a socket (s.mu held). Frames for it are queued right away; the caller
// decides what precedes them (setReplay) — or holds the socket first (conn.hold).
func (s *Session) attachLocked(c *conn) {
	if s.detachT != nil {
		s.detachT.Stop()
		s.detachT = nil
	}
	if old := s.conn; old != nil && old != c {
		old.closeNow(4000, "resumed elsewhere")
		s.hub.sockets(-1)
	}
	s.conn = c
	s.hub.sockets(1)
}
