package recording

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"slices"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// On-air reports (ADR-0169 §1–2): while a room is recorded every client sends when its own
// microphone was on air (RecordingSpeech over the gateway); they are kept per recording and
// user, in ms from the recording's started_at, and matched to the transcript's speaker numbers
// when it arrives (speakers.go).

const (
	maxSpeechIntervals = 200 // per message; the rest are dropped
	speechMergeGapMs   = 500 // on-air stretches closer than this are one
)

// mergeSpeech clamps the intervals to [lo, hi], sorts them and joins those less than
// speechMergeGapMs apart; empty ones go.
func mergeSpeech(in [][2]int64, lo, hi int64) [][2]int64 {
	out := make([][2]int64, 0, len(in))
	for _, iv := range in {
		a, b := max(iv[0], lo), min(iv[1], hi)
		if b > a {
			out = append(out, [2]int64{a, b})
		}
	}
	slices.SortFunc(out, func(x, y [2]int64) int { return int(x[0] - y[0]) })
	merged := out[:0]
	for _, iv := range out {
		if n := len(merged); n > 0 && iv[0]-merged[n-1][1] < speechMergeGapMs {
			merged[n-1][1] = max(merged[n-1][1], iv[1])
			continue
		}
		merged = append(merged, iv)
	}
	return merged
}

// ReportSpeech keeps one on-air report of user, received at `at` (the gateway's
// RecordingSpeech). Only for a recording of that room in progress (or stopped under a minute
// ago) and from a participant of the room's voice — or one who reported for this recording
// before (the report of a leave arrives when the user may already be out). Best effort: a
// report that does not qualify is dropped silently.
func (s *Service) ReportSpeech(ctx context.Context, user uuid.UUID, m *v1.RecordingSpeech, at time.Time) {
	roomID, err1 := uuid.Parse(m.GetRoomId())
	recID, err2 := uuid.Parse(m.GetRecordingId())
	if err1 != nil || err2 != nil || len(m.GetIntervals()) == 0 {
		return
	}
	rec, err := s.db.Q.GetRecordingForSpeech(ctx, sqlc.GetRecordingForSpeechParams{ID: recID, RoomID: roomID})
	if err != nil {
		if !db.IsNotFound(err) {
			slog.WarnContext(ctx, "recording: speech report", "recording", recID, "err", err)
		}
		return
	}
	if !s.inVoice(ctx, rec, user) {
		return
	}
	hi := at
	if rec.StoppedAt != nil && rec.StoppedAt.Before(hi) {
		hi = *rec.StoppedAt
	}
	end := hi.Sub(rec.StartedAt).Milliseconds()
	ivs := m.GetIntervals()
	if len(ivs) > maxSpeechIntervals {
		ivs = ivs[:maxSpeechIntervals]
	}
	raw := make([][2]int64, 0, len(ivs))
	for _, iv := range ivs {
		// ago → server time → ms from started_at (an error of about half the round trip).
		a := at.Add(-time.Duration(iv.GetAgoStartMs()) * time.Millisecond).Sub(rec.StartedAt).Milliseconds()
		b := at.Add(-time.Duration(iv.GetAgoEndMs()) * time.Millisecond).Sub(rec.StartedAt).Milliseconds()
		raw = append(raw, [2]int64{a, b})
	}
	merged := mergeSpeech(raw, 0, min(end, math.MaxInt32))
	if len(merged) == 0 {
		return
	}
	starts, ends := make([]int32, len(merged)), make([]int32, len(merged))
	for i, iv := range merged {
		starts[i], ends[i] = int32(iv[0]), int32(iv[1]) //nolint:gosec // clamped to MaxInt32
	}
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		_, err := guarded.InsertRecordingSpeech(ctx, sqlc.InsertRecordingSpeechParams{RecordingID: rec.ID, UserID: user, Starts: starts, Ends: ends})
		return err
	}); err != nil && !db.IsForeignKeyViolation(err) {
		slog.WarnContext(ctx, "recording: store speech", "recording", rec.ID, "err", err)
	}
}

// inVoice: the user is connected to the voice of the recording's room, or reported for this
// recording before.
func (s *Service) inVoice(ctx context.Context, rec sqlc.RoomRecording, user uuid.UUID) bool {
	sessions, err := s.voice.List(ctx, rec.WorkspaceID)
	if err != nil {
		slog.WarnContext(ctx, "recording: voice state for a speech report", "recording", rec.ID, "err", err)
		return false
	}
	for _, st := range sessions {
		if st.UserID == user && st.RoomID == rec.RoomID {
			return true
		}
	}
	ok, err := s.db.Q.HasRecordingSpeech(ctx, sqlc.HasRecordingSpeechParams{RecordingID: rec.ID, UserID: user})
	return err == nil && ok
}

// speakerJSON is one entry of room_recordings.speakers_json.
type speakerJSON struct {
	Speaker int    `json:"speaker"`
	UserID  string `json:"user_id,omitempty"`
	Name    string `json:"name,omitempty"`
}

// nameSpeakers matches the transcript's speaker numbers to people from the on-air reports and
// the room's phone calls (ADR-0169 §3–5): it sets the segments' user_id and returns
// speakers_json (nil = nobody identified). Failures leave the transcript numbered.
func (s *Service) nameSpeakers(ctx context.Context, rec sqlc.RoomRecording, segs []segment) []byte {
	if len(segs) == 0 || rec.StartedAt.IsZero() {
		return nil
	}
	rows, err := s.db.Q.ListRecordingSpeech(ctx, rec.ID)
	if err != nil {
		slog.WarnContext(ctx, "recording: speech for speaker names", "recording", rec.ID, "err", err)
		return nil
	}
	// The reports count from started_at; the file from its own start (the egress's).
	var shift int64
	if rec.FileStartedAt != nil {
		shift = rec.StartedAt.Sub(*rec.FileStartedAt).Milliseconds()
	}
	in := matchInput{Segments: make([]matchSegment, len(segs)), Speech: make([]speechSpan, len(rows)),
		DurationMs: int64(rec.DurationSec) * 1000}
	for i, r := range rows {
		in.Speech[i] = speechSpan{User: r.UserID, Start: int64(r.StartMs) + shift, End: int64(r.EndMs) + shift}
	}
	for i, sg := range segs {
		k := -1
		if sg.Speaker != nil {
			k = *sg.Speaker
		}
		in.Segments[i] = matchSegment{Speaker: k, Start: int64(ms(sg.Start)), End: int64(ms(sg.End))}
	}
	if in.DurationMs == 0 {
		in.DurationMs = in.Segments[len(segs)-1].End
	}
	if rec.StoppedAt != nil {
		calls, err := s.db.Q.RecordingPhoneCalls(ctx, sqlc.RecordingPhoneCallsParams{RoomID: rec.RoomID, Since: rec.StartedAt, Until: *rec.StoppedAt})
		if err != nil {
			slog.WarnContext(ctx, "recording: phone calls for speaker names", "recording", rec.ID, "err", err)
		} else if len(calls) == 1 {
			in.Clientless = calls[0]
		}
	}
	out := matchSpeakers(in)
	for i, u := range out.Segments {
		if u != uuid.Nil {
			segs[i].UserID = u.String()
		}
	}
	if len(out.Speakers) == 0 {
		return nil
	}
	list := make([]speakerJSON, 0, len(out.Speakers))
	for k, m := range out.Speakers {
		e := speakerJSON{Speaker: k, Name: m.Name}
		if m.User != uuid.Nil {
			e.UserID = m.User.String()
		}
		list = append(list, e)
	}
	slices.SortFunc(list, func(a, b speakerJSON) int { return a.Speaker - b.Speaker })
	b, err := json.Marshal(list)
	if err != nil {
		return nil
	}
	slog.InfoContext(ctx, "recording: speakers named", "recording", rec.ID, "named", len(list), "reports", len(rows), "offset_ms", out.OffsetMs)
	return b
}
