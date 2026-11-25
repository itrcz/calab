//go:build integration

package app_test

import (
	"context"
	"crypto/rand"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/gptunnel/gptunneltest"
)

// TestRecordingSpeakerNames (ADR-0169): participants of a recorded call report their own on-air
// time over the gateway; when the transcript arrives its speaker numbers get their names
// (user ids); a report from someone outside the call is ignored; deleting the recording clears
// the reports and the names.
func TestRecordingSpeakerNames(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	carol := register(t, invite(t, o, ws.GetId())) // sees the room, not in the call
	pairWorkspace(t, o, ws.GetId())
	inCall(t, o, ws, rid)
	inCall(t, bob, ws, rid)
	ctx := context.Background()
	fake := func(f func()) {
		gptFake.Lock()
		defer gptFake.Unlock()
		f()
	}
	defer fake(func() { gptFake.Statuses, gptFake.Language, gptFake.Transcript = nil, "", nil })
	zero, one := 0, 1
	fake(func() {
		gptFake.Statuses, gptFake.Language = []string{"done"}, "ru"
		gptFake.Transcript = []gptunneltest.Segment{
			{Speaker: &zero, Start: 0.6, End: 9.8, Text: "Начнём."},
			{Speaker: &one, Start: 12.1, End: 18.9, Text: "Эталоны пересняли."},
			{Speaker: &zero, Start: 20.2, End: 24.8, Text: "Отлично."},
			{Speaker: nil, Start: 30, End: 31, Text: "Угу."},
		}
	})

	var start v1.StartRecordingResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/recording/start", nil, &start)
	recID := start.GetRecording().GetRecordingId()
	// The recording started a minute ago: the reports below fit its window.
	if _, err := testDB.Pool.Exec(ctx, `UPDATE room_recordings SET started_at = now() - interval '60 seconds' WHERE id = $1`, recID); err != nil {
		t.Fatal(err)
	}
	report, sync := speechReporter(t, rid, recID)
	iv := speechIv
	report(o, iv(59500, 50000), iv(40000, 35000))     // ≈ 0.5–10 s and 20–25 s of the recording
	report(bob, iv(48000, 41000))                     // ≈ 12–19 s
	report(carol, iv(30000, 28000), iv(60000, 59000)) // not in the call: dropped
	sync(o, bob, carol)                               // every frame above is handled
	rows := func(user string) int {
		t.Helper()
		return speechRows(t, recID, user)
	}
	if rows(o.id) != 2 || rows(bob.id) != 1 {
		t.Fatalf("reports not stored: owner %d, bob %d", rows(o.id), rows(bob.id))
	}
	if n := rows(carol.id); n != 0 {
		t.Fatalf("a report from outside the call was kept: %d", n)
	}

	// The recorder ends; GPTunneL is done; the transcript arrives with names.
	g := dialGW(t)
	g.identify(o.token)
	egressID := lastEgress(t, rid)
	egFake.mu.Lock()
	req := egFake.starts[len(egFake.starts)-1]
	egFake.mu.Unlock()
	local := filepath.Join(recordDir, strings.TrimPrefix(req.GetFileOutputs()[0].GetFilepath(), "/out/"))
	data := make([]byte, 16<<10)
	_, _ = rand.Read(data)
	if err := os.WriteFile(local, data, 0o600); err != nil {
		t.Fatal(err)
	}
	ended := egFake.end(egressID, int64(len(data)))
	if st := webhook(t, &livekit.WebhookEvent{Event: "egress_ended", Id: uniq("EV_eg"), CreatedAt: time.Now().Unix(), EgressInfo: ended}, "secret"); st != 200 {
		t.Fatalf("egress_ended: %d", st)
	}
	g.wait("card with the result", func(e *v1.DispatchEvent) bool {
		c := card(e)
		return c.GetRecordingId() == recID && c.GetStatus() == v1.RecordingStatus_RECORDING_STATUS_DONE && !c.GetResultPending()
	})
	tpath := "/api/rooms/" + rid + "/recordings/" + recID + "/transcript"
	var tr v1.GetRecordingTranscriptResponse
	carol.must(200, "GET", tpath, nil, &tr)
	sp := tr.GetSpeakers()
	if len(sp) != 2 || sp[0].GetSpeaker() != 0 || sp[0].GetUserId() != o.id || sp[1].GetSpeaker() != 1 || sp[1].GetUserId() != bob.id {
		t.Fatalf("speakers: %v", sp)
	}
	segs := tr.GetSegments()
	if len(segs) != 4 || segs[0].GetUserId() != o.id || segs[1].GetUserId() != bob.id || segs[2].GetUserId() != o.id ||
		segs[3].GetUserId() != "" || segs[3].GetSpeaker() != -1 {
		t.Fatalf("segments: %v", segs)
	}

	// RECORDING_SPEAKER_NAMES=off: the stored match is not returned — numbers as before.
	testApp.Recording.SetSpeakerNames(false)
	var plain v1.GetRecordingTranscriptResponse
	carol.must(200, "GET", tpath, nil, &plain)
	testApp.Recording.SetSpeakerNames(true)
	if len(plain.GetSpeakers()) != 0 || len(plain.GetSegments()) != 4 || plain.GetSegments()[0].GetUserId() != "" ||
		plain.GetSegments()[0].GetSpeaker() != 0 || plain.GetSegments()[1].GetUserId() != "" {
		t.Fatalf("names with the switch off: %v", &plain)
	}

	// Deleting the recording clears the reports and the names with the transcript.
	bob.must(204, "DELETE", "/api/rooms/"+rid+"/recordings/"+recID, nil, nil)
	var named bool
	if err := testDB.Pool.QueryRow(ctx, `SELECT speakers_json IS NOT NULL FROM room_recordings WHERE id = $1`, recID).Scan(&named); err != nil {
		t.Fatal(err)
	}
	if n := rows(""); n != 0 || named {
		t.Fatalf("after delete: %d reports, speakers kept %v", n, named)
	}
}

// TestRecordingSpeakerNamesSwitch (ADR-0169, rollout safety): HELLO advertises RECORDING_SPEECH
// by default; with RECORDING_SPEAKER_NAMES=off it does not, and such a frame is ignored — the
// socket stays open (an older server would close it with 4001).
func TestRecordingSpeakerNamesSwitch(t *testing.T) {
	o, _, _, _ := setupTeam(t)
	on := dialGW(t)
	if on.hello.GetCapabilities()&uint64(v1.ServerCapability_SERVER_CAPABILITY_RECORDING_SPEECH) == 0 {
		t.Fatalf("HELLO without RECORDING_SPEECH by default: %v", on.hello)
	}
	_ = on.ws.CloseNow()

	c := *testCfg
	c.RecordingSpeakerNames = "off"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	offApp := app.New(app.Deps{Config: &c, DB: testDB, Redis: testRedis, Events: events.Redis{C: testRedis}, Blob: testStore, LiveKit: lkRec, Mail: testMail})
	offSrv := httptest.NewServer(offApp.Handler)
	t.Cleanup(offSrv.Close)
	g := dialGWAt(t, offSrv.URL)
	defer func() { _ = g.ws.CloseNow() }()
	if caps := g.hello.GetCapabilities(); caps != 0 {
		t.Fatalf("HELLO capabilities with the switch off: %d", caps)
	}
	g.identify(o.token)
	g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RECORDING_SPEECH, Payload: &v1.GatewayFrame_RecordingSpeech{
		RecordingSpeech: &v1.RecordingSpeech{RoomId: uuid.NewString(), RecordingId: uuid.NewString(), Intervals: []*v1.SpeechInterval{speechIv(2000, 1000)}},
	}})
	g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT, Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{}}})
	g.waitFrame("heartbeat ack after RECORDING_SPEECH", func(f *v1.GatewayFrame) bool { return f.GetHeartbeatAck() != nil })
}

// speechReporter sends RecordingSpeech frames of a recording over one gateway socket per user;
// sync waits until every frame sent so far on the users' sockets is handled (the gateway handles
// a socket's frames in order: a heartbeat's ack comes after the reports before it).
func speechReporter(t *testing.T, rid, recID string) (report func(u *user, ivs ...*v1.SpeechInterval), sync func(us ...*user)) {
	socks := map[string]*gw{}
	sock := func(u *user) *gw {
		if g, ok := socks[u.id]; ok {
			return g
		}
		g := dialGW(t)
		g.identify(u.token)
		socks[u.id] = g
		return g
	}
	report = func(u *user, ivs ...*v1.SpeechInterval) {
		t.Helper()
		sock(u).send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RECORDING_SPEECH, Payload: &v1.GatewayFrame_RecordingSpeech{
			RecordingSpeech: &v1.RecordingSpeech{RoomId: rid, RecordingId: recID, Intervals: ivs},
		}})
	}
	sync = func(us ...*user) {
		t.Helper()
		for _, u := range us {
			g := sock(u)
			g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT, Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{}}})
			g.waitFrame("heartbeat ack", func(f *v1.GatewayFrame) bool { return f.GetHeartbeatAck() != nil })
		}
	}
	return report, sync
}

func speechIv(agoStart, agoEnd uint32) *v1.SpeechInterval {
	return &v1.SpeechInterval{AgoStartMs: agoStart, AgoEndMs: agoEnd}
}

// speechRows counts the stored on-air intervals of a recording ("" = everyone's).
func speechRows(t *testing.T, recID, user string) int {
	t.Helper()
	var n int
	if err := testDB.Pool.QueryRow(context.Background(), `SELECT count(*) FROM room_recording_speech WHERE recording_id = $1 AND ($2 = '' OR user_id::text = $2)`, recID, user).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestRecordingSpeechAdmission (ADR-0169 §2): the limits of what an on-air report may store — the
// per-message and per-recording caps, a report from someone who has left the call (only up to
// their last accepted report + 15 s), and the minute after the stop.
func TestRecordingSpeechAdmission(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	pairWorkspace(t, o, ws.GetId())
	inCall(t, o, ws, rid)
	bobIdentity := inCall(t, bob, ws, rid)
	ctx := context.Background()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := testDB.Pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	var start v1.StartRecordingResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/recording/start", nil, &start)
	recID := start.GetRecording().GetRecordingId()
	exec(`UPDATE room_recordings SET started_at = now() - interval '10 minutes' WHERE id = $1`, recID)
	report, sync := speechReporter(t, rid, recID)
	iv := speechIv

	// 250 intervals 0.1 s long, 0.6 s apart (nothing merges): the first 200 are kept.
	many := make([]*v1.SpeechInterval, 250)
	for i := range many {
		at := uint32(300_000 - i*600)
		many[i] = iv(at, at-100)
	}
	report(o, many...)
	sync(o)
	if n := speechRows(t, recID, o.id); n != 200 {
		t.Fatalf("one message: %d intervals kept, want 200", n)
	}
	// 20000 per user and recording: the owner is at the cap, nothing more is stored.
	exec(`INSERT INTO room_recording_speech (recording_id, user_id, start_ms, end_ms)
		SELECT $1, $2, g * 10, g * 10 + 5 FROM generate_series(1, 19800) g`, recID, o.id)
	report(o, iv(5000, 4000))
	sync(o)
	if n := speechRows(t, recID, o.id); n != 20000 {
		t.Fatalf("at the cap: %d intervals, want 20000", n)
	}

	// Bob reports while in the call, then leaves; his last accepted report was a minute ago.
	report(bob, iv(70000, 69000))
	sync(bob)
	if n := speechRows(t, recID, bob.id); n != 1 {
		t.Fatalf("bob in the call: %d", n)
	}
	exec(`UPDATE room_recording_speech SET reported_at = now() - interval '60 seconds' WHERE recording_id = $1 AND user_id = $2`, recID, bob.id)
	bob.must(204, "POST", "/api/rooms/"+rid+"/voice/leave", nil, nil)
	webhook(t, whEvent("participant_left", "ws_"+ws.GetId()+"_room_"+rid, bobIdentity, nil), "secret")
	// 58–52 s ago ends before that report + 15 s: kept; 50–40 s ago is cut at 45 s ago; 20–10 s
	// ago is all after it: dropped.
	report(bob, iv(58000, 52000), iv(50000, 40000), iv(20000, 10000))
	sync(bob)
	var spans [][2]int32
	r, err := testDB.Pool.Query(ctx, `SELECT start_ms, end_ms FROM room_recording_speech WHERE recording_id = $1 AND user_id = $2 ORDER BY start_ms`, recID, bob.id)
	if err != nil {
		t.Fatal(err)
	}
	for r.Next() {
		var a, b int32
		if err := r.Scan(&a, &b); err != nil {
			t.Fatal(err)
		}
		spans = append(spans, [2]int32{a, b})
	}
	r.Close()
	if len(spans) != 3 || spans[1][1]-spans[1][0] < 5900 {
		t.Fatalf("after leaving: %v", spans)
	}
	if d := spans[2][1] - spans[2][0]; d < 3000 || d > 5100 {
		t.Fatalf("after leaving: the stretch past the bound is not cut at it: %v", spans)
	}
	var moved bool // a report after leaving must not push the bound on
	if err := testDB.Pool.QueryRow(ctx, `SELECT max(reported_at) > now() - interval '50 seconds' FROM room_recording_speech WHERE recording_id = $1 AND user_id = $2`, recID, bob.id).Scan(&moved); err != nil || moved {
		t.Fatalf("after leaving: the bound moved (%v, %v)", moved, err)
	}

	// The minute after the stop: a late report is kept (within the recording); later, dropped.
	exec(`UPDATE room_recordings SET status = 'failed', stopped_at = now() - interval '30 seconds' WHERE id = $1`, recID)
	exec(`DELETE FROM room_recording_speech WHERE recording_id = $1 AND user_id = $2`, recID, o.id)
	report(o, iv(40000, 35000), iv(25000, 20000)) // the second is after the stop
	sync(o)
	if n := speechRows(t, recID, o.id); n != 1 {
		t.Fatalf("within the grace: %d rows, want 1", n)
	}
	exec(`UPDATE room_recordings SET stopped_at = now() - interval '2 minutes' WHERE id = $1`, recID)
	report(o, iv(150000, 140000))
	sync(o)
	if n := speechRows(t, recID, o.id); n != 1 {
		t.Fatalf("after the grace: %d rows, want 1", n)
	}
}
