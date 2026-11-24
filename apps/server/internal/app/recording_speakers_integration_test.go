//go:build integration

package app_test

import (
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
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
	report := func(u *user, ivs ...*v1.SpeechInterval) {
		t.Helper()
		g := dialGW(t)
		g.identify(u.token)
		g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RECORDING_SPEECH, Payload: &v1.GatewayFrame_RecordingSpeech{
			RecordingSpeech: &v1.RecordingSpeech{RoomId: rid, RecordingId: recID, Intervals: ivs},
		}})
	}
	iv := func(agoStart, agoEnd uint32) *v1.SpeechInterval {
		return &v1.SpeechInterval{AgoStartMs: agoStart, AgoEndMs: agoEnd}
	}
	report(o, iv(59500, 50000), iv(40000, 35000))     // ≈ 0.5–10 s and 20–25 s of the recording
	report(bob, iv(48000, 41000))                     // ≈ 12–19 s
	report(carol, iv(30000, 28000), iv(60000, 59000)) // not in the call: dropped
	rows := func(user string) int {
		t.Helper()
		var n int
		if err := testDB.Pool.QueryRow(ctx, `SELECT count(*) FROM room_recording_speech WHERE recording_id = $1 AND ($2 = '' OR user_id::text = $2)`, recID, user).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	deadline := time.Now().Add(5 * time.Second)
	for rows(o.id) != 2 || rows(bob.id) != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("reports not stored: owner %d, bob %d", rows(o.id), rows(bob.id))
		}
		time.Sleep(50 * time.Millisecond)
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
