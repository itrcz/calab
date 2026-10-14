//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lkjson "github.com/livekit/protocol/utils/protojson"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/rtc"
)

// The official livekit/protocol library is used here only as a compatibility oracle for our
// minimal client: it verifies our join tokens and signs/serializes webhooks like LiveKit does.

// recordingLiveKit wraps the real client and records server-side mutes.
type recordingLiveKit struct {
	rtc.LiveKit
	mu       sync.Mutex
	muted    []string
	moves    []string
	removed  []string
	deleted  []string                  // DeleteRoom calls (room names)
	fakeMove bool                      // pretend MoveParticipant succeeded (no real WebRTC participant in tests)
	perms    map[string]rtc.Permission // last permission sent per identity
	// afterCreateRoom, if set, runs once after a successful CreateRoom (e.g. to cancel the
	// request that caused it at a precise point).
	afterCreateRoom func()
}

func (r *recordingLiveKit) CreateRoom(ctx context.Context, name string, emptyTimeout, maxParticipants uint32) error {
	err := r.LiveKit.CreateRoom(ctx, name, emptyTimeout, maxParticipants)
	r.mu.Lock()
	hook := r.afterCreateRoom
	r.afterCreateRoom = nil
	r.mu.Unlock()
	if err == nil && hook != nil {
		hook()
	}
	return err
}

func (r *recordingLiveKit) DeleteRoom(ctx context.Context, name string) error {
	r.mu.Lock()
	r.deleted = append(r.deleted, name)
	r.mu.Unlock()
	return r.LiveKit.DeleteRoom(ctx, name)
}

func (r *recordingLiveKit) wasDeleted(name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Contains(r.deleted, name)
}

func (r *recordingLiveKit) lastPerm(identity string) (rtc.Permission, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.perms[identity]
	return p, ok
}

func (r *recordingLiveKit) MoveParticipant(ctx context.Context, room, identity, dst string) error {
	r.mu.Lock()
	r.moves = append(r.moves, identity+"→"+dst)
	fake := r.fakeMove
	r.mu.Unlock()
	if fake {
		return nil
	}
	return r.LiveKit.MoveParticipant(ctx, room, identity, dst)
}

func (r *recordingLiveKit) UpdatePermission(ctx context.Context, room, identity string, p rtc.Permission) error {
	r.mu.Lock()
	if r.perms == nil {
		r.perms = map[string]rtc.Permission{}
	}
	r.perms[identity] = p
	fake := r.fakeMove
	r.mu.Unlock()
	if fake {
		return nil
	}
	return r.LiveKit.UpdatePermission(ctx, room, identity, p)
}

func (r *recordingLiveKit) MuteTrack(ctx context.Context, room, identity, sid string, muted bool) error {
	r.mu.Lock()
	r.muted = append(r.muted, identity+"/"+sid)
	r.mu.Unlock()
	return r.LiveKit.MuteTrack(ctx, room, identity, sid, muted)
}

func (r *recordingLiveKit) RemoveParticipant(ctx context.Context, room, identity string) error {
	r.mu.Lock()
	r.removed = append(r.removed, identity)
	r.mu.Unlock()
	return r.LiveKit.RemoveParticipant(ctx, room, identity)
}

func (r *recordingLiveKit) wasRemoved(identity string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, id := range r.removed {
		if id == identity {
			return true
		}
	}
	return false
}

func (r *recordingLiveKit) mutedTracks() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.muted...)
}

// ---- gateway client (JSON encoding) ----

type gwMsg struct {
	b   []byte
	err error
}

// gw reads in a background goroutine: in coder/websocket a Read whose context expires
// closes the connection, so per-read timeouts are implemented on the channel instead.
type gw struct {
	t    *testing.T
	ws   *websocket.Conn
	in   chan gwMsg
	last uint64
}

func dialGW(t *testing.T) *gw {
	t.Helper()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/gateway?v=1&encoding=json"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, u, nil) //nolint:bodyclose // websocket
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(16 << 20) // READY grows with the owner's many test workspaces
	g := &gw{t: t, ws: ws, in: make(chan gwMsg, 1024)}
	go func() {
		for {
			_, b, err := ws.Read(context.Background())
			g.in <- gwMsg{b, err}
			if err != nil {
				return
			}
		}
	}()
	if f := g.next(); f.GetHello().GetHeartbeatIntervalMs() != 41000 {
		t.Fatalf("expected HELLO, got %v", f)
	}
	return g
}

func (g *gw) send(f *v1.GatewayFrame) {
	g.t.Helper()
	b, err := protojson.Marshal(f)
	if err != nil {
		g.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := g.ws.Write(ctx, websocket.MessageText, b); err != nil {
		g.t.Fatal(err)
	}
}

var errNoFrame = fmt.Errorf("no frame")

func (g *gw) read(timeout time.Duration) (*v1.GatewayFrame, error) {
	var b []byte
	select {
	case m := <-g.in:
		if m.err != nil {
			g.in <- m // keep reporting the terminal error
			return nil, m.err
		}
		b = m.b
	case <-time.After(timeout):
		return nil, errNoFrame
	}
	f := &v1.GatewayFrame{}
	if err := protojson.Unmarshal(b, f); err != nil {
		return nil, err
	}
	if f.GetSeq() != 0 {
		if f.GetSeq() <= g.last {
			return nil, fmt.Errorf("seq went backwards: %d after %d", f.GetSeq(), g.last)
		}
		g.last = f.GetSeq()
	}
	return f, nil
}

func (g *gw) next() *v1.GatewayFrame {
	g.t.Helper()
	f, err := g.read(5 * time.Second)
	if err != nil {
		g.t.Fatal(err)
	}
	return f
}

// wait reads frames until pred matches a DISPATCH event.
func (g *gw) wait(what string, pred func(*v1.DispatchEvent) bool) *v1.DispatchEvent {
	g.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := g.read(time.Until(deadline))
		if err != nil {
			g.t.Fatalf("waiting for %s: %v", what, err)
		}
		if d := f.GetDispatch(); d != nil && pred(d) {
			return d
		}
	}
	g.t.Fatalf("timeout waiting for %s", what)
	return nil
}

// waitFrame reads until pred matches any frame.
func (g *gw) waitFrame(what string, pred func(*v1.GatewayFrame) bool) *v1.GatewayFrame {
	g.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := g.read(time.Until(deadline))
		if err != nil {
			g.t.Fatalf("waiting for %s: %v", what, err)
		}
		if pred(f) {
			return f
		}
	}
	g.t.Fatalf("timeout waiting for %s", what)
	return nil
}

// quiet asserts that no matching event arrives within d.
func (g *gw) quiet(what string, d time.Duration, pred func(*v1.DispatchEvent) bool) {
	g.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := g.read(time.Until(deadline))
		if err != nil {
			return
		}
		if ev := f.GetDispatch(); ev != nil && pred(ev) {
			g.t.Fatalf("unexpected %s: %v", what, ev)
		}
	}
}

func (g *gw) identify(token string) *v1.Ready {
	g.t.Helper()
	g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY, Payload: &v1.GatewayFrame_Identify{Identify: &v1.Identify{Token: token}}})
	return g.wait("READY", func(e *v1.DispatchEvent) bool { return e.GetReady() != nil }).GetReady()
}

func (g *gw) closeStatus() websocket.StatusCode {
	st, _ := g.closeFrame()
	return st
}

// closeFrame reads until the socket closes; returns the close status and reason.
func (g *gw) closeFrame() (websocket.StatusCode, string) {
	for {
		if _, err := g.read(5 * time.Second); err != nil {
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				return ce.Code, ce.Reason
			}
			return websocket.CloseStatus(err), ""
		}
	}
}

func setupTeam(t *testing.T) (o, bob *user, ws *v1.Workspace, room *v1.Room) {
	t.Helper()
	o = owner(t)
	ws = createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	bob = register(t, invite(t, o, ws.GetId()))
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "voice"}, &cr)
	return o, bob, ws, cr.GetRoom()
}

func send(t *testing.T, u *user, roomID, text, nonce string) *v1.Message {
	t.Helper()
	var r v1.CreateMessageResponse
	u.must(201, "POST", "/api/rooms/"+roomID+"/messages", &v1.CreateMessageRequest{Content: text, Nonce: nonce}, &r)
	return r.GetMessage()
}

func TestGatewayFlow(t *testing.T) {
	o, bob, ws, room := setupTeam(t)

	// Frames before IDENTIFY are rejected with 4003.
	g0 := dialGW(t)
	g0.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_TYPING, Payload: &v1.GatewayFrame_Typing{Typing: &v1.Typing{RoomId: room.GetId()}}})
	if st := g0.closeStatus(); st != 4003 {
		t.Fatalf("typing before identify: close %d, want 4003", st)
	}
	// Bad token: 4004.
	g0 = dialGW(t)
	g0.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY, Payload: &v1.GatewayFrame_Identify{Identify: &v1.Identify{Token: "nope"}}})
	if st := g0.closeStatus(); st != 4004 {
		t.Fatalf("bad token: close %d, want 4004", st)
	}

	g := dialGW(t)
	ready := g.identify(bob.token)
	if g.last != 1 || ready.GetMe().GetUser().GetId() != bob.id || ready.GetSessionId() == "" {
		t.Fatalf("READY: seq %d, %v", g.last, ready.GetMe())
	}
	var snap *v1.WorkspaceSnapshot
	for _, s := range ready.GetWorkspaces() {
		if s.GetWorkspace().GetId() == ws.GetId() {
			snap = s
		}
	}
	if snap == nil || len(snap.GetRooms()) != 1 || snap.GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER ||
		snap.GetPermissions()[room.GetId()] != 8798327|3<<35|3<<38 /* member defaults with the board bits (ADR-0042), CREATE_TEMP_ROOMS (ADR-0044), DISK_VIEW | DISK_WRITE (ADR-0094) and WIKI_VIEW | WIKI_WRITE (ADR-0096) */ || len(snap.GetMembers()) != 2 || snap.GetRooms()[0].GetMedia().GetMaxStreams() != 3 {
		t.Fatalf("snapshot: %v", snap)
	}
	online := false
	for _, p := range snap.GetPresences() {
		online = online || (p.GetUserId() == bob.id && p.GetStatus() == v1.PresenceStatus_PRESENCE_STATUS_ONLINE)
	}
	if !online {
		t.Fatalf("own presence not online in READY: %v", snap.GetPresences())
	}

	// Heartbeat.
	g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT, Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{LastSeq: g.last}}})
	g.waitFrame("HEARTBEAT_ACK", func(f *v1.GatewayFrame) bool { return f.GetHeartbeatAck() != nil })

	// REST mutation → event.
	m1 := send(t, o, room.GetId(), "hello bob", "")
	g.wait("MESSAGE_CREATE", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == m1.GetId() })

	// A private room is invisible to bob until he is allowed in; then it appears.
	var priv v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "secret", IsPrivate: true}, &priv)
	pid := priv.GetRoom().GetId()
	sm := send(t, o, pid, "secret stuff", "")
	g.quiet("private room leak", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetRoomCreate().GetRoom().GetId() == pid || e.GetMessageCreate().GetMessage().GetId() == sm.GetId()
	})
	o.must(200, "PUT", "/api/rooms/"+pid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: 1},
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: 1},
	}}, nil)
	g.wait("ROOM_CREATE on gained access", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == pid })
	o.must(200, "PUT", "/api/rooms/"+pid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "member", Deny: 1},
	}}, nil)
	g.wait("ROOM_DELETE on lost access", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == pid })

	// Typing reaches subscribed sessions only, and not the typer.
	og := dialGW(t)
	og.identify(o.token)
	g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_SUBSCRIBE, Payload: &v1.GatewayFrame_Subscribe{Subscribe: &v1.Subscribe{RoomIds: []string{room.GetId()}}}})
	time.Sleep(100 * time.Millisecond)
	og.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_TYPING, Payload: &v1.GatewayFrame_Typing{Typing: &v1.Typing{RoomId: room.GetId()}}})
	g.wait("TYPING_START", func(e *v1.DispatchEvent) bool { return e.GetTypingStart().GetUserId() == o.id })

	// Presence: owner goes DND.
	og.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_PRESENCE_UPDATE, Payload: &v1.GatewayFrame_SetPresence{SetPresence: &v1.SetPresence{Status: v1.PresenceStatus_PRESENCE_STATUS_DND}}})
	g.wait("PRESENCE_UPDATE dnd", func(e *v1.DispatchEvent) bool {
		p := e.GetPresenceUpdate().GetPresence()
		return p.GetUserId() == o.id && p.GetStatus() == v1.PresenceStatus_PRESENCE_STATUS_DND
	})

	// Connection drop → events while away → RESUME replays them in order.
	lastSeq := g.last
	_ = g.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	m2 := send(t, o, room.GetId(), "while you were away 1", "")
	m3 := send(t, o, room.GetId(), "while you were away 2", "")
	time.Sleep(150 * time.Millisecond)
	g2 := dialGW(t)
	g2.last = lastSeq
	g2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: bob.token, SessionId: ready.GetSessionId(), Seq: lastSeq}}})
	var got []string
	res := g2.wait("RESUMED", func(e *v1.DispatchEvent) bool {
		if mc := e.GetMessageCreate(); mc != nil {
			got = append(got, mc.GetMessage().GetId())
		}
		return e.GetResumed() != nil
	})
	if len(got) != 2 || got[0] != m2.GetId() || got[1] != m3.GetId() || res.GetResumed().GetReplayed() < 2 {
		t.Fatalf("replay: got %v (replayed %d), want [%s %s]", got, res.GetResumed().GetReplayed(), m2.GetId(), m3.GetId())
	}
	m4 := send(t, o, room.GetId(), "live again", "")
	g2.wait("live event after RESUME", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == m4.GetId() })

	// RESUME with an unknown session → INVALID_SESSION, then IDENTIFY on the same socket works.
	g3 := dialGW(t)
	g3.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: o.token, SessionId: "01890000-0000-7000-8000-000000000000", Seq: 3}}})
	inv := g3.waitFrame("INVALID_SESSION", func(f *v1.GatewayFrame) bool { return f.GetInvalidSession() != nil })
	if inv.GetInvalidSession().GetResumable() {
		t.Fatal("unknown session must not be resumable")
	}
	g3.identify(o.token) // same device as og: replaces og's session
	if st := og.closeStatus(); st != 4000 {
		t.Fatalf("replaced session: close %d, want 4000", st)
	}

	// Logout revokes the session: its socket is closed with 4010 and the reason.
	bob.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{}, nil)
	if st, reason := g2.closeFrame(); st != 4010 || reason != "session revoked: LOGOUT" {
		t.Fatalf("revoked session: close %d %q, want 4010 \"session revoked: LOGOUT\"", st, reason)
	}
}

func TestGatewayDeviceLimit(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, ws.GetId())) // fresh user: its registration session is device #1
	email := mustEmail(t, u)
	first := dialGW(t)
	first.identify(u.token)
	conns := []*gw{first}
	for i := range 5 {
		c := &client{t: t, ip: fmt.Sprintf("10.50.0.%d", i+1)}
		var l v1.LoginResponse
		c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, &l)
		g := dialGW(t)
		if i < 4 { // devices #2..#5
			g.identify(l.GetTokens().GetAccessToken())
			conns = append(conns, g)
			continue
		}
		g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY, Payload: &v1.GatewayFrame_Identify{Identify: &v1.Identify{Token: l.GetTokens().GetAccessToken()}}})
		f, err := g.read(5 * time.Second)
		if err == nil {
			t.Fatalf("6th device got a frame: %v", f)
		}
		if st := websocket.CloseStatus(err); st != 4008 {
			t.Fatalf("6th device: close %d, want 4008", st)
		}
	}
	for _, c := range conns {
		_ = c.ws.Close(websocket.StatusNormalClosure, "")
	}
}

// ---- messages + files ----

func pngBytes(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{uint8(x * 7), uint8(y * 3), 200, 255}) //nolint:gosec // pattern
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

func upload(t *testing.T, u *user, path, name string, data []byte) (int, *v1.FileMeta, *v1.Me) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+path, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+u.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		var e v1.ApiError
		_ = protojson.Unmarshal(raw, &e)
		t.Logf("upload %s -> %d %s", name, resp.StatusCode, raw)
		return resp.StatusCode, nil, nil
	}
	if strings.HasSuffix(path, "/avatar") {
		var r v1.UpdateMeResponse
		_ = protojson.Unmarshal(raw, &r)
		return resp.StatusCode, nil, r.GetMe()
	}
	var r v1.UploadFileResponse
	if err := protojson.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, r.GetFile(), nil
}

type getResult struct {
	StatusCode int
	Header     http.Header
}

func get(t *testing.T, u *user, path string, hdr map[string]string) (getResult, []byte) {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), "GET", srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+u.token)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return getResult{StatusCode: resp.StatusCode, Header: resp.Header}, b
}

func TestMessagesAndFiles(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()

	// Upload an image: sha256, dimensions, WebP thumbnail.
	img := pngBytes(1200, 600)
	st, f, _ := upload(t, bob, "/api/workspaces/"+ws.GetId()+"/files", "shot.png", img)
	if st != 201 || f.GetMime() != "image/png" || f.GetWidth() != 1200 || f.GetHeight() != 600 || f.GetThumbnailUrl() == "" ||
		f.GetSize() != uint64(len(img)) || f.GetSha256() != fmt.Sprintf("%x", sha256.Sum256(img)) {
		t.Fatalf("upload: %d %v", st, f)
	}
	// Size limit (MAX_FILE_SIZE_MB=1 in tests).
	if st, _, _ := upload(t, bob, "/api/workspaces/"+ws.GetId()+"/files", "big.bin", bytes.Repeat([]byte("x"), 1<<20+10)); st != 413 {
		t.Fatalf("oversize upload: %d, want 413", st)
	}

	// Message with attachment + nonce; retry is idempotent.
	var cm v1.CreateMessageResponse
	req := &v1.CreateMessageRequest{Content: "look", AttachmentIds: []string{f.GetId()}, Nonce: "n-1"}
	bob.must(201, "POST", "/api/rooms/"+rid+"/messages", req, &cm)
	var again v1.CreateMessageResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/messages", req, &again)
	if again.GetMessage().GetId() != cm.GetMessage().GetId() || len(cm.GetMessage().GetAttachments()) != 1 {
		t.Fatalf("idempotency: %v vs %v", again.GetMessage(), cm.GetMessage())
	}
	// A file can be attached only once.
	bob.must(422, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "again", AttachmentIds: []string{f.GetId()}}, nil)
	bob.must(422, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "  "}, nil)
	bob.must(422, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: strings.Repeat("я", 4001)}, nil)

	// Download: member with VIEW_ROOM; Range; ETag; thumbnail is WebP.
	resp, body := get(t, o, f.GetUrl(), nil)
	if resp.StatusCode != 200 || !bytes.Equal(body, img) || resp.Header.Get("Content-Type") != "image/png" ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("download: %d %v", resp.StatusCode, resp.Header)
	}
	resp, body = get(t, o, f.GetUrl(), map[string]string{"Range": "bytes=0-7"})
	if resp.StatusCode != 206 || !bytes.Equal(body, img[:8]) {
		t.Fatalf("range: %d %d bytes", resp.StatusCode, len(body))
	}
	resp, _ = get(t, o, f.GetUrl(), map[string]string{"If-None-Match": `"` + f.GetSha256() + `"`})
	if resp.StatusCode != 304 {
		t.Fatalf("etag: %d", resp.StatusCode)
	}
	resp, body = get(t, o, f.GetThumbnailUrl(), nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "image/webp" || !bytes.HasPrefix(body[8:], []byte("WEBP")) {
		t.Fatalf("thumbnail: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	// Outsider (another workspace) cannot read it.
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	outsider := register(t, invite(t, o, other.GetId()))
	if resp, _ := get(t, outsider, f.GetUrl(), nil); resp.StatusCode != 404 {
		t.Fatalf("outsider download: %d", resp.StatusCode)
	}

	// History pagination.
	var ids []string
	for i := range 4 {
		ids = append(ids, send(t, o, rid, fmt.Sprintf("m%d", i), "").GetId())
	}
	var page v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages?limit=2", nil, &page)
	if len(page.GetMessages()) != 2 || !page.GetHasMore() || page.GetMessages()[0].GetId() != ids[3] {
		t.Fatalf("page 1: %v", page.GetMessages())
	}
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages?limit=100&before="+ids[2], nil, &page)
	if len(page.GetMessages()) != 3 || page.GetHasMore() || page.GetMessages()[0].GetId() != ids[1] {
		t.Fatalf("before: %d messages, has_more=%v", len(page.GetMessages()), page.GetHasMore())
	}
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages?after="+ids[1], nil, &page)
	if len(page.GetMessages()) != 2 || page.GetMessages()[0].GetId() != ids[2] {
		t.Fatalf("after: %v", page.GetMessages())
	}
	bob.must(400, "GET", "/api/rooms/"+rid+"/messages?limit=500", nil, nil)
	// Room listing carries the newest message (unread counts without extra requests).
	var lr v1.ListRoomsResponse
	bob.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/rooms", nil, &lr)
	if lr.GetRooms()[0].GetLastMessageId() != ids[3] || lr.GetRooms()[0].GetLastMessageAt() == nil {
		t.Fatalf("last message: %v, want %s", lr.GetRooms()[0].GetLastMessageId(), ids[3])
	}

	// Edit own, not others'; delete others' needs MANAGE_MESSAGES.
	var upd v1.UpdateMessageResponse
	bob.must(200, "PATCH", "/api/messages/"+cm.GetMessage().GetId(), &v1.UpdateMessageRequest{Content: "look!"}, &upd)
	if upd.GetMessage().GetEditedAt() == nil || upd.GetMessage().GetContent() != "look!" {
		t.Fatal("edit not applied")
	}
	bob.must(403, "PATCH", "/api/messages/"+ids[0], &v1.UpdateMessageRequest{Content: "hack"}, nil)
	bob.must(403, "DELETE", "/api/messages/"+ids[0], nil, nil)
	o.must(204, "DELETE", "/api/messages/"+cm.GetMessage().GetId(), nil, nil) // admin: MANAGE_MESSAGES
	bob.must(404, "PATCH", "/api/messages/"+cm.GetMessage().GetId(), &v1.UpdateMessageRequest{Content: "x"}, nil)
	// The deleted message's file is no longer readable by others.
	if resp, _ := get(t, o, f.GetUrl(), nil); resp.StatusCode != 404 {
		t.Fatalf("detached file still readable: %d", resp.StatusCode)
	}

	// Read state.
	bob.must(204, "PUT", "/api/rooms/"+rid+"/read", &v1.UpdateReadStateRequest{MessageId: ids[3]}, nil)
	bob.must(422, "PUT", "/api/rooms/"+rid+"/read", &v1.UpdateReadStateRequest{MessageId: "01890000-0000-7000-8000-000000000000"}, nil)

	// Rate limit: 5 messages per 5 s per room.
	codes := map[int]int{}
	for i := range 7 {
		codes[bob.do("POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: fmt.Sprint("spam", i)}, nil)]++
	}
	if codes[429] == 0 {
		t.Fatalf("no rate limit: %v", codes)
	}

	// Quota.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspaces SET storage_quota_bytes = storage_used_bytes + 100 WHERE id = $1", ws.GetId()); err != nil {
		t.Fatal(err)
	}
	if st, _, _ := upload(t, bob, "/api/workspaces/"+ws.GetId()+"/files", "a.txt", bytes.Repeat([]byte("a"), 500)); st != 413 {
		t.Fatalf("quota: %d, want 413", st)
	}

	// Avatar: own image only.
	_, _, me := upload(t, bob, "/api/me/avatar", "me.png", pngBytes(64, 64))
	if me.GetUser().GetAvatarFileId() == "" {
		t.Fatal("avatar not set")
	}
	if st, _, _ := upload(t, bob, "/api/me/avatar", "me.txt", []byte("not an image")); st != 422 {
		t.Fatalf("non-image avatar: %d", st)
	}
	someone := me.GetUser().GetAvatarFileId()
	o.must(422, "PATCH", "/api/me", &v1.UpdateMeRequest{AvatarFileId: &someone}, nil) // not uploaded by owner
	if resp, _ := get(t, outsider, "/api/files/"+someone, nil); resp.StatusCode != 200 {
		t.Fatalf("avatars are readable by any user: %d", resp.StatusCode)
	}

	// Orphan cleanup: an old unattached upload is deleted and its quota released.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspaces SET storage_quota_bytes = 10737418240 WHERE id = $1", ws.GetId()); err != nil {
		t.Fatal(err)
	}
	_, orphan, _ := upload(t, bob, "/api/workspaces/"+ws.GetId()+"/files", "orphan.txt", []byte("bye"))
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE files SET created_at = now() - interval '25 hours' WHERE id = $1", orphan.GetId()); err != nil {
		t.Fatal(err)
	}
	n, err := testApp.Files.CleanupOrphans(context.Background())
	if err != nil || n < 1 {
		t.Fatalf("cleanup: %d %v", n, err)
	}
	if resp, _ := get(t, bob, orphan.GetUrl(), nil); resp.StatusCode != 404 {
		t.Fatalf("orphan still there: %d", resp.StatusCode)
	}
}

// ---- rtc ----

func liveKitUp(t *testing.T) {
	t.Helper()
	d := net.Dialer{Timeout: time.Second}
	c, err := d.DialContext(context.Background(), "tcp", strings.TrimPrefix(testCfg.LiveKitInternalURL, "http://"))
	if err != nil {
		t.Skip("dev LiveKit not reachable: " + err.Error())
	}
	_ = c.Close()
}

func webhook(t *testing.T, ev *livekit.WebhookEvent, secret string) int {
	t.Helper()
	body, err := lkjson.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	tok, err := lkauth.NewAccessToken("devkey", secret).SetValidFor(time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+"/api/rtc/webhook", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/webhook+json")
	req.Header.Set("Authorization", tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

var whSeq atomic.Int64

func whEvent(kind string, roomName, identity string, track *livekit.TrackInfo) *livekit.WebhookEvent {
	n := whSeq.Add(1)
	return &livekit.WebhookEvent{
		Event: kind, Id: fmt.Sprintf("EV_%d_%d", time.Now().UnixNano(), n), CreatedAt: time.Now().Unix(),
		Room:        &livekit.Room{Name: roomName},
		Participant: &livekit.ParticipantInfo{Identity: identity},
		Track:       track,
	}
}

func TestRTC(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()

	// Join: LiveKit room created, token carries the grant.
	var j v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	if j.GetUrl() == "" || !j.GetCanSpeak() || !j.GetCanStream() || j.GetMedia().GetAudioBitrateKbps() != 32 {
		t.Fatalf("join: %v", &j)
	}
	v, err := lkauth.ParseAPIToken(j.GetToken())
	if err != nil {
		t.Fatal(err)
	}
	_, grants, err := v.Verify("secret")
	if err != nil {
		t.Fatalf("token signature: %v", err)
	}
	roomName := "ws_" + ws.GetId() + "_room_" + rid
	if grants.Identity != j.GetIdentity() || grants.Video.Room != roomName || !grants.Video.RoomJoin ||
		strings.Join(grants.Video.CanPublishSources, ",") != "microphone,screen_share,screen_share_audio" || grants.Video.RoomAdmin {
		t.Fatalf("grants: %+v", grants.Video)
	}
	lkRooms, err := lkRec.ListRooms(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range lkRooms {
		found = found || r.Name == roomName
	}
	if !found {
		t.Fatal("LiveKit room was not created")
	}
	// Text rooms and members without CONNECT cannot join.
	var tr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "t"}, &tr)
	bob.must(422, "POST", "/api/rooms/"+tr.GetRoom().GetId()+"/join", nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Deny: 16},
	}}, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/join", nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
	// stream/request needs an actual LiveKit participant.
	bob.must(409, "POST", "/api/rooms/"+rid+"/stream/request", &v1.RequestStreamRequest{}, nil)

	// Webhooks → voice state → gateway.
	g := dialGW(t)
	g.identify(o.token)
	if st := webhook(t, whEvent("participant_joined", roomName, j.GetIdentity(), nil), "wrong-secret"); st != 401 {
		t.Fatalf("bad signature: %d", st)
	}
	joined := whEvent("participant_joined", roomName, j.GetIdentity(), nil)
	if st := webhook(t, joined, "secret"); st != 200 {
		t.Fatalf("webhook: %d", st)
	}
	g.wait("VOICE_STATE_UPDATE join", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == rid && s.GetMuted()
	})
	if st := webhook(t, joined, "secret"); st != 200 { // redelivery: handled once
		t.Fatalf("redelivery: %d", st)
	}
	webhook(t, whEvent("track_published", roomName, j.GetIdentity(), &livekit.TrackInfo{Sid: "TR_mic", Source: livekit.TrackSource_MICROPHONE}), "secret")
	g.wait("unmuted", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && !s.GetMuted()
	})
	deaf := true
	bob.must(204, "PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Deafened: &deaf}, nil)
	g.wait("deafened", func(e *v1.DispatchEvent) bool { return e.GetVoiceStateUpdate().GetState().GetDeafened() })
	// Musician mode (ADR-0052): set and cleared through the same PATCH, deafen kept.
	music, noMusic := true, false
	bob.must(204, "PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Musician: &music}, nil)
	g.wait("musician", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetMusician() && s.GetDeafened()
	})
	bob.must(204, "PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Musician: &noMusic}, nil)
	g.wait("musician off", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && !s.GetMusician() && s.GetDeafened()
	})

	// Stream limit: max_streams=1 → the second screen share is muted by the server.
	one := uint32(1)
	o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{MediaOverride: &v1.RoomMediaOverride{MaxStreams: &one}}, nil)
	webhook(t, whEvent("track_published", roomName, j.GetIdentity(), &livekit.TrackInfo{Sid: "TR_s1", Source: livekit.TrackSource_SCREEN_SHARE}), "secret")
	g.wait("VOICE_STREAM_START", func(e *v1.DispatchEvent) bool { return e.GetVoiceStreamStart().GetTrackSid() == "TR_s1" })
	var oj v1.JoinVoiceResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &oj)
	if oj.GetCanStream() {
		t.Fatal("stream slot offered although the limit is reached")
	}
	webhook(t, whEvent("participant_joined", roomName, oj.GetIdentity(), nil), "secret")
	webhook(t, whEvent("track_published", roomName, oj.GetIdentity(), &livekit.TrackInfo{Sid: "TR_s2", Source: livekit.TrackSource_SCREEN_SHARE}), "secret")
	g.wait("VOICE_STREAM_STOP limit", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStreamStop()
		return s.GetTrackSid() == "TR_s2" && s.GetReason() == v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_LIMIT_REACHED
	})
	mutedOK := false
	for _, m := range lkRec.mutedTracks() {
		mutedOK = mutedOK || m == oj.GetIdentity()+"/TR_s2"
	}
	if !mutedOK {
		t.Fatalf("over-limit track not muted in LiveKit: %v", lkRec.mutedTracks())
	}
	// Moderator stops bob's stream; bob cannot stop the owner's.
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+o.id+"/stop-stream", nil, nil)
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-stream", nil, nil)
	g.wait("VOICE_STREAM_STOP moderator", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStreamStop()
		return s.GetTrackSid() == "TR_s1" && s.GetReason() == v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_MODERATOR
	})
	o.must(404, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/stop-stream", nil, nil) // nothing left to stop
	// A new stream that ends normally.
	webhook(t, whEvent("track_published", roomName, j.GetIdentity(), &livekit.TrackInfo{Sid: "TR_s3", Source: livekit.TrackSource_SCREEN_SHARE}), "secret")
	g.wait("VOICE_STREAM_START s3", func(e *v1.DispatchEvent) bool { return e.GetVoiceStreamStart().GetTrackSid() == "TR_s3" })
	webhook(t, whEvent("track_unpublished", roomName, j.GetIdentity(), &livekit.TrackInfo{Sid: "TR_s3", Source: livekit.TrackSource_SCREEN_SHARE}), "secret")
	g.wait("VOICE_STREAM_STOP ended", func(e *v1.DispatchEvent) bool {
		return e.GetVoiceStreamStop().GetReason() == v1.VoiceStreamStopReason_VOICE_STREAM_STOP_REASON_ENDED
	})

	// READY of a new device includes voice states.
	g2 := dialGW(t)
	ready := g2.identify(bob.token)
	inVoice := false
	for _, s := range ready.GetWorkspaces() {
		for _, vs := range s.GetVoiceStates() {
			inVoice = inVoice || (vs.GetUserId() == bob.id && vs.GetRoomId() == rid)
		}
	}
	if !inVoice {
		t.Fatal("READY lacks voice state")
	}

	// Moderation: bob cannot mute the owner; owner (MUTE_MEMBERS) can disconnect bob.
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+o.id+"/mute", nil, nil)
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/disconnect", nil, nil) // participant not in LiveKit: no-op

	// Leave.
	webhook(t, whEvent("participant_left", roomName, j.GetIdentity(), nil), "secret")
	g.wait("left", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == ""
	})
}

func TestProfileBroadcast(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	og := dialGW(t)
	og.identify(o.token)
	bg := dialGW(t)
	bg.identify(bob.token)
	name := "Bob Renamed"
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{DisplayName: &name}, nil)
	ev := og.wait("USER_UPDATE (public)", func(e *v1.DispatchEvent) bool {
		return e.GetUserUpdate().GetUser().GetId() == bob.id
	}).GetUserUpdate()
	if ev.GetUser().GetDisplayName() != name || ev.GetMe() != nil {
		t.Fatalf("public update leaks private fields or lacks the name: %v", ev)
	}
	bg.wait("USER_UPDATE (own devices get Me)", func(e *v1.DispatchEvent) bool {
		return e.GetUserUpdate().GetMe().GetEmail() != ""
	})
	// Settings-only changes stay private.
	bob.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{MicMode: v1.MicMode_MIC_MODE_PUSH_TO_TALK}}, nil)
	og.quiet("settings broadcast", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetUserUpdate() != nil })
}

func TestSettingsDefaults(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, ws.GetId()))
	var me v1.GetMeResponse
	u.must(200, "GET", "/api/me", nil, &me)
	st := me.GetMe().GetSettings()
	if st.GetNoiseSuppression() || st.GetMicMode() != v1.MicMode_MIC_MODE_VAD || st.AudioBitrateKbps != nil { // RNNoise off by default (migration 00025)
		t.Fatalf("new user defaults: %v", st)
	}
	// protojson omits false: the server must still store "off" as off.
	var upd v1.UpdateMeResponse
	u.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{NoiseSuppression: false, MicMode: v1.MicMode_MIC_MODE_PUSH_TO_TALK}}, &upd)
	u.must(200, "GET", "/api/me", nil, &me)
	if st := me.GetMe().GetSettings(); st.GetNoiseSuppression() || st.GetMicMode() != v1.MicMode_MIC_MODE_PUSH_TO_TALK {
		t.Fatalf("explicit off lost: %v", st)
	}
	bad := uint32(33)
	u.must(422, "PATCH", "/api/me", &v1.UpdateMeRequest{Settings: &v1.UserSettings{AudioBitrateKbps: &bad}}, nil)
}
