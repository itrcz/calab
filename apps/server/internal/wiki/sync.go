package wiki

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/wikiacl"
)

// The sync socket GET /api/wiki/pages/{id}/sync (ADR-0096 §4, docs/05 «Вики: сокет
// синхронизации»). Binary frames, the first byte is the type, integers big-endian:
//
//	0 SNAPSHOT        server → client  0 | u64 through_seq | state
//	1 UPDATE          both ways        1 | u64 seq | update (client → server: seq ignored, 0)
//	2 AWARENESS       both ways        2 | awareness update (relayed, never stored)
//	3 COMPACT_REQUEST server → client  3
//	4 SNAPSHOT_POST   client → server  4 | u64 through_seq | u32 meta_len | meta JSON | state
//
// The meta JSON of a SNAPSHOT_POST is {plain_text, title, preview, broadcast?}. A stored post is a
// silent compaction (no frame back), unless broadcast is true: the post carries an edit no UPDATE
// carried (one transaction too big for a frame), and its state then goes as a SNAPSHOT to every
// other socket of the page. A stale broadcast post is still relayed (through_seq 0, not stored)
// and the poster gets a COMPACT_REQUEST to persist it with a newer through_seq.
//
// The client's first message is a text frame with its access token (like the gateway's
// IDENTIFY) — a person's access token or a bot token (bots are members like people, ADR-0096
// §2 addendum 2026-10-14). The server then sends one SNAPSHOT (through_seq 0 and the empty Yjs update 0x00 0x00
// for a page without one) and every UPDATE after it, then relays.
const (
	frameSnapshot     byte = 0
	frameUpdate       byte = 1
	frameAwareness    byte = 2
	frameCompact      byte = 3
	frameSnapshotPost byte = 4
	// ctlRecheck travels only between instances (Redis): every socket of the page checks its
	// access again now (trash, overrides, restricted).
	ctlRecheck byte = 0xF0
)

// Limits of the protocol (ADR-0096 §4).
const (
	MaxUpdate   = 64 << 10 // bytes of one Yjs update (and of one awareness update)
	MaxState    = 2 << 20  // bytes of a snapshot's state
	MaxMeta     = 1 << 20  // bytes of a snapshot's meta JSON (plain_text ≤ 256 KiB, escaped)
	MaxText     = 256 << 10
	headerSeq   = 9  // type + u64
	headerPost  = 13 // type + u64 + u32
	readLimitRO = MaxUpdate + 16
	readLimitRW = headerPost + MaxMeta + MaxState
)

// Close codes of the sync socket.
const (
	closeTryAgain  = 4000 // a dependency failed: reconnect
	closeBadFrame  = 4002 // malformed or unexpected frame
	closeForbidden = 4003 // no WIKI_VIEW or not a member, the access policy, a write without WIKI_WRITE
	closeAuth      = 4004 // the token is invalid or expired: refresh it
	closeRate      = 4008 // too many frames, or > MaxConnsPerUser sockets on the page
	closeIdle      = 4009 // no pong
	closeRevoked   = 4010 // the session was revoked
	closeNotFound  = 4404 // no such page, or it is in the trash
)

// emptyState is the Yjs update of an empty document (Y.encodeStateAsUpdate(new Y.Doc())).
var emptyState = []byte{0, 0}

// SyncConfig tunes the sync socket; the zero value is production (tests shorten it).
type SyncConfig struct {
	AuthTimeout        time.Duration // the token frame must come within it (10 s)
	SubscribeTimeout   time.Duration // the page's Redis subscription must be confirmed within it (5 s)
	PingInterval       time.Duration // WebSocket ping (25 s)
	IdleTimeout        time.Duration // no pong for this long closes 4009 (60 s)
	RecheckInterval    time.Duration // access and session recheck (30 s)
	UpdatesPerSecond   int           // inbound UPDATE frames per socket (20, over: close 4008)
	AwarenessPerSecond int           // inbound AWARENESS per socket (10, over: dropped)
	SnapshotEvery      time.Duration // inbound SNAPSHOT_POST per socket: 2 at once, then one per (2 s; over: close 4008)
	MaxConnsPerUser    int           // sockets of one person on one page (10)
	CompactUpdates     int           // COMPACT_REQUEST when more updates follow the snapshot (500)
	CompactBytes       int64         // … or more bytes (1 MiB)
	CompactCooldown    time.Duration // at most one COMPACT_REQUEST per page per (10 s)
	CompactCheckEvery  time.Duration // the threshold query at most this often per page (2 s; < 0 = always)
	VersionEvery       time.Duration // a version at most this often per page (5 min)
	WriteTimeout       time.Duration // one frame to the client (10 s)
}

func (c SyncConfig) withDefaults() SyncConfig {
	def := func(v *time.Duration, d time.Duration) {
		if *v == 0 {
			*v = d
		}
	}
	def(&c.AuthTimeout, 10*time.Second)
	def(&c.SubscribeTimeout, 5*time.Second)
	def(&c.PingInterval, 25*time.Second)
	def(&c.IdleTimeout, 60*time.Second)
	def(&c.RecheckInterval, 30*time.Second)
	def(&c.CompactCooldown, 10*time.Second)
	def(&c.SnapshotEvery, 2*time.Second)
	def(&c.CompactCheckEvery, 2*time.Second)
	def(&c.VersionEvery, 5*time.Minute)
	def(&c.WriteTimeout, 10*time.Second)
	if c.UpdatesPerSecond == 0 {
		c.UpdatesPerSecond = 20
	}
	if c.AwarenessPerSecond == 0 {
		c.AwarenessPerSecond = 10
	}
	if c.MaxConnsPerUser == 0 {
		c.MaxConnsPerUser = 10
	}
	if c.CompactUpdates == 0 {
		c.CompactUpdates = 500
	}
	if c.CompactBytes == 0 {
		c.CompactBytes = 1 << 20
	}
	return c
}

// Authenticator is what the socket needs of auth.Service: the gateway's token check, the
// session recheck and the workspace access policy of the REST identity gate.
type Authenticator interface {
	AuthenticateToken(ctx context.Context, tok string) (auth.Identity, error)
	CheckSession(ctx context.Context, sid uuid.UUID) error
	CheckWorkspace(ctx context.Context, id auth.Identity, ws uuid.UUID, op identitypolicy.Operation) error
	WithPolicy(ctx context.Context, id auth.Identity, op identitypolicy.Operation) context.Context
}

// ---- frames ----

func seqFrame(t byte, seq int64, body []byte) []byte {
	out := make([]byte, headerSeq+len(body))
	out[0] = t
	binary.BigEndian.PutUint64(out[1:9], uint64(max(seq, 0))) //nolint:gosec // non-negative
	copy(out[headerSeq:], body)
	return out
}

func snapshotFrame(through int64, state []byte) []byte {
	return seqFrame(frameSnapshot, through, state)
}
func updateFrame(seq int64, data []byte) []byte { return seqFrame(frameUpdate, seq, data) }

func frameSeq(f []byte) int64 {
	if len(f) < headerSeq {
		return 0
	}
	return int64(binary.BigEndian.Uint64(f[1:9])) //nolint:gosec // ≤ 2^63 in practice
}

// loadSnapshot is the page's snapshot (through_seq 0 and the empty document when none).
func loadSnapshot(ctx context.Context, q *sqlc.Queries, page uuid.UUID) (int64, []byte, error) {
	s, err := q.GetWikiSnapshot(ctx, page)
	if db.IsNotFound(err) {
		return 0, emptyState, nil
	}
	if err != nil {
		return 0, nil, err
	}
	return s.ThroughSeq, s.State, nil
}

// snapshotSeq is the through_seq of the page's snapshot (0 when none).
func snapshotSeq(ctx context.Context, q *sqlc.Queries, page uuid.UUID) (int64, error) {
	seq, err := q.GetWikiSnapshotSeq(ctx, page)
	if db.IsNotFound(err) {
		return 0, nil
	}
	return seq, err
}

// eachUpdate calls fn for every stored update after seq after, in order.
func eachUpdate(ctx context.Context, q *sqlc.Queries, page uuid.UUID, after int64, fn func(seq int64, data []byte) error) error {
	const batch = 500
	for {
		rows, err := q.ListWikiUpdatesSince(ctx, sqlc.ListWikiUpdatesSinceParams{PageID: page, AfterSeq: after, Lim: batch})
		if err != nil {
			return err
		}
		for _, u := range rows {
			if err := fn(u.Seq, u.Data); err != nil {
				return err
			}
			after = u.Seq
		}
		if len(rows) < batch {
			return nil
		}
	}
}

// ---- the hub: rooms of pages, relayed through Redis ----

type syncHub struct {
	s        *Service
	rc       rueidis.Client
	auth     Authenticator
	origin   func(origin string, hasCookie bool) bool
	cfg      SyncConfig
	instance [16]byte

	mu    sync.Mutex
	rooms map[uuid.UUID]*room
}

// room is the sockets of one page on this instance and its Redis subscription.
type room struct {
	id        uuid.UUID
	conns     map[*syncConn]struct{}
	stop      chan struct{}
	lastCheck time.Time // the COMPACT_REQUEST threshold query (hub.mu)
	// ready closes when the first SUBSCRIBE of wiki:<page> is confirmed: a socket reads its
	// snapshot only after it, so that nothing published between that read and the subscription
	// is lost (a frame after the read arrives through Redis; one before it is in the database).
	ready      chan struct{}
	subscribed bool // hub.mu
}

func newSyncHub(s *Service, rc rueidis.Client, a Authenticator, origin func(string, bool) bool, cfg SyncConfig) *syncHub {
	h := &syncHub{s: s, rc: rc, auth: a, origin: origin, cfg: cfg.withDefaults(), rooms: map[uuid.UUID]*room{}}
	h.instance = uuid.New()
	return h
}

func channel(page uuid.UUID) string { return redisx.Channel("wiki:" + page.String()) }

// join adds c to its page's room, subscribing the instance to the page's channel on the first
// socket.
func (h *syncHub) join(c *syncConn) *room {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[c.page]
	if r == nil {
		r = &room{id: c.page, conns: map[*syncConn]struct{}{}, stop: make(chan struct{}), ready: make(chan struct{})}
		h.rooms[c.page] = r
		go h.listen(r)
	}
	r.conns[c] = struct{}{}
	return r
}

// leave removes c; the last socket of a page ends the subscription.
func (h *syncHub) leave(c *syncConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[c.page]
	if r == nil {
		return
	}
	delete(r.conns, c)
	if len(r.conns) == 0 {
		delete(h.rooms, c.page)
		close(r.stop)
	}
}

// listen keeps the room subscribed to wiki:<page> until it is stopped. A subscription lost
// (a reconnect, a concurrent UNSUBSCRIBE of a previous room of the page) is made again; once it
// is confirmed, every socket of the room catches up from the database (frames published
// meanwhile never reached it).
func (h *syncHub) listen(r *room) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { <-r.stop; cancel() }()
	ch := channel(r.id)
	ctx = rueidis.WithOnSubscriptionHook(ctx, func(s rueidis.PubSubSubscription) {
		if s.Kind == "subscribe" && s.Channel == ch {
			h.onSubscribed(r)
		}
	})
	for ctx.Err() == nil {
		err := h.rc.Receive(ctx, h.rc.B().Subscribe().Channel(ch).Build(), func(m rueidis.PubSubMessage) {
			h.onRelay(r, []byte(m.Message))
		})
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			slog.Warn("wiki sync: subscription lost", "page_id", r.id, "err", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(200 * time.Millisecond):
		}
	}
	// Receive does not unsubscribe when its context ends.
	uctx, ucancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer ucancel()
	_ = h.rc.Do(uctx, h.rc.B().Unsubscribe().Channel(ch).Build()).Error()
}

// onSubscribed: the first confirmation opens the room (ready); a later one (a re-subscription)
// makes every socket of the room catch up from the database.
func (h *syncHub) onSubscribed(r *room) {
	h.mu.Lock()
	first := !r.subscribed
	r.subscribed = true
	conns := make([]*syncConn, 0, len(r.conns))
	if !first {
		for c := range r.conns {
			conns = append(conns, c)
		}
	}
	h.mu.Unlock()
	if first {
		close(r.ready)
		return
	}
	for _, c := range conns {
		c.markStale()
	}
}

// onRelay delivers a frame published by another instance to this instance's sockets of the page.
func (h *syncHub) onRelay(r *room, msg []byte) {
	if len(msg) < 17 || bytes.Equal(msg[:16], h.instance[:]) {
		return
	}
	frame := msg[16:]
	h.mu.Lock()
	conns := make([]*syncConn, 0, len(r.conns))
	for c := range r.conns {
		conns = append(conns, c)
	}
	h.mu.Unlock()
	for _, c := range conns {
		if frame[0] == ctlRecheck {
			c.recheckSoon()
		} else {
			c.enqueue(frame)
		}
	}
}

// broadcast sends frame to the other sockets of the page here and, through Redis, on the other
// instances (after the commit of what it carries).
func (h *syncHub) broadcast(ctx context.Context, page uuid.UUID, from *syncConn, frame []byte) {
	h.mu.Lock()
	if r := h.rooms[page]; r != nil {
		for c := range r.conns {
			if c != from {
				if frame[0] == ctlRecheck {
					c.recheckSoon()
				} else {
					c.enqueue(frame)
				}
			}
		}
	}
	h.mu.Unlock()
	msg := make([]byte, 16+len(frame))
	copy(msg, h.instance[:])
	copy(msg[16:], frame)
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := h.rc.Do(pctx, h.rc.B().Publish().Channel(channel(page)).Message(rueidis.BinaryString(msg)).Build()).Error(); err != nil {
		slog.Warn("wiki sync: publish", "page_id", page, "err", err)
	}
}

// kick makes every socket of the pages (on every instance) check its access now: after a
// trash, a change of overrides or of restricted.
func (s *Service) kick(ctx context.Context, pages []uuid.UUID) {
	if s.sync == nil {
		return
	}
	for _, p := range pages {
		s.sync.broadcast(ctx, p, nil, []byte{ctlRecheck})
	}
}

// recheck is kick of one page.
func (s *Service) recheck(ctx context.Context, page uuid.UUID) { s.kick(ctx, []uuid.UUID{page}) }

// shouldCheckCompact throttles the threshold query per page on this instance.
func (h *syncHub) shouldCheckCompact(page uuid.UUID) bool {
	if h.cfg.CompactCheckEvery < 0 {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[page]
	if r == nil {
		return false
	}
	now := time.Now()
	if now.Sub(r.lastCheck) < h.cfg.CompactCheckEvery {
		return false
	}
	r.lastCheck = now
	return true
}

// ---- per-person socket limit (Redis, across instances) ----

func connsKey(page, user uuid.UUID) string {
	return redisx.Key("wiki:conns:" + page.String() + ":" + user.String())
}

func (h *syncHub) connTTL() time.Duration { return h.cfg.IdleTimeout + h.cfg.PingInterval }

// claim registers socket c of its person on the page; false over MaxConnsPerUser.
func (h *syncHub) claim(ctx context.Context, c *syncConn) (bool, error) {
	key, now := connsKey(c.page, c.id.UserID), time.Now()
	exp := float64(now.Add(h.connTTL()).UnixMilli())
	res := h.rc.DoMulti(ctx,
		h.rc.B().Zremrangebyscore().Key(key).Min("-inf").Max(formatMs(now)).Build(),
		h.rc.B().Zadd().Key(key).ScoreMember().ScoreMember(exp, c.key).Build(),
		h.rc.B().Zcard().Key(key).Build(),
		h.rc.B().Pexpire().Key(key).Milliseconds(h.connTTL().Milliseconds()).Build())
	for _, r := range res {
		if err := r.Error(); err != nil {
			return false, err
		}
	}
	n, err := res[2].AsInt64()
	if err != nil {
		return false, err
	}
	if n > int64(h.cfg.MaxConnsPerUser) {
		h.release(c)
		return false, nil
	}
	return true, nil
}

// touch keeps the socket's registration alive (on every ping).
func (h *syncHub) touch(ctx context.Context, c *syncConn) {
	key := connsKey(c.page, c.id.UserID)
	exp := float64(time.Now().Add(h.connTTL()).UnixMilli())
	h.rc.DoMulti(ctx,
		h.rc.B().Zadd().Key(key).ScoreMember().ScoreMember(exp, c.key).Build(),
		h.rc.B().Pexpire().Key(key).Milliseconds(h.connTTL().Milliseconds()).Build())
}

func (h *syncHub) release(c *syncConn) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = h.rc.Do(ctx, h.rc.B().Zrem().Key(connsKey(c.page, c.id.UserID)).Member(c.key).Build()).Error()
}

func formatMs(t time.Time) string { return strconv.FormatInt(t.UnixMilli(), 10) }

// ---- one socket ----

// syncConn is one client socket on one page.
type syncConn struct {
	h      *syncHub
	ws     *websocket.Conn
	page   uuid.UUID
	wsID   uuid.UUID
	id     auth.Identity
	botTok string // a bot's token: rechecked by authenticating it again (no session row)
	key    string // the socket's member in the per-person set
	ctx    context.Context
	cancel context.CancelFunc

	write   atomic.Bool   // WIKI_WRITE and the policy allow writing
	out     chan []byte   // frames for the writer
	stale   atomic.Bool   // an update or snapshot was dropped (queue full): catch up from the DB
	kick    chan struct{} // wakes the writer after stale is set
	recheck chan struct{} // an access recheck was asked for (ctlRecheck)
	closed  sync.Once

	// The writer's position: the highest seq the client has (snapshot or update); -1 = nothing
	// sent yet. Writer goroutine only.
	lastSent int64

	// Inbound budgets (reader goroutine only).
	updates, awareness, snapshots bucket
}

// bucket is a token bucket.
type bucket struct {
	tokens, burst, rate float64
	last                time.Time
}

func newBucket(burst, perSecond float64) bucket {
	return bucket{tokens: burst, burst: burst, rate: perSecond, last: time.Now()}
}

func (b *bucket) take() bool {
	now := time.Now()
	b.tokens = min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// enqueue hands a frame to the writer without blocking. A full queue drops it: an awareness
// frame is just lost, a lost update or snapshot makes the writer catch up from the database.
func (c *syncConn) enqueue(frame []byte) {
	select {
	case c.out <- frame:
	default:
		if t := frame[0]; t == frameUpdate || t == frameSnapshot {
			c.markStale()
		}
	}
}

// markStale makes the writer catch up from the database.
func (c *syncConn) markStale() {
	c.stale.Store(true)
	select {
	case c.kick <- struct{}{}:
	default:
	}
}

func (c *syncConn) recheckSoon() {
	select {
	case c.recheck <- struct{}{}:
	default:
	}
}

// close ends the socket once with a close code.
func (c *syncConn) close(code int, reason string) {
	c.closed.Do(func() {
		// The close handshake first: cancelling the context of a pending Read or Write drops the
		// connection without a close frame.
		go func() {
			_ = c.ws.Close(websocket.StatusCode(code), reason) //nolint:gosec // close codes
			c.cancel()
		}()
	})
}

// serve: GET /api/wiki/pages/{id}/sync.
func (h *syncHub) serve(w http.ResponseWriter, r *http.Request) {
	if h.origin != nil && !h.origin(r.Header.Get("Origin"), r.Header.Get("Cookie") != "") {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	page, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpx.WriteError(w, r, httpx.NotFound("page"))
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin is checked above (gateway.OriginAllowed): Electron's file:// / "null" origins.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimitRO)
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	c := &syncConn{h: h, ws: ws, page: page, key: uuid.NewString(), ctx: ctx, cancel: cancel, lastSent: -1,
		out: make(chan []byte, 256), kick: make(chan struct{}, 1), recheck: make(chan struct{}, 1),
		updates:   newBucket(float64(h.cfg.UpdatesPerSecond), float64(h.cfg.UpdatesPerSecond)),
		awareness: newBucket(float64(h.cfg.AwarenessPerSecond), float64(h.cfg.AwarenessPerSecond)),
		snapshots: newBucket(2, 1/h.cfg.SnapshotEvery.Seconds())}
	defer c.close(1000, "")

	// In-band auth: the first message is a text frame with the access token.
	actx, acancel := context.WithTimeout(ctx, h.cfg.AuthTimeout)
	typ, tok, err := ws.Read(actx)
	acancel()
	if err != nil {
		c.close(closeTryAgain, "no token")
		return
	}
	if typ != websocket.MessageText {
		c.close(closeAuth, "token expected")
		return
	}
	token := strings.TrimSpace(string(tok))
	id, err := h.auth.AuthenticateToken(ctx, token)
	switch {
	case errors.Is(err, auth.ErrInvalidToken):
		c.close(closeAuth, "authentication failed")
		return
	case errors.Is(err, auth.ErrSessionRevoked):
		c.close(closeRevoked, "session revoked")
		return
	case err != nil:
		c.close(closeTryAgain, "try again")
		return
	}
	c.id = id
	if id.IsBot {
		c.botTok = token
	}
	if code, reason := c.authorize(); code != 0 {
		c.close(code, reason)
		return
	}
	if c.write.Load() {
		ws.SetReadLimit(readLimitRW)
	}
	ok, err := h.claim(ctx, c)
	if err != nil {
		c.close(closeTryAgain, "try again")
		return
	}
	if !ok {
		c.close(closeRate, "too many connections to the page")
		return
	}
	defer h.release(c)
	rm := h.join(c)
	defer h.leave(c)
	// Subscribed first, then the snapshot read (catch-up), duplicates dropped by seq.
	wait := time.NewTimer(h.cfg.SubscribeTimeout)
	select {
	case <-rm.ready:
		wait.Stop()
	case <-wait.C:
		c.close(closeTryAgain, "try again")
		return
	case <-ctx.Done():
		wait.Stop()
		return
	}
	c.markStale() // the first catch-up: SNAPSHOT + UPDATEs (lastSent -1)
	go c.writeLoop()
	go c.pingLoop()
	c.readLoop()
}

// authorize resolves the caller's access to the page (as at connect, and on every recheck):
// 0 = allowed (write set), else the close code. A fresh permission resolver every time.
func (c *syncConn) authorize() (int, string) {
	h := c.h
	ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
	defer cancel()
	q := h.s.db.Q
	ctx = h.auth.WithPolicy(ctx, c.id, identitypolicy.WorkspaceRead)
	ctx = perm.WithResolver(ctx, q)
	ch, err := wikiacl.Load(ctx, q, []uuid.UUID{c.page})
	if err != nil {
		return closeTryAgain, "try again"
	}
	if !ch.Has(c.page) {
		return closeNotFound, "no such page"
	}
	p := ch.Page(c.page)
	if p.TrashedAt != nil {
		return closeNotFound, "the page is in the trash"
	}
	m, err := perm.FromContext(ctx).Member(ctx, p.WorkspaceID, c.id.UserID)
	switch {
	case errors.Is(err, perm.ErrNotMember):
		return closeForbidden, "no access"
	case isRefusal(err):
		return closeForbidden, "access policy"
	case err != nil:
		return closeTryAgain, "try again"
	}
	if err := h.auth.CheckWorkspace(ctx, c.id, p.WorkspaceID, identitypolicy.WorkspaceRead); err != nil {
		if isRefusal(err) {
			return closeForbidden, "access policy"
		}
		return closeTryAgain, "try again"
	}
	bits := ch.Bits(m, &c.page)
	if !bits.Has(perm.WikiView) {
		return closeForbidden, "no access"
	}
	c.wsID = p.WorkspaceID
	write := bits.Has(perm.WikiWrite) &&
		h.auth.CheckWorkspace(ctx, c.id, p.WorkspaceID, identitypolicy.WorkspaceWrite) == nil &&
		writable(ctx, q, p.WorkspaceID) == nil
	c.write.Store(write)
	return 0, ""
}

// pingLoop pings the client (idle close), keeps the per-person registration alive and rechecks
// the session and the access every RecheckInterval or when asked.
func (c *syncConn) pingLoop() {
	h := c.h
	ping := time.NewTicker(h.cfg.PingInterval)
	defer ping.Stop()
	recheck := time.NewTicker(h.cfg.RecheckInterval)
	defer recheck.Stop()
	check := func() bool {
		sctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
		var err error
		if c.botTok != "" {
			// A bot token has no session row: a replaced or revoked token fails again here.
			_, err = h.auth.AuthenticateToken(sctx, c.botTok)
			if errors.Is(err, auth.ErrInvalidToken) {
				err = auth.ErrSessionRevoked
			}
		} else {
			err = h.auth.CheckSession(sctx, c.id.SessionID)
		}
		cancel()
		if errors.Is(err, auth.ErrSessionRevoked) {
			c.close(closeRevoked, "session revoked")
			return false
		}
		if code, reason := c.authorize(); code != 0 && code != closeTryAgain {
			c.close(code, reason)
			return false
		}
		return true
	}
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ping.C:
			pctx, cancel := context.WithTimeout(c.ctx, max(h.cfg.IdleTimeout-h.cfg.PingInterval, time.Second))
			err := c.ws.Ping(pctx)
			cancel()
			if err != nil {
				c.close(closeIdle, "idle")
				return
			}
			h.touch(c.ctx, c)
		case <-recheck.C:
			if !check() {
				return
			}
		case <-c.recheck:
			if !check() {
				return
			}
		}
	}
}

// writeLoop sends the queued frames in order. Updates carry contiguous seqs per page: one at or
// below what the client has is skipped, a gap (a frame lost in Redis, or published before this
// socket subscribed) is filled from the database first.
func (c *syncConn) writeLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case f := <-c.out:
			if !c.handle(f) {
				return
			}
		case <-c.kick:
		}
		if c.stale.Swap(false) && !c.catchUp() {
			return
		}
	}
}

func (c *syncConn) handle(f []byte) bool {
	switch f[0] {
	case frameUpdate:
		seq := frameSeq(f)
		if seq <= c.lastSent {
			return true
		}
		if seq > c.lastSent+1 {
			if !c.catchUp() {
				return false
			}
			if seq <= c.lastSent {
				return true
			}
		}
		c.lastSent = seq
	case frameSnapshot:
		c.lastSent = max(c.lastSent, frameSeq(f))
	}
	return c.send(f)
}

// catchUp sends what the client lacks: the snapshot when it is newer than what was sent (or on
// the first call), then the stored updates after it, read in one repeatable-read transaction so
// that a compaction in between loses nothing.
func (c *syncConn) catchUp() bool {
	var frames [][]byte
	last := c.lastSent
	err := c.h.s.db.ReadTx(c.ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(c.ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"); err != nil {
			return err
		}
		q := c.h.s.db.Q.WithTx(tx)
		seq, err := snapshotSeq(c.ctx, q, c.page)
		if err != nil {
			return err
		}
		if last < 0 || seq > last {
			through, state, err := loadSnapshot(c.ctx, q, c.page)
			if err != nil {
				return err
			}
			frames = append(frames, snapshotFrame(through, state))
			last = through
		}
		return eachUpdate(c.ctx, q, c.page, last, func(seq int64, data []byte) error {
			frames = append(frames, updateFrame(seq, data))
			last = seq
			return nil
		})
	})
	if err != nil {
		if c.ctx.Err() == nil {
			slog.Warn("wiki sync: catch-up", "page_id", c.page, "err", err)
			c.close(closeTryAgain, "try again")
		}
		return false
	}
	for _, f := range frames {
		if !c.send(f) {
			return false
		}
	}
	c.lastSent = last
	return true
}

func (c *syncConn) send(f []byte) bool {
	ctx, cancel := context.WithTimeout(c.ctx, c.h.cfg.WriteTimeout)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageBinary, f); err != nil {
		c.close(closeTryAgain, "write failed")
		return false
	}
	return true
}

// readLoop handles the client's frames until the socket ends.
func (c *syncConn) readLoop() {
	for {
		typ, b, err := c.ws.Read(c.ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(b) == 0 {
			c.close(closeBadFrame, "binary frames expected")
			return
		}
		var ok bool
		switch b[0] {
		case frameUpdate:
			ok = c.onUpdate(b)
		case frameAwareness:
			ok = c.onAwareness(b)
		case frameSnapshotPost:
			ok = c.onSnapshot(b)
		default:
			c.close(closeBadFrame, "unexpected frame")
			return
		}
		if !ok {
			return
		}
	}
}

// onUpdate stores one Yjs update under the page's next seq, echoes it to the sender with that
// seq and relays it to every other socket of the page.
func (c *syncConn) onUpdate(b []byte) bool {
	if !c.write.Load() {
		c.close(closeForbidden, "read only")
		return false
	}
	if len(b) <= headerSeq || len(b)-headerSeq > MaxUpdate {
		c.close(closeBadFrame, "bad update")
		return false
	}
	if !c.updates.take() {
		c.close(closeRate, "rate limited")
		return false
	}
	data := bytes.Clone(b[headerSeq:])
	row, err := db.GuardValue(c.ctx, c.h.s.db, func(q *sqlc.Queries) (sqlc.AppendWikiUpdateRow, error) {
		return q.AppendWikiUpdate(c.ctx, sqlc.AppendWikiUpdateParams{PageID: c.page, Data: data, AuthorID: &c.id.UserID})
	})
	if db.IsNotFound(err) {
		c.close(closeNotFound, "the page is gone or in the trash")
		return false
	}
	if err != nil {
		if c.ctx.Err() == nil {
			slog.Warn("wiki sync: append", "page_id", c.page, "err", err)
			c.close(closeTryAgain, "try again")
		}
		return false
	}
	f := updateFrame(row.Seq, data)
	c.enqueue(f)
	c.h.broadcast(c.ctx, c.page, c, f)
	c.maybeCompact()
	return true
}

// maybeCompact asks the sender for a snapshot when the updates after the stored one exceed the
// thresholds, at most once per CompactCooldown per page across instances.
func (c *syncConn) maybeCompact() {
	h := c.h
	if !h.shouldCheckCompact(c.page) {
		return
	}
	q := h.s.db.Q
	seq, err := snapshotSeq(c.ctx, q, c.page)
	if err != nil {
		return
	}
	st, err := q.WikiUpdatesSince(c.ctx, sqlc.WikiUpdatesSinceParams{PageID: c.page, AfterSeq: seq})
	if err != nil || (st.Updates <= int32(h.cfg.CompactUpdates) && st.Bytes <= h.cfg.CompactBytes) { //nolint:gosec // small config
		return
	}
	set, err := h.rc.Do(c.ctx, h.rc.B().Set().Key(redisx.Key("wiki:compact:"+c.page.String())).Value("1").Nx().
		Px(h.cfg.CompactCooldown).Build()).AsBool()
	if err != nil && !rueidis.IsRedisNil(err) {
		return
	}
	if set {
		c.enqueue([]byte{frameCompact})
	}
}

// onAwareness relays a cursor / presence update to the other sockets of the page (never
// stored). Read-only sockets and frames over the budget are dropped.
func (c *syncConn) onAwareness(b []byte) bool {
	if !c.write.Load() || len(b) > 1+MaxUpdate || !c.awareness.take() {
		return true
	}
	c.h.broadcast(c.ctx, c.page, c, bytes.Clone(b))
	return true
}

// snapshotMeta is the JSON of a SNAPSHOT_POST.
type snapshotMeta struct {
	PlainText string `json:"plain_text"`
	Title     string `json:"title"`
	Preview   string `json:"preview"`
	// Broadcast: the state holds an edit no UPDATE carried (a transaction too big for a frame):
	// the other sockets of the page get it as a SNAPSHOT. Otherwise the post is a silent
	// compaction.
	Broadcast bool `json:"broadcast,omitempty"`
}

// onSnapshot stores a snapshot (ADR-0096 §4): in one transaction it checks through_seq against
// the stored snapshot and the page's counter, saves it, drops the updates it contains, updates
// the page's text, preview, size and (a non-empty title) title, and writes a version when due.
// Nothing is sent back. With meta.broadcast (changes no update carried: a transaction too big
// for one frame) the other sockets of the page get the state as a SNAPSHOT; a stale one (through
// below the stored snapshot, or past the counter) is not stored but still relayed, with through
// 0 so that no socket's position moves, and the poster is asked for a fresh snapshot.
func (c *syncConn) onSnapshot(b []byte) bool {
	if !c.write.Load() {
		c.close(closeForbidden, "read only")
		return false
	}
	if !c.snapshots.take() {
		c.close(closeRate, "rate limited")
		return false
	}
	if len(b) < headerPost {
		c.close(closeBadFrame, "bad snapshot")
		return false
	}
	through := frameSeq(b)
	mlen := int(binary.BigEndian.Uint32(b[9:13]))
	if mlen > MaxMeta || headerPost+mlen > len(b) {
		c.close(closeBadFrame, "bad snapshot")
		return false
	}
	var meta snapshotMeta
	if err := json.Unmarshal(b[headerPost:headerPost+mlen], &meta); err != nil {
		c.close(closeBadFrame, "bad snapshot meta")
		return false
	}
	state := bytes.Clone(b[headerPost+mlen:])
	if len(state) == 0 || len(state) > MaxState {
		return true // the client warns about a document over 2 MiB; nothing is stored
	}
	s, uid := c.h.s, c.id.UserID
	text := clipBytes(meta.PlainText, MaxText)
	preview := clip(strings.Join(strings.Fields(meta.Preview), " "), 200)
	title := clip(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, strings.TrimSpace(meta.Title)), MaxTitle)
	stored, renamed := false, false
	err := s.db.Tx(c.ctx, func(q *sqlc.Queries) error {
		cur, err := q.GetWikiPageForUpdate(c.ctx, c.page)
		if db.IsNotFound(err) {
			return errNoPage
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt != nil {
			return errNoPage
		}
		prev, err := snapshotSeq(c.ctx, q, c.page)
		if err != nil {
			return err
		}
		if through < prev || through > cur.NextSeq-1 {
			return nil // stale (or ahead of the counter): ignored
		}
		since, err := q.WikiUpdatesSince(c.ctx, sqlc.WikiUpdatesSinceParams{PageID: c.page, AfterSeq: prev})
		if err != nil {
			return err
		}
		n, err := q.UpsertWikiSnapshot(c.ctx, sqlc.UpsertWikiSnapshotParams{PageID: c.page, State: state, ThroughSeq: through, SavedBy: &uid})
		if err != nil || n == 0 {
			return err
		}
		if _, err := q.DeleteWikiUpdatesThrough(c.ctx, sqlc.DeleteWikiUpdatesThroughParams{PageID: c.page, ThroughSeq: through}); err != nil {
			return err
		}
		row, err := q.SetWikiPageContent(c.ctx, sqlc.SetWikiPageContentParams{ID: c.page, PlainText: text, Preview: preview,
			DocSize: int32(len(state)), UpdatedBy: &uid}) //nolint:gosec // ≤ MaxState
		if err != nil {
			return err
		}
		pg := head(row)
		if title != "" && title != pg.Title {
			old := pg.Title
			if row, err = q.UpdateWikiPage(c.ctx, sqlc.UpdateWikiPageParams{ID: c.page, Title: &title, UpdatedBy: &uid}); err != nil {
				return err
			}
			pg, renamed = head(row), true
			if err := s.journal(c.ctx, q, pg, &uid, "rename", snap{"title": old}, snap{"title": pg.Title}); err != nil {
				return err
			}
		}
		stored = true
		return c.version(q, pg, state, text, since.Authors)
	})
	if err != nil {
		if errors.Is(err, errNoPage) {
			c.close(closeNotFound, "the page is gone or in the trash")
		} else if c.ctx.Err() == nil {
			slog.Warn("wiki sync: snapshot", "page_id", c.page, "err", err)
			c.close(closeTryAgain, "try again")
		}
		return false
	}
	switch {
	case stored && meta.Broadcast:
		c.h.broadcast(c.ctx, c.page, c, snapshotFrame(through, state))
	case !stored && meta.Broadcast:
		c.h.broadcast(c.ctx, c.page, c, snapshotFrame(0, state))
		c.enqueue([]byte{frameCompact})
	}
	if renamed {
		s.upserted(c.ctx, c.page, nil)
	}
	return true
}

// version writes a version of the page when due (ADR-0096 §1): at most one per VersionEvery,
// only when the text or the title changed since the last one; then thins the history.
func (c *syncConn) version(q *sqlc.Queries, pg sqlc.WikiPageHead, state []byte, text string, authors []uuid.UUID) error {
	s, now := c.h.s, c.h.s.Now()
	last, err := q.LastWikiVersion(c.ctx, c.page)
	switch {
	case db.IsNotFound(err):
		if text == "" && pg.Title == "" {
			return nil
		}
	case err != nil:
		return err
	default:
		if now.Sub(last.CreatedAt) < c.h.cfg.VersionEvery || (last.PlainText == text && last.Title == pg.Title) {
			return nil
		}
	}
	uid := c.id.UserID
	if !containsID(authors, uid) {
		authors = append(authors, uid)
	}
	v, err := q.InsertWikiVersion(c.ctx, sqlc.InsertWikiVersionParams{PageID: c.page, State: state, PlainText: text, Title: pg.Title, Authors: authors})
	if err != nil {
		return err
	}
	if err := s.journal(c.ctx, q, pg, &uid, "version", nil, snap{"version_id": v.ID.String(), "size": float64(v.Size)}); err != nil {
		return err
	}
	_, err = q.PruneWikiVersions(c.ctx, sqlc.PruneWikiVersionsParams{PageID: c.page, Now: now})
	return err
}

func containsID(ids []uuid.UUID, id uuid.UUID) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// isRefusal reports an API refusal (an identity policy, a suspension), not a dependency failure.
func isRefusal(err error) bool {
	var e *httpx.Error
	return errors.As(err, &e) && e.Err == nil
}
