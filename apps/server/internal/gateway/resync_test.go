package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func voiceEv(wid, uid, rid uuid.UUID) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_VoiceStateUpdate{VoiceStateUpdate: &v1.VoiceStateUpdate{
		State: &v1.VoiceState{WorkspaceId: wid.String(), UserId: uid.String(), RoomId: rid.String()},
	}}}
}

func stateTestHub(t *testing.T, wid uuid.UUID) (*Hub, *Session) {
	h := New(Config{}, nil, nil, nil, nil)
	s := testSession()
	s.hub = h
	s.ready = true
	s.conn = liveConn(t)
	h.register(s, []uuid.UUID{wid})
	return h, s
}

// liveConn is the server side of a real WebSocket (closing it needs one).
func liveConn(t *testing.T) *conn {
	t.Helper()
	got := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		got <- ws
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.CloseNow() })
	return newConn(<-got, codec{})
}

func closed(c *conn) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// A workspace state that failed to load (Postgres stall) is not kept: it used to stay EMPTY
// — no rooms, no members — and every VOICE_STATE_UPDATE reached this instance's sessions as
// "not in voice" for as long as they stayed connected. Now it is dropped and the sessions
// resync.
func TestFailedStateLoadIsDroppedAndSessionsResync(t *testing.T) {
	wid := uuid.New()
	h, s := stateTestHub(t, wid)
	st, created := h.placeholder(wid)
	if !created {
		t.Fatal("placeholder not created")
	}
	h.routeWorkspace(wid, uuid.New(), voiceEv(wid, uuid.New(), uuid.New())) // into the backlog
	h.stateFailed(st, wid)
	if h.state(wid) != nil {
		t.Fatal("failed workspace state kept")
	}
	if !s.broken.Load() || !closed(s.conn) {
		t.Fatal("session not made to resync")
	}
	if len(st.backlog) != 0 || st.loading {
		t.Fatal("failed state kept its backlog / loading flag")
	}
	// The next IDENTIFY loads it again.
	if _, created := h.placeholder(wid); !created {
		t.Fatal("no fresh load after a failure")
	}
}

// Events beyond the loading backlog are lost for the workspace's sessions: they resync
// rather than stay connected without them.
func TestLoadingBacklogOverflowResyncs(t *testing.T) {
	wid := uuid.New()
	h, s := stateTestHub(t, wid)
	st, _ := h.placeholder(wid)
	for range bufferQueue {
		h.routeWorkspace(wid, uuid.New(), voiceEv(wid, uuid.New(), uuid.New()))
	}
	if s.broken.Load() {
		t.Fatal("resync before the backlog was full")
	}
	h.routeWorkspace(wid, uuid.New(), voiceEv(wid, uuid.New(), uuid.New()))
	if !s.broken.Load() || !closed(s.conn) {
		t.Fatal("overflow dropped an event without a resync")
	}
	if len(st.backlog) != bufferQueue {
		t.Fatalf("backlog = %d", len(st.backlog))
	}
}

// Prepared events that do not fit the pending queue are dropped: the session resyncs.
func TestResumeManyOverflowResyncs(t *testing.T) {
	s := testSession()
	s.ready = true
	s.conn = liveConn(t)
	m := s.pause()
	evs := make([]pendingEvent, bufferQueue+1)
	for i := range evs {
		evs[i] = pendingEvent{id: uuid.New(), enc: newEnc(roomEv(i))}
	}
	s.resumeMany(m, evs)
	if !s.broken.Load() || !closed(s.conn) {
		t.Fatal("dropped prepared events without a resync")
	}
}
