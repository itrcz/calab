package rtc

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lkjson "github.com/livekit/protocol/utils/protojson"
	"google.golang.org/protobuf/encoding/protojson"
)

// EgressInfo must read what LiveKit sends: webhooks (lowerCamelCase, int64 as strings) and
// twirp answers (proto names, unpopulated fields emitted).
func TestEgressInfoWireFormats(t *testing.T) {
	src := &livekit.EgressInfo{
		EgressId: "EG_1", RoomName: "ws_a_room_b", Status: livekit.EgressStatus_EGRESS_COMPLETE, Error: "",
		FileResults: []*livekit.FileInfo{{Filename: "/out/a/b.mp4", Size: 123456789012, Duration: int64(95 * time.Second), StartedAt: 1764000000123456789}},
	}
	webhookJSON, err := lkjson.Marshal(&livekit.WebhookEvent{Event: "egress_ended", EgressInfo: src})
	if err != nil {
		t.Fatal(err)
	}
	var ev WebhookEvent
	if err := json.Unmarshal(webhookJSON, &ev); err != nil {
		t.Fatal(err)
	}
	twirpJSON, err := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}.Marshal(src)
	if err != nil {
		t.Fatal(err)
	}
	var fromTwirp EgressInfo
	if err := json.Unmarshal(twirpJSON, &fromTwirp); err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string]*EgressInfo{"webhook": ev.Egress(), "twirp": &fromTwirp} {
		if got == nil || got.EgressID != "EG_1" || got.RoomName != "ws_a_room_b" || got.Status != EgressComplete || !got.Ended() ||
			got.File().Size != 123456789012 || got.File().Duration != 95*time.Second || got.File().Filename != "/out/a/b.mp4" ||
			!got.File().StartedAt.Equal(time.Unix(0, 1764000000123456789)) {
			t.Fatalf("%s: %+v", name, got)
		}
	}
	var numeric EgressInfo
	if err := json.Unmarshal([]byte(`{"egressId":"EG_2","status":1,"file":{"size":5,"duration":"7"}}`), &numeric); err != nil {
		t.Fatal(err)
	}
	if numeric.Status != EgressActive || numeric.Ended() || numeric.File().Size != 5 || numeric.File().Duration != 7 || !numeric.File().StartedAt.IsZero() {
		t.Fatalf("numeric / legacy file: %+v", numeric)
	}
}

// egressRecorder is LiveKit's generated twirp server side of StartRoomCompositeEgress: it keeps
// the request as LiveKit decodes it (unknown JSON fields are dropped there, not rejected).
type egressRecorder struct {
	livekit.Egress
	got *livekit.RoomCompositeEgressRequest
}

func (f *egressRecorder) StartRoomCompositeEgress(_ context.Context, req *livekit.RoomCompositeEgressRequest) (*livekit.EgressInfo, error) {
	f.got = req
	return &livekit.EgressInfo{EgressId: "EG_1", RoomName: req.GetRoomName(), Status: livekit.EgressStatus_EGRESS_STARTING}, nil
}

// The file output of a recording: a path on the shared volume, or an upload into the bucket.
func TestStartAudioRecordingRequest(t *testing.T) {
	rec := &egressRecorder{}
	srv := httptest.NewServer(livekit.NewEgressServer(rec))
	defer srv.Close()
	eg := NewEgress(srv.URL, "key", "secret")
	ctx := context.Background()

	info, err := eg.StartAudioRecording(ctx, "ws_a_room_b", FileOutput{Filepath: "/out/w/r.mp4"})
	if err != nil || info.EgressID != "EG_1" {
		t.Fatalf("volume: %+v %v", info, err)
	}
	if !rec.got.GetAudioOnly() || rec.got.GetRoomName() != "ws_a_room_b" || len(rec.got.GetFileOutputs()) != 1 {
		t.Fatalf("volume: %v", rec.got)
	}
	f := rec.got.GetFileOutputs()[0]
	if f.GetFileType() != livekit.EncodedFileType_MP4 || f.GetFilepath() != "/out/w/r.mp4" || f.GetS3() != nil || f.GetDisableManifest() {
		t.Fatalf("volume file output: %v", f)
	}

	up := &S3Upload{Endpoint: "https://s3.example.test", Region: "region-1", Bucket: "files", AccessKey: "test-key-id", Secret: "test-secret", ForcePathStyle: true}
	if _, err := eg.StartAudioRecording(ctx, "ws_a_room_b", FileOutput{Filepath: "calab/files/w/r.mp4", S3: up}); err != nil {
		t.Fatal(err)
	}
	f = rec.got.GetFileOutputs()[0]
	s3 := f.GetS3()
	if f.GetFileType() != livekit.EncodedFileType_MP4 || f.GetFilepath() != "calab/files/w/r.mp4" || !f.GetDisableManifest() || s3 == nil ||
		s3.GetEndpoint() != up.Endpoint || s3.GetRegion() != up.Region || s3.GetBucket() != up.Bucket ||
		s3.GetAccessKey() != up.AccessKey || s3.GetSecret() != up.Secret || !s3.GetForcePathStyle() {
		t.Fatalf("bucket file output: %v", f)
	}
	up.ForcePathStyle = false
	if _, err := eg.StartAudioRecording(ctx, "ws_a_room_b", FileOutput{Filepath: "w/r.mp4", S3: up}); err != nil {
		t.Fatal(err)
	}
	if f = rec.got.GetFileOutputs()[0]; f.GetFilepath() != "w/r.mp4" || f.GetS3().GetForcePathStyle() {
		t.Fatalf("virtual-hosted style: %v", f)
	}
	// A phone call (ADR-0131): Ogg/Opus.
	if _, err := eg.StartAudioRecording(ctx, "sipin_a_b", FileOutput{Filepath: "/out/phone/w/r.ogg", FileType: FileOGG, Audio: PhoneAudio}); err != nil {
		t.Fatal(err)
	}
	if f = rec.got.GetFileOutputs()[0]; f.GetFileType() != livekit.EncodedFileType_OGG || f.GetFilepath() != "/out/phone/w/r.ogg" {
		t.Fatalf("ogg file output: %v", f)
	}
	if a := rec.got.GetAdvanced(); a.GetAudioCodec() != livekit.AudioCodec_OPUS || a.GetAudioBitrate() != 24 {
		t.Fatalf("phone encoding options: %v", a)
	}
	if _, err := eg.StartAudioRecording(ctx, "ws_a_room_b", FileOutput{Filepath: "w/r.mp4"}); err != nil {
		t.Fatal(err)
	}
	if rec.got.GetAdvanced() != nil {
		t.Fatalf("meeting recording must keep the default encoding: %v", rec.got.GetAdvanced())
	}
}
