package rtc

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// A minimal LiveKit Egress client (ADR-0013 applies: twirp JSON over net/http, no
// livekit/protocol). Only what meeting recording needs (ADR-0025): an audio-only room
// composite into an MP4 file — on the recordings volume shared with the API, or uploaded by the
// egress into an S3 bucket — stop, and list. Compatibility with the generated twirp server of
// livekit/protocol is checked in the tests.

// Egress statuses (livekit.EgressStatus) as they appear in JSON.
const (
	EgressStarting     = "EGRESS_STARTING"
	EgressActive       = "EGRESS_ACTIVE"
	EgressEnding       = "EGRESS_ENDING"
	EgressComplete     = "EGRESS_COMPLETE"
	EgressFailed       = "EGRESS_FAILED"
	EgressAborted      = "EGRESS_ABORTED"
	EgressLimitReached = "EGRESS_LIMIT_REACHED"
)

// Webhook events of egress (WebhookEvent.EgressInfo is set).
const (
	EventEgressStarted = "egress_started"
	EventEgressUpdated = "egress_updated"
	EventEgressEnded   = "egress_ended"
)

// egressStatusNames maps the enum numbers, in case a peer sends them as numbers.
var egressStatusNames = []string{EgressStarting, EgressActive, EgressEnding, EgressComplete, EgressFailed, EgressAborted, EgressLimitReached}

// FileResult is livekit.FileInfo (subset).
type FileResult struct {
	Filename string
	Size     int64
	Duration time.Duration
	// StartedAt: when the file's audio starts (FileInfo.started_at, unix ns); zero = unknown.
	// The transcript's times count from it (ADR-0169 §3).
	StartedAt time.Time
}

// EgressInfo is livekit.EgressInfo (subset).
type EgressInfo struct {
	EgressID string
	RoomName string
	Status   string
	Error    string
	Files    []FileResult
}

// Ended reports a final status: the egress will not write any more.
func (e *EgressInfo) Ended() bool {
	switch e.Status {
	case EgressComplete, EgressFailed, EgressAborted, EgressLimitReached:
		return true
	}
	return false
}

// File returns the first file result (zero value if none).
func (e *EgressInfo) File() FileResult {
	if len(e.Files) == 0 {
		return FileResult{}
	}
	return e.Files[0]
}

// UnmarshalJSON accepts protojson in either naming (twirp answers with proto names,
// webhooks use lowerCamelCase), int64 as strings or numbers and enums as names or numbers.
func (e *EgressInfo) UnmarshalJSON(b []byte) error {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	*e = EgressInfo{
		EgressID: jsonString(pick(m, "egress_id", "egressId")),
		RoomName: jsonString(pick(m, "room_name", "roomName")),
		Error:    jsonString(pick(m, "error")),
	}
	if raw := pick(m, "status"); raw != nil {
		var name string
		if json.Unmarshal(raw, &name) == nil {
			e.Status = name
		} else if n := jsonInt(raw); n >= 0 && int(n) < len(egressStatusNames) {
			e.Status = egressStatusNames[n]
		}
	}
	var files []map[string]json.RawMessage
	if raw := pick(m, "file_results", "fileResults"); raw != nil {
		_ = json.Unmarshal(raw, &files)
	}
	if len(files) == 0 { // deprecated single file field
		var f map[string]json.RawMessage
		if raw := pick(m, "file"); raw != nil && json.Unmarshal(raw, &f) == nil && f != nil {
			files = append(files, f)
		}
	}
	for _, f := range files {
		fr := FileResult{
			Filename: jsonString(pick(f, "filename")),
			Size:     jsonInt(pick(f, "size")),
			Duration: time.Duration(jsonInt(pick(f, "duration"))),
		}
		if ns := jsonInt(pick(f, "started_at", "startedAt")); ns > 0 {
			fr.StartedAt = time.Unix(0, ns)
		}
		e.Files = append(e.Files, fr)
	}
	return nil
}

func pick(m map[string]json.RawMessage, keys ...string) json.RawMessage {
	for _, k := range keys {
		if v, ok := m[k]; ok && string(v) != "null" {
			return v
		}
	}
	return nil
}

func jsonString(raw json.RawMessage) string {
	var s string
	_ = json.Unmarshal(raw, &s)
	return s
}

// jsonInt reads an int64 written as a number or (protojson) a string; -1 if neither.
func jsonInt(raw json.RawMessage) int64 {
	if raw == nil {
		return 0
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err == nil {
		if v, err := n.Int64(); err == nil {
			return v
		}
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if v, err := strconv.ParseInt(s, 10, 64); err == nil {
			return v
		}
	}
	return -1
}

// S3Upload is livekit.S3Upload (subset): the bucket an egress uploads its file to, with a
// static key. LiveKit Egress redacts the key and secret in the EgressInfo it reports.
type S3Upload struct {
	Endpoint       string
	Region         string
	Bucket         string
	AccessKey      string
	Secret         string
	ForcePathStyle bool
}

// FileOutput is where an egress puts its file (livekit.EncodedFileOutput subset).
type FileOutput struct {
	// Filepath is a path in the egress container; with S3, the object key in the bucket (the
	// egress records into a temporary file of its own and uploads it when the recording ends).
	Filepath string
	S3       *S3Upload
	// FileType is the container: "" = MP4 (AAC, meetings), FileOGG = Ogg/Opus (phone calls,
	// ADR-0131).
	FileType string
	// Audio overrides the default audio encoding (OPUS, 128 kbit/s, 44.1 kHz); nil = default.
	Audio *AudioEncoding
}

// AudioEncoding is livekit.EncodingOptions (audio subset), sent as the request's advanced
// options. The egress mixes to stereo and has no channel-count option; Opus at a low bitrate
// codes near-identical channels at about the cost of one.
type AudioEncoding struct {
	// BitrateKbps is audio_bitrate in kbit/s. The sample rate is left to the egress default.
	BitrateKbps int
}

// PhoneAudio is the encoding of a phone call recording (ADR-0131, addendum): callers are on
// GSM/G.711 lines, so Opus at 24 kbit/s is already well above the line.
var PhoneAudio = &AudioEncoding{BitrateKbps: 24}

// FileOGG is FileOutput.FileType of an Ogg/Opus recording (livekit.EncodedFileType OGG).
const FileOGG = "OGG"

// Egress is the subset of the LiveKit Egress service the server uses (mockable in tests).
type Egress interface {
	// StartAudioRecording records the mixed audio of a room into an MP4 (AAC) file at out, or
	// Ogg/Opus with out.FileType = FileOGG.
	StartAudioRecording(ctx context.Context, room string, out FileOutput) (*EgressInfo, error)
	StopEgress(ctx context.Context, egressID string) (*EgressInfo, error)
	// ListEgress lists egresses: of one room ("" = all), or only one egress (egressID), and
	// only active ones if active.
	ListEgress(ctx context.Context, room, egressID string, active bool) ([]EgressInfo, error)
}

// NewEgress creates an Egress client for the internal LiveKit URL: LiveKit forwards the
// calls to the egress service over Redis.
func NewEgress(internalURL, key, secret string) Egress {
	// StartRoomCompositeEgress waits until an egress instance accepted the request.
	return &egressClient{c: &client{base: strings.TrimRight(internalURL, "/"), key: key, secret: secret, hc: &http.Client{Timeout: 30 * time.Second}}}
}

type egressClient struct{ c *client }

func (e *egressClient) call(ctx context.Context, method string, in, out any) error {
	return e.c.callService(ctx, "livekit.Egress", method, &videoGrant{RoomRecord: true}, in, out)
}

func (e *egressClient) StartAudioRecording(ctx context.Context, room string, out FileOutput) (*EgressInfo, error) {
	kind := "MP4"
	if out.FileType != "" {
		kind = out.FileType
	}
	file := map[string]any{"file_type": kind, "filepath": out.Filepath}
	if u := out.S3; u != nil {
		file["s3"] = map[string]any{
			"access_key": u.AccessKey, "secret": u.Secret, "region": u.Region, "endpoint": u.Endpoint,
			"bucket": u.Bucket, "force_path_style": u.ForcePathStyle,
		}
		// No manifest (<egress id>.json next to the recording): nothing would ever remove it
		// from the bucket.
		file["disable_manifest"] = true
	}
	req := map[string]any{
		"room_name":    room,
		"audio_only":   true,
		"file_outputs": []map[string]any{file},
	}
	if a := out.Audio; a != nil {
		req["advanced"] = map[string]any{"audio_codec": "OPUS", "audio_bitrate": a.BitrateKbps}
	}
	var info EgressInfo
	err := e.call(ctx, "StartRoomCompositeEgress", req, &info)
	if err != nil {
		return nil, err
	}
	return &info, nil
}

func (e *egressClient) StopEgress(ctx context.Context, egressID string) (*EgressInfo, error) {
	var out EgressInfo
	if err := e.call(ctx, "StopEgress", map[string]any{"egress_id": egressID}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (e *egressClient) ListEgress(ctx context.Context, room, egressID string, active bool) ([]EgressInfo, error) {
	in := map[string]any{"active": active}
	if room != "" {
		in["room_name"] = room
	}
	if egressID != "" {
		in["egress_id"] = egressID
	}
	var out struct {
		Items []EgressInfo `json:"items"`
	}
	err := e.call(ctx, "ListEgress", in, &out)
	return out.Items, err
}

// IsEgressGone reports errors that mean the egress no longer runs (not found, or already
// stopped: twirp failed_precondition "egress … cannot be stopped").
func IsEgressGone(err error) bool {
	if IsNotFound(err) {
		return true
	}
	var e *Error
	return errors.As(err, &e) && e.Code == "failed_precondition" && strings.Contains(strings.ToLower(e.Msg), "egress")
}
