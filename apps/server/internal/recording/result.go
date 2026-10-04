package recording

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/rooms"
)

// After GPTunneL reports done (docs/09 #47, docs/17) a result job runs for the recording:
//  1. the recording's file becomes the audio attachment of the chat card (a workspace file,
//     audio/mp4, quota as any attachment), kept RECORDING_KEEP_DAYS, then the janitor removes
//     the file and so the attachment;
//  2. the summary and the transcript are copied from GPTunneL's device API and kept here, so
//     the card shows the summary and the transcript panel reads it from us.
//
// GPTunneL without these methods (404), or failing, is asked again with backoff for ~3.5 days;
// then the card stays with «Открыть в GPTunneL» only. Deleting a recording (#50) removes the
// audio, the recording's file, the summary and the transcript, and the recording in GPTunneL.

// AudioMime is the stored type of a recording's audio: LiveKit Egress writes AAC in an MP4
// container (audio only), which <audio> plays in Chromium and WebKit.
const AudioMime = "audio/mp4"

// defaultResultBackoff: waits before the next result attempt (~3.5 days in all); past the end
// the job gives up.
var defaultResultBackoff = []time.Duration{
	time.Minute, 5 * time.Minute, 30 * time.Minute, 2 * time.Hour, 6 * time.Hour, 12 * time.Hour,
	24 * time.Hour, 24 * time.Hour, 24 * time.Hour,
}

// SetFiles gives the service the file store for audio attachments (nil = no audio kept).
func (s *Service) SetFiles(f *files.Service) { s.files = f }

// cardOf is the chat card of rec with this server's configuration applied: the web link on
// GPTUNNEL_WEB_URL and the audio's expiry.
func (s *Service) cardOf(rec sqlc.RoomRecording) *v1.SystemMessage {
	msg := pbconv.RecordingCard(rec)
	c := msg.GetRecording()
	c.WebUrl = gptunnel.NormalizeWebURL(c.GetWebUrl(), s.cfg.WebURL)
	if rec.FileID != nil && rec.DoneAt != nil && rec.DeletedAt == nil {
		c.AudioUntil = timestamppb.New(rec.DoneAt.Add(s.KeepAudio))
	}
	return msg
}

// processResults runs due result jobs.
func (s *Service) processResults(ctx context.Context) (int, error) {
	done := 0
	for range 5 {
		rows, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) ([]sqlc.RoomRecording, error) {
			return guarded.ClaimRecordingResults(ctx, sqlc.ClaimRecordingResultsParams{
				Lease: pgtype.Interval{Microseconds: s.Lease.Microseconds(), Valid: true}, Lim: 2,
			})
		})
		if err != nil {
			return done, err
		}
		for _, row := range rows {
			if ctx.Err() != nil {
				return done, ctx.Err()
			}
			s.result(ctx, row)
			done++
		}
		if len(rows) < 2 {
			return done, nil
		}
	}
	return done, nil
}

// result runs one attempt of the result job of a done recording.
func (s *Service) result(ctx context.Context, rec sqlc.RoomRecording) {
	last := int(rec.ResultAttempts) >= len(s.ResultBackoff)
	rec, again := s.attachAudio(ctx, rec)
	if again && !last {
		s.retryResult(ctx, rec, errors.New("audio not attached yet"))
		return
	}
	token, sealed, err := s.deviceToken(ctx, rec.WorkspaceID)
	if err != nil {
		s.retryResult(ctx, rec, err)
		return
	}
	if token == "" || rec.GptunnelID == "" {
		s.finishResult(ctx, rec, "", "", nil, "unavailable")
		return
	}
	res, err := s.gpt.Result(ctx, token, rec.GptunnelID)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		if e, ok := gptunnel.AsError(err); ok && e.Unauthorized() {
			s.forgetToken(ctx, rec, sealed)
			s.finishResult(ctx, rec, "", "", nil, "unavailable")
			return
		}
		s.retryResult(ctx, rec, err) // 404 = an older GPTunneL without the method: asked again later
		return
	}
	summary := clip(strings.TrimSpace(deref(res.Summary)), 50000)
	lang := clip(deref(res.Language), 16)
	var transcript []byte
	if res.TranscriptSegments != nil && *res.TranscriptSegments > 0 {
		tl, segs, err := s.gpt.Transcript(ctx, token, rec.GptunnelID)
		switch e, ok := gptunnel.AsError(err); {
		case err == nil:
			if tl != "" {
				lang = clip(tl, 16)
			}
			if transcript, err = marshalTranscript(segs); err != nil {
				slog.WarnContext(ctx, "recording: encode transcript", "recording", rec.ID, "err", err)
			}
		case ctx.Err() != nil:
			return
		case ok && (e.Retryable() || e.Code == gptunnel.CodeNotReady) && !last:
			s.retryResult(ctx, rec, err)
			return
		default:
			slog.WarnContext(ctx, "recording: no transcript from GPTunneL", "recording", rec.ID, "err", err)
		}
	}
	s.finishResult(ctx, rec, summary, lang, transcript, "ready")
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// segment is a transcript remark as kept in room_recordings.transcript_json (GPTunneL's shape).
type segment struct {
	Speaker *int    `json:"speaker"`
	Start   float64 `json:"start"`
	End     float64 `json:"end"`
	Text    string  `json:"text"`
}

func finite(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) || f < 0 {
		return 0
	}
	return math.Min(f, float64(math.MaxUint32/1000))
}

// marshalTranscript keeps what GPTunneL gave, sanitized: valid UTF-8, bounded texts and times.
func marshalTranscript(in []gptunnel.Segment) ([]byte, error) {
	out := make([]segment, 0, len(in))
	for _, sg := range in {
		text := strings.TrimSpace(strings.ToValidUTF8(sg.Text, ""))
		if text == "" {
			continue
		}
		if utf8.RuneCountInString(text) > 10000 {
			text = string([]rune(text)[:10000])
		}
		var sp *int
		if sg.Speaker != nil && *sg.Speaker >= 0 && *sg.Speaker < 1000 {
			v := *sg.Speaker
			sp = &v
		}
		start := finite(sg.Start)
		out = append(out, segment{Speaker: sp, Start: start, End: math.Max(start, finite(sg.End)), Text: text})
	}
	return json.Marshal(out)
}

func (s *Service) retryResult(ctx context.Context, rec sqlc.RoomRecording, cause error) {
	n := int(rec.ResultAttempts)
	if n >= len(s.ResultBackoff) {
		slog.WarnContext(ctx, "recording: giving up the result", "recording", rec.ID, "err", cause)
		s.finishResult(ctx, rec, "", "", nil, "unavailable")
		return
	}
	next := s.Now().Add(s.ResultBackoff[n])
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.RetryRecordingResult(ctx, sqlc.RetryRecordingResultParams{ID: rec.ID, ResultNextAt: &next})
	}); err != nil {
		slog.WarnContext(ctx, "recording: schedule result", "recording", rec.ID, "err", err)
	}
	slog.InfoContext(ctx, "recording: result not available yet", "recording", rec.ID, "attempt", n+1, "next_at", next, "err", cause)
}

func (s *Service) finishResult(ctx context.Context, rec sqlc.RoomRecording, summary, lang string, transcript []byte, state string) {
	upd, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
		return guarded.SetRecordingResult(ctx, sqlc.SetRecordingResultParams{
			ID: rec.ID, Summary: summary, Language: lang, TranscriptJson: transcript, ResultState: state,
		})
	})
	if db.IsNotFound(err) {
		return // deleted meanwhile
	}
	if err != nil {
		slog.WarnContext(ctx, "recording: store result", "recording", rec.ID, "err", err)
		return
	}
	slog.InfoContext(ctx, "recording result", "recording", rec.ID, "state", state, "summary", summary != "", "transcript", transcript != nil)
	s.removeFile(ctx, upd) // kept as the attachment now (or not kept): the recording's file goes
	s.card(ctx, upd)
}

// forgetToken drops a device token GPTunneL no longer accepts (revoked there).
func (s *Service) forgetToken(ctx context.Context, rec sqlc.RoomRecording, sealed []byte) {
	if _, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.RevokeIntegration(ctx, sqlc.RevokeIntegrationParams{WorkspaceID: rec.WorkspaceID, Kind: kindGPTunnel, TokenEnc: sealed})
	}); err != nil {
		slog.WarnContext(ctx, "recording: forget a revoked device token", "workspace", rec.WorkspaceID, "err", err)
	}
}

// attachAudio makes the recording's file the audio attachment of the card; again = a transient
// failure worth another attempt. A file that does not fit the quota is not kept (logged).
func (s *Service) attachAudio(ctx context.Context, rec sqlc.RoomRecording) (sqlc.RoomRecording, bool) {
	if s.files == nil || rec.FileID != nil || rec.MessageID == nil || rec.StartedBy == nil || !pbconv.RecordingHasFile(rec) {
		return rec, false
	}
	f, size, err := s.store.open(ctx, rec.File)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.WarnContext(ctx, "recording: open file to keep", "recording", rec.ID, "err", err)
		}
		return rec, errors.Is(err, errUnavailable)
	}
	defer func() { _ = f.Close() }()
	if size == 0 {
		return rec, false
	}
	name := "Calab"
	if room, err := s.db.Q.GetRoom(ctx, rec.RoomID); err == nil {
		name = room.Name
	}
	name += " " + rec.StartedAt.UTC().Format("2006-01-02 15-04") + ".m4a"
	file, err := s.files.StoreSystemFile(ctx, rec.WorkspaceID, *rec.StartedBy, name, AudioMime, f, size)
	if errors.Is(err, files.ErrNoRoom) {
		slog.WarnContext(ctx, "recording: no room to keep the audio", "recording", rec.ID, "bytes", size)
		return rec, false
	}
	if err != nil {
		slog.WarnContext(ctx, "recording: keep the audio", "recording", rec.ID, "err", err)
		return rec, true
	}
	var upd sqlc.RoomRecording
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.InsertAttachment(ctx, sqlc.InsertAttachmentParams{MessageID: *rec.MessageID, FileID: file.ID, Position: 0}); err != nil {
			return err
		}
		// A forward in flight either sees the attachment or its copy exists for the next statement.
		if err := q.LockMessage(ctx, *rec.MessageID); err != nil {
			return err
		}
		// Copies forwarded before the audio was kept show it too (ADR-0033 §4).
		if err := q.AttachToForwardedCopies(ctx, sqlc.AttachToForwardedCopiesParams{FileID: file.ID, MessageID: *rec.MessageID}); err != nil {
			return err
		}
		upd, err = q.SetRecordingAudio(ctx, sqlc.SetRecordingAudioParams{ID: rec.ID, FileID: &file.ID})
		return err
	})
	if err != nil {
		if derr := s.files.DeleteFile(ctx, file.ID); derr != nil {
			slog.WarnContext(ctx, "recording: drop an unattached audio file", "file", file.ID, "err", derr)
		}
		if db.IsNotFound(err) || db.IsForeignKeyViolation(err) || db.UniqueViolation(err) != "" {
			return rec, false // deleted meanwhile, the card is gone, or attached already
		}
		slog.WarnContext(ctx, "recording: attach the audio", "recording", rec.ID, "err", err)
		return rec, true
	}
	slog.InfoContext(ctx, "recording: audio kept", "recording", rec.ID, "file", file.ID, "bytes", size)
	return upd, false
}

// expireAudio removes audio attachments older than RECORDING_KEEP_DAYS (the file, and with it
// the attachment) and updates their cards.
func (s *Service) expireAudio(ctx context.Context) {
	if s.files == nil {
		return
	}
	rows, err := s.db.Q.ListExpiredRecordingAudio(ctx, new(s.Now().Add(-s.KeepAudio)))
	if err != nil {
		slog.WarnContext(ctx, "recording: list expired audio", "err", err)
		return
	}
	for _, rec := range rows {
		if err := s.files.DeleteFile(ctx, *rec.FileID); err != nil { // file_id → NULL (ON DELETE SET NULL)
			slog.WarnContext(ctx, "recording: remove expired audio", "recording", rec.ID, "err", err)
			continue
		}
		rec.FileID = nil
		slog.InfoContext(ctx, "recording: audio expired", "recording", rec.ID)
		s.card(ctx, rec)
	}
}

// ---- endpoints ----

// roomRecording returns the recording {rid} of the room {id} the caller sees (VIEW_ROOM; 404
// otherwise, and for a deleted one).
func (s *Service) roomRecording(r *http.Request) (sqlc.RoomRecording, perm.RoomAccess, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return sqlc.RoomRecording{}, perm.RoomAccess{}, err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return sqlc.RoomRecording{}, acc, err
	}
	if acc.DM {
		return sqlc.RoomRecording{}, acc, httpx.NotFound("room")
	}
	rid, err := httpx.PathUUID(r, "rid", "recording")
	if err != nil {
		return sqlc.RoomRecording{}, acc, err
	}
	rec, err := s.db.Q.GetRecording(r.Context(), rid)
	if db.IsNotFound(err) || (err == nil && (rec.RoomID != roomID || rec.DeletedAt != nil)) {
		return rec, acc, httpx.NotFound("recording")
	}
	return rec, acc, err
}

// visibleRecording returns the recording {rid} whose card the caller sees in the room {id}
// (VIEW_ROOM): the room of the recording, or a room (a DM too) holding a live forwarded copy
// of its card (ADR-0033 §4). 404 otherwise, and for a deleted one.
func (s *Service) visibleRecording(r *http.Request) (sqlc.RoomRecording, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return sqlc.RoomRecording{}, err
	}
	if _, err := rooms.Access(r, roomID); err != nil {
		return sqlc.RoomRecording{}, err
	}
	rid, err := httpx.PathUUID(r, "rid", "recording")
	if err != nil {
		return sqlc.RoomRecording{}, err
	}
	rec, err := s.db.Q.GetRecording(r.Context(), rid)
	if db.IsNotFound(err) || (err == nil && rec.DeletedAt != nil) {
		return rec, httpx.NotFound("recording")
	}
	if err != nil {
		return rec, err
	}
	ok, err := visibleIn(r.Context(), s.db, rec.ID, roomID) // the rule search uses too (VisibleSQL)
	if err == nil && !ok {
		err = httpx.NotFound("recording")
	}
	return rec, err
}

// transcript: GET /api/rooms/{id}/recordings/{rid}/transcript.
func (s *Service) transcript(w http.ResponseWriter, r *http.Request) error {
	rec, err := s.visibleRecording(r)
	if err != nil {
		return err
	}
	row, err := s.db.Q.GetRecordingTranscript(r.Context(), sqlc.GetRecordingTranscriptParams{ID: rec.ID, RoomID: rec.RoomID})
	if db.IsNotFound(err) {
		return httpx.NotFound("transcript")
	}
	if err != nil {
		return err
	}
	var segs []segment
	if err := json.Unmarshal(row.TranscriptJson, &segs); err != nil {
		return err
	}
	out := &v1.GetRecordingTranscriptResponse{RecordingId: rec.ID.String(), Language: row.Language,
		Segments: make([]*v1.TranscriptSegment, 0, len(segs))}
	for _, sg := range segs {
		speaker := int32(-1)
		if sg.Speaker != nil {
			speaker = int32(min(max(*sg.Speaker, 0), 999)) //nolint:gosec // bounded
		}
		out.Segments = append(out.Segments, &v1.TranscriptSegment{Speaker: speaker, StartMs: ms(sg.Start), EndMs: ms(sg.End), Text: sg.Text})
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func ms(sec float64) uint32 { return uint32(math.Round(finite(sec) * 1000)) } //nolint:gosec // finite() bounds it

var errStillRecording = httpx.Conflict("the meeting is still being recorded: stop the recording first")

// remove: DELETE /api/rooms/{id}/recordings/{rid} (docs/09 #50): who started it, the owner,
// MANAGE_MESSAGES in the room, or MANAGE_RECORDINGS (ADR-0048) — always in a room the caller
// sees (roomRecording: a closed room is 404 without an override).
func (s *Service) remove(w http.ResponseWriter, r *http.Request) error {
	rec, acc, err := s.roomRecording(r)
	if err != nil {
		return err
	}
	me := uid(r)
	starter := rec.StartedBy != nil && *rec.StartedBy == me
	if !starter && acc.Role != perm.RoleOwner && !acc.Bits.Has(perm.ManageMessages) &&
		(acc.Role == perm.RoleGuest || !acc.Member.Workspace().Has(perm.ManageRecordings)) {
		return httpx.Forbidden("only who started the recording, the owner, MANAGE_MESSAGES or MANAGE_RECORDINGS")
	}
	if rec.Status == "pending" || rec.Status == "recording" {
		return errStillRecording
	}
	ctx := r.Context()
	upd, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
		return guarded.DeleteRecording(ctx, sqlc.DeleteRecordingParams{ID: rec.ID, DeletedBy: &me})
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("recording") // deleted (or started again?) meanwhile
	}
	if err != nil {
		return err
	}
	bg := context.WithoutCancel(ctx)
	if rec.FileID != nil && s.files != nil {
		if err := s.files.DeleteFile(bg, *rec.FileID); err != nil {
			slog.WarnContext(ctx, "recording: delete the audio", "recording", rec.ID, "err", err)
		}
	}
	if pbconv.RecordingHasFile(upd) {
		if err := s.store.remove(bg, upd.File); err != nil {
			slog.WarnContext(ctx, "recording: delete the recording's file (the janitor retries)", "recording", rec.ID, "err", err)
		} else if err := db.GuardExec(bg, s.db, func(guarded *sqlc.Queries) error { return guarded.MarkRecordingFileDeleted(bg, upd.ID) }); err != nil {
			slog.WarnContext(ctx, "recording: mark file deleted", "recording", rec.ID, "err", err)
		}
	}
	if upd.GptunnelID != "" {
		s.deleteRemote(bg, upd)
	}
	slog.InfoContext(ctx, "recording deleted", "recording", upd.ID, "by", me)
	s.card(bg, upd)
	httpx.NoContent(w)
	return nil
}

// deleteRemote deletes the recording in GPTunneL too, best effort (docs/17 §2).
func (s *Service) deleteRemote(ctx context.Context, rec sqlc.RoomRecording) {
	token, _, err := s.deviceToken(ctx, rec.WorkspaceID)
	if err != nil || token == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := s.gpt.DeleteRecording(ctx, token, rec.GptunnelID); err != nil {
		slog.WarnContext(ctx, "recording: delete in GPTunneL", "recording", rec.ID, "gptunnel_id", rec.GptunnelID, "err", err)
	}
}
