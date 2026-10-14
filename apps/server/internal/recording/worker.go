package recording

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/voice"
)

// ---- egress events ----

// HandleEgress applies an egress webhook event (rtc.Service.OnEgress). Only the end
// matters: the file is taken over and queued for upload.
func (s *Service) HandleEgress(ctx context.Context, event string, info *rtc.EgressInfo) error {
	if event != rtc.EventEgressEnded && !info.Ended() {
		return nil
	}
	rec, err := s.db.Q.GetRecordingByEgress(ctx, &info.EgressID)
	if db.IsNotFound(err) {
		return nil // not ours, or the start is not committed yet (reconcile takes it)
	}
	if err != nil {
		return err
	}
	return s.finish(ctx, rec, info, "egress")
}

// finish takes over a recording whose egress ended: with a file it goes to the upload queue,
// without one it failed. The volume (or the bucket) is the source of truth for the file (the
// egress may report a file it could not write or upload, or none after a crash). A bucket that
// does not answer decides nothing — the row stays and the reconcile takes it again — until
// StorageWait has passed: then it failed, so the room may record again.
func (s *Service) finish(ctx context.Context, rec sqlc.RoomRecording, info *rtc.EgressInfo, reason string) error {
	if rec.Status != "pending" && rec.Status != "recording" {
		return nil // already taken over (webhook redelivery, reconcile)
	}
	size, err := s.store.stat(ctx, rec.File)
	unavailable := errors.Is(err, errUnavailable)
	if unavailable && !s.storageWaitOver(rec) {
		return err
	}
	if err != nil {
		size = 0
	}
	var upd sqlc.RoomRecording
	if unavailable {
		slog.WarnContext(ctx, "recording: file storage did not answer, giving up", "recording", rec.ID, "err", err)
		upd, err = db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
			return guarded.MarkRecordingFailed(ctx, sqlc.MarkRecordingFailedParams{ID: rec.ID, Error: "recorder_failed", StopReason: reason})
		})
	} else if size > 0 {
		dur := s.Now().Sub(rec.StartedAt)
		if f := info.File(); f.Duration > 0 {
			dur = f.Duration
		}
		upd, err = db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
			return guarded.MarkRecordingEnded(ctx, sqlc.MarkRecordingEndedParams{
				ID: rec.ID, SizeBytes: size, DurationSec: int32(min(max(dur.Round(time.Second)/time.Second, 1), 1<<30)), //nolint:gosec // bounded
				StopReason: reason,
			})
		})
	} else {
		code := "recorder_failed"
		if info.Status == rtc.EgressComplete || info.Status == rtc.EgressLimitReached {
			code = "no_audio"
		}
		slog.WarnContext(ctx, "recording: egress ended without a file", "recording", rec.ID, "status", info.Status, "error", info.Error)
		upd, err = db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
			return guarded.MarkRecordingFailed(ctx, sqlc.MarkRecordingFailedParams{ID: rec.ID, Error: code, StopReason: reason})
		})
	}
	if db.IsNotFound(err) {
		return nil // concurrently taken over
	}
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "recording ended", "recording", upd.ID, "status", upd.Status, "bytes", size, "egress_status", info.Status)
	if rec.StoppedAt == nil {
		s.publish(ctx, pbconv.RoomRecording(upd)) // ended by itself: the indicator goes away now
	}
	s.card(ctx, upd)
	s.Wake()
	return nil
}

// storageWaitOver reports that an ended recording has waited StorageWait for its file's
// storage to answer: counted from the stop, or for a recording that ended by itself from the
// latest it could have run.
func (s *Service) storageWaitOver(rec sqlc.RoomRecording) bool {
	end := rec.StartedAt.Add(gptunnel.MaxDuration)
	if rec.StoppedAt != nil && rec.StoppedAt.Before(end) {
		end = *rec.StoppedAt
	}
	return s.Now().Sub(end) > s.StorageWait
}

// card posts the recording's chat card, or updates it.
func (s *Service) card(ctx context.Context, rec sqlc.RoomRecording) {
	if rec.StartedBy == nil {
		return // the author's account is gone: a system message needs one
	}
	payload := s.cardOf(rec)
	if rec.MessageID != nil {
		if err := s.system.Update(ctx, rec.WorkspaceID, *rec.MessageID, payload); err != nil {
			slog.WarnContext(ctx, "recording: update chat card", "recording", rec.ID, "err", err)
		}
		return
	}
	id, err := s.system.Post(ctx, rec.WorkspaceID, rec.RoomID, *rec.StartedBy, payload)
	if err != nil {
		slog.WarnContext(ctx, "recording: post chat card", "recording", rec.ID, "err", err)
		return
	}
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.SetRecordingMessage(ctx, sqlc.SetRecordingMessageParams{ID: rec.ID, MessageID: &id})
	}); err != nil {
		slog.WarnContext(ctx, "recording: remember chat card", "recording", rec.ID, "err", err)
	}
}

// ---- worker ----

// Wake makes the worker look for due jobs now (if this instance holds the lock).
func (s *Service) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

var lockScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`)

const lockKey = "rec:worker"

func (s *Service) lock(ctx context.Context) bool {
	n, err := lockScript.Exec(ctx, s.redis, []string{redisx.Key(lockKey)}, []string{s.token, fmt.Sprint(s.LockTTL.Milliseconds())}).AsInt64()
	if err != nil {
		slog.WarnContext(ctx, "recording: worker lock", "err", err)
		return false
	}
	return n == 1
}

// Run is the worker loop until ctx is done. Only the holder of the Valkey lock works:
// uploads and status polls, auto-stop and reconcile (every 15 s), the file janitor (hourly).
// Uploads run in their own goroutine: a large file or a slow GPTunneL must not hold up the
// auto-stop (the 4 h limit), the reconcile or the renewal of the lock.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(s.Tick)
	defer t.Stop()
	jobs := make(chan struct{}, 1)
	go s.runJobs(ctx, jobs)
	var lastMaintain, lastJanitor time.Time
	for {
		if s.lock(ctx) {
			select {
			case jobs <- struct{}{}:
			default: // a run is in progress or already queued
			}
			if time.Since(lastMaintain) >= min(15*time.Second, s.Tick*3) {
				lastMaintain = time.Now()
				s.Maintain(ctx)
			}
			if time.Since(lastJanitor) > time.Hour {
				lastJanitor = time.Now()
				s.Janitor(ctx)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.wake:
		}
	}
}

// runJobs processes the queue each time Run signals it (while holding the lock).
func (s *Service) runJobs(ctx context.Context, jobs <-chan struct{}) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-jobs:
		}
		if _, err := s.ProcessOnce(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "recording: process queue", "err", err)
		}
	}
}

// ProcessOnce runs due uploads and status polls; the caller should hold the worker lock
// (claimed rows are leased, so a second worker does not take them anyway).
func (s *Service) ProcessOnce(ctx context.Context) (int, error) {
	done := 0
	for range 10 {
		rows, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) ([]sqlc.RoomRecording, error) {
			return guarded.ClaimRecordingJobs(ctx, sqlc.ClaimRecordingJobsParams{
				Lease: pgtype.Interval{Microseconds: s.Lease.Microseconds(), Valid: true}, Lim: 4,
			})
		})
		if err != nil {
			return done, err
		}
		for _, row := range rows {
			if ctx.Err() != nil {
				return done, ctx.Err()
			}
			switch row.Status {
			case "uploading":
				s.upload(ctx, row)
			case "processing":
				s.poll(ctx, row)
			}
			done++
		}
		if len(rows) < 4 {
			break
		}
	}
	n, err := s.processResults(ctx)
	return done + n, err
}

// backoff before retry number attempt+1: 30 s doubling, capped at 30 min.
func backoff(attempt int32) time.Duration {
	if attempt >= 6 {
		return 30 * time.Minute
	}
	return min(30*time.Second<<attempt, 30*time.Minute)
}

// failCodes: GPTunneL errors that end the recording at once, reported as they are.
var failCodes = map[string]bool{
	gptunnel.CodeInsufficientBalance: true, gptunnel.CodeTooLarge: true, "account_unavailable": true,
}

func (s *Service) fail(ctx context.Context, rec sqlc.RoomRecording, code string) {
	upd, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
		return guarded.MarkRecordingFailed(ctx, sqlc.MarkRecordingFailedParams{ID: rec.ID, Error: clip(code, 500), StopReason: "egress"})
	})
	if db.IsNotFound(err) {
		return
	}
	if err != nil {
		slog.WarnContext(ctx, "recording: mark failed", "recording", rec.ID, "err", err)
		return
	}
	slog.WarnContext(ctx, "recording failed", "recording", rec.ID, "error", code)
	s.card(ctx, upd)
}

// remoteError handles an error of a GPTunneL call; it returns true when the recording
// failed for good (else the job is retried later).
func (s *Service) remoteError(ctx context.Context, rec sqlc.RoomRecording, sealed []byte, err error) bool {
	e, ok := gptunnel.AsError(err)
	switch {
	case ok && e.Unauthorized():
		// The device was revoked in GPTunneL: the workspace is no longer connected.
		if _, rerr := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (int64, error) {
			return guarded.RevokeIntegration(ctx, sqlc.RevokeIntegrationParams{WorkspaceID: rec.WorkspaceID, Kind: kindGPTunnel, TokenEnc: sealed})
		}); rerr != nil {
			slog.WarnContext(ctx, "recording: forget a revoked device token", "workspace", rec.WorkspaceID, "err", rerr)
		}
		s.fail(ctx, rec, "device_revoked")
		return true
	case ok && failCodes[e.Code]:
		s.fail(ctx, rec, e.Code)
		return true
	case ok && !e.Retryable() && e.Code != gptunnel.CodeTooManyUploads && e.Code != gptunnel.CodeOffsetMismatch && e.Code != gptunnel.CodeIncomplete:
		s.fail(ctx, rec, "upload_failed")
		return true
	}
	return false
}

func (s *Service) retry(ctx context.Context, rec sqlc.RoomRecording, cause error) {
	next := s.Now().Add(backoff(rec.Attempts))
	since := rec.StoppedAt
	if rec.ReuploadAt != nil {
		since = rec.ReuploadAt // sent again: the window starts anew
	}
	if since != nil && next.After(since.Add(s.UploadFor)) {
		slog.WarnContext(ctx, "recording: giving up the upload", "recording", rec.ID, "err", cause)
		s.fail(ctx, rec, "upload_failed")
		return
	}
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.RetryRecording(ctx, sqlc.RetryRecordingParams{ID: rec.ID, NextAt: &next, Error: clip(cause.Error(), 500)})
	}); err != nil {
		slog.WarnContext(ctx, "recording: schedule retry", "recording", rec.ID, "err", err)
	}
	slog.WarnContext(ctx, "recording: upload failed, will retry", "recording", rec.ID, "attempt", rec.Attempts+1, "next_at", next, "err", cause)
}

func (s *Service) upload(ctx context.Context, rec sqlc.RoomRecording) {
	token, sealed, err := s.deviceToken(ctx, rec.WorkspaceID)
	if err != nil {
		s.retry(ctx, rec, err)
		return
	}
	if token == "" {
		s.fail(ctx, rec, "not_paired")
		return
	}
	f, size, err := s.store.open(ctx, rec.File)
	if errors.Is(err, errUnavailable) {
		s.retry(ctx, rec, err)
		return
	}
	if err != nil {
		slog.WarnContext(ctx, "recording: open file", "recording", rec.ID, "err", err)
		s.fail(ctx, rec, "upload_failed")
		return
	}
	defer func() { _ = f.Close() }()
	if size == 0 {
		s.fail(ctx, rec, "no_audio")
		return
	}
	if size > gptunnel.MaxBytes || time.Duration(rec.DurationSec)*time.Second > gptunnel.MaxDuration {
		// GPTunneL rejects it anyway: do not send gigabytes first.
		slog.WarnContext(ctx, "recording: over GPTunneL's limits", "recording", rec.ID, "bytes", size, "duration_sec", rec.DurationSec)
		s.fail(ctx, rec, gptunnel.CodeTooLarge)
		return
	}
	title := "Calab"
	if room, err := s.db.Q.GetRoom(ctx, rec.RoomID); err == nil {
		title = room.Name
	}
	title += " · " + rec.StartedAt.UTC().Format("2006-01-02 15:04") + " UTC"
	// GPTunneL's create is idempotent on client_id: a re-upload needs a new one to get a new
	// recording there (the old one failed).
	clientID := rec.ID.String()
	if rec.Reuploads > 0 {
		clientID += fmt.Sprintf("#%d", rec.Reuploads)
	}
	req := gptunnel.CreateRequest{
		ClientID: clientID, Title: title, Kind: "video", Mime: "video/mp4", SizeBytes: size,
		DurationSec: int64(max(rec.DurationSec, 1)), StartedAt: rec.StartedAt.UTC().Format(time.RFC3339),
	}
	res, err := s.gpt.Upload(ctx, token, f, req, rec.GptunnelID, func(id string) error {
		return db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
			return guarded.SetRecordingGptunnelID(ctx, sqlc.SetRecordingGptunnelIDParams{ID: rec.ID, GptunnelID: id})
		})
	})
	if err != nil {
		if ctx.Err() != nil {
			return // shutting down: the lease runs out and another attempt resumes
		}
		if !s.remoteError(ctx, rec, sealed, err) {
			s.retry(ctx, rec, err)
		}
		return
	}
	next := s.Now().Add(s.PollMin)
	upd, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
		return guarded.MarkRecordingProcessing(ctx, sqlc.MarkRecordingProcessingParams{ID: rec.ID, GptunnelID: res.ID, WebUrl: clip(res.WebURL, 2000), NextAt: &next})
	})
	if err != nil {
		slog.WarnContext(ctx, "recording: mark processing", "recording", rec.ID, "err", err)
		return
	}
	slog.InfoContext(ctx, "recording uploaded", "recording", rec.ID, "gptunnel_id", res.ID, "bytes", size)
	if !s.applyStatus(ctx, upd, res) {
		s.card(ctx, upd)
	}
}

// applyStatus handles a final GPTunneL status (done / failed / cancelled); false = still
// processing.
func (s *Service) applyStatus(ctx context.Context, rec sqlc.RoomRecording, st *gptunnel.RecordingStatus) bool {
	switch st.Status {
	case gptunnel.StatusDone:
		upd, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
			return guarded.MarkRecordingDone(ctx, sqlc.MarkRecordingDoneParams{ID: rec.ID, WebUrl: clip(st.WebURL, 2000)})
		})
		if err != nil {
			if !db.IsNotFound(err) {
				slog.WarnContext(ctx, "recording: mark done", "recording", rec.ID, "err", err)
			}
			return true
		}
		slog.InfoContext(ctx, "recording done", "recording", rec.ID)
		s.card(ctx, upd)
		s.Wake() // the result job: keep the audio, fetch the summary and transcript
		return true
	case gptunnel.StatusFailed, gptunnel.StatusCancelled:
		if transientFailure(st) {
			return false // GPTunneL's own fault: they retry or fix it, keep polling until PollFor
		}
		code := st.ErrorCode()
		if code == "" {
			code = st.Status
		}
		if st.WebURL != "" && rec.WebUrl == "" {
			rec.WebUrl = st.WebURL
		}
		s.fail(ctx, rec, code)
		return true
	}
	return false
}

// transientFailure: a "failed" status caused by an internal error of GPTunneL, which may be
// fixed there — not final while the poll window lasts (backlog 40).
func transientFailure(st *gptunnel.RecordingStatus) bool {
	return st.Status == gptunnel.StatusFailed && st.ErrorCode() == gptunnel.CodeInternal
}

func (s *Service) poll(ctx context.Context, rec sqlc.RoomRecording) {
	token, sealed, err := s.deviceToken(ctx, rec.WorkspaceID)
	if err == nil && token == "" {
		s.fail(ctx, rec, "not_paired")
		return
	}
	var st *gptunnel.RecordingStatus
	if err == nil {
		st, err = s.gpt.Recording(ctx, token, rec.GptunnelID)
	}
	if err != nil {
		if ctx.Err() != nil || s.remoteError(ctx, rec, sealed, err) {
			return
		}
		st = nil
	}
	if st != nil && s.applyStatus(ctx, rec, st) {
		return
	}
	since := rec.UpdatedAt
	if rec.ProcessingSince != nil {
		since = *rec.ProcessingSince
	}
	elapsed := s.Now().Sub(since)
	if elapsed > s.PollFor {
		code := "timeout"
		if st != nil && transientFailure(st) {
			code = st.ErrorCode() // still failing on GPTunneL's side: say so on the card
		}
		s.fail(ctx, rec, code)
		return
	}
	// Transcription takes minutes: poll often at first, then every 5 min at most.
	next := s.Now().Add(min(max(elapsed/4, s.PollMin), 5*time.Minute))
	web := ""
	if st != nil {
		web = clip(st.WebURL, 2000)
	}
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.PollRecordingLater(ctx, sqlc.PollRecordingLaterParams{ID: rec.ID, NextAt: &next, WebUrl: web})
	}); err != nil {
		slog.WarnContext(ctx, "recording: schedule poll", "recording", rec.ID, "err", err)
	}
}

// ---- maintenance: auto-stop, reconcile, janitor ----

// Maintain stops recordings that must end (4 h, nobody in the call for 2 min, recording
// forbidden in the room), repeats stops the egress did not confirm, and reconciles the
// database with the egresses LiveKit reports.
func (s *Service) Maintain(ctx context.Context) {
	rows, err := s.db.Q.ListActiveRecordings(ctx, nil)
	if err != nil {
		slog.WarnContext(ctx, "recording: list active", "err", err)
		return
	}
	now := s.Now()
	var rids []uuid.UUID
	for _, r := range rows {
		rids = append(rids, r.RoomID)
	}
	started, err := s.voice.StartedAt(ctx, rids)
	if err != nil {
		slog.WarnContext(ctx, "recording: read calls", "err", err)
		started = nil
	}
	for _, rec := range rows {
		if rec.Status != "recording" {
			continue
		}
		if rec.StoppedAt != nil {
			// Stop requested but the egress has not ended: ask again every minute.
			if now.Sub(*rec.StoppedAt) > time.Minute && rec.EgressID != nil && s.eg != nil {
				s.stopEgress(ctx, *rec.EgressID, rec.StopReason, "maintain: repeat stop", "recording", rec.ID, "stopped_at", *rec.StoppedAt)
			}
			continue
		}
		reason := ""
		switch {
		case now.Sub(rec.StartedAt) >= s.MaxDuration:
			reason = "max_duration"
		case !s.roomAllows(ctx, rec.RoomID):
			reason = "disabled"
		case s.PlanInactive != nil && s.PlanInactive(ctx, rec.WorkspaceID):
			reason = StopPlanInactive
		case started != nil:
			if _, busy := started[rec.RoomID]; busy {
				if rec.EmptySince != nil {
					_ = db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
						return guarded.SetRecordingEmptySince(ctx, sqlc.SetRecordingEmptySinceParams{ID: rec.ID, EmptySince: nil})
					})
				}
			} else if rec.EmptySince == nil {
				_ = db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error {
					return guarded.SetRecordingEmptySince(ctx, sqlc.SetRecordingEmptySinceParams{ID: rec.ID, EmptySince: &now})
				})
			} else if now.Sub(*rec.EmptySince) >= s.EmptyTimeout {
				reason = "empty"
			}
		}
		if reason != "" {
			if _, err := s.requestStop(ctx, rec, reason, nil); err != nil {
				slog.WarnContext(ctx, "recording: auto-stop", "recording", rec.ID, "reason", reason, "err", err)
			}
		}
	}
	if err := s.Reconcile(ctx); err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "recording: reconcile", "err", err)
	}
}

func (s *Service) roomAllows(ctx context.Context, rid uuid.UUID) bool {
	room, err := s.db.Q.GetRoom(ctx, rid)
	if db.IsNotFound(err) {
		return false // archived
	}
	return err != nil || room.AllowRecording // unknown: keep recording
}

// Reconcile brings the database in line with LiveKit's egresses (missed webhooks, restarts):
// rows whose egress is gone are taken over (file on the volume → upload, else failed),
// starts that never reached the egress fail, and our egresses without a running row are
// stopped.
func (s *Service) Reconcile(ctx context.Context) error {
	rows, err := s.db.Q.ListActiveRecordings(ctx, nil)
	if err != nil {
		return err
	}
	now := s.Now()
	if stale, err := s.db.Q.ListStalePendingRecordings(ctx, now.Add(-2*time.Minute)); err == nil {
		for _, rec := range stale {
			s.finishWithout(ctx, rec, "lost")
		}
	}
	if s.eg == nil {
		return nil
	}
	active, err := s.eg.ListEgress(ctx, "", "", true)
	if err != nil {
		if len(rows) == 0 {
			slog.DebugContext(ctx, "recording: list egress", "err", err)
			return nil
		}
		return err
	}
	running := map[string]rtc.EgressInfo{}
	for _, e := range active {
		running[e.EgressID] = e
	}
	busyRooms := map[uuid.UUID]bool{}
	for _, rec := range rows {
		busyRooms[rec.RoomID] = true
		if rec.Status != "recording" || rec.EgressID == nil {
			continue
		}
		if e, ok := running[*rec.EgressID]; ok && !e.Ended() {
			continue
		}
		// Not active: ask for its final state.
		list, err := s.eg.ListEgress(ctx, "", *rec.EgressID, false)
		if err != nil {
			slog.WarnContext(ctx, "recording: look up egress", "egress", *rec.EgressID, "err", err)
			continue
		}
		if len(list) > 0 && !list[0].Ended() {
			continue // starting or ending: next round
		}
		info := &rtc.EgressInfo{EgressID: *rec.EgressID, Status: rtc.EgressAborted}
		if len(list) > 0 {
			info = &list[0]
		}
		reason := "lost"
		if len(list) > 0 {
			reason = "egress"
		}
		if err := s.finish(ctx, rec, info, reason); err != nil {
			slog.WarnContext(ctx, "recording: take over an ended egress", "recording", rec.ID, "err", err)
		}
	}
	for id, e := range running {
		wid, rid, ok := voice.ParseRoomName(e.RoomName)
		if !ok {
			continue // not a Calaba room
		}
		rec, err := s.db.Q.GetRecordingByEgress(ctx, &id)
		switch {
		case err == nil && (rec.Status == "recording" || rec.Status == "pending"):
			continue
		case err != nil && !db.IsNotFound(err):
			continue
		case busyRooms[rid] && db.IsNotFound(err):
			continue // a start in this room may not have stored its egress id yet
		}
		if !s.ownsWorkspace(ctx, wid) {
			// Another Calab installation shares this LiveKit (same API key): its egresses look
			// like orphans here — never stop them (prod 1.2.0: every recording died at the
			// other instance's first reconcile, docs/12).
			continue
		}
		s.stopEgress(ctx, id, "orphan", "reconcile", "room", e.RoomName)
	}
	return nil
}

// ownsWorkspace reports whether the workspace of a LiveKit room is in this installation's
// database. Unknown on a database error: treated as not ours (the stop waits for the next
// round).
func (s *Service) ownsWorkspace(ctx context.Context, wid uuid.UUID) bool {
	_, err := s.db.Q.GetWorkspace(ctx, wid)
	if err != nil && !db.IsNotFound(err) {
		slog.WarnContext(ctx, "recording: look up the workspace of an egress", "workspace", wid, "err", err)
	}
	return err == nil
}

// stopEgress is the only way the service stops an egress: every stop is logged with its
// reason and caller, so an unexpected end of a recording can always be traced.
func (s *Service) stopEgress(ctx context.Context, egressID, reason, caller string, attrs ...any) {
	slog.InfoContext(ctx, "recording: stop egress", append([]any{"egress", egressID, "reason", reason, "caller", caller}, attrs...)...)
	if _, err := s.eg.StopEgress(ctx, egressID); err != nil && !rtc.IsEgressGone(err) {
		slog.WarnContext(ctx, "recording: stop egress failed", "egress", egressID, "caller", caller, "err", err)
	}
}

func (s *Service) finishWithout(ctx context.Context, rec sqlc.RoomRecording, reason string) {
	if err := s.finish(ctx, rec, &rtc.EgressInfo{Status: rtc.EgressAborted}, reason); err != nil {
		slog.WarnContext(ctx, "recording: fail a lost recording", "recording", rec.ID, "err", err)
	}
}

func (s *Service) removeFile(ctx context.Context, rec sqlc.RoomRecording) {
	if rec.File == "" {
		return
	}
	if err := s.store.remove(ctx, rec.File); err != nil {
		slog.WarnContext(ctx, "recording: remove file", "recording", rec.ID, "err", err)
		return
	}
	s.forgetFile(ctx, rec)
}

// forgetFile records that the recording's file is gone; a failed recording's card is updated (it
// no longer offers «Отправить снова»).
func (s *Service) forgetFile(ctx context.Context, rec sqlc.RoomRecording) {
	if err := db.GuardExec(ctx, s.db, func(guarded *sqlc.Queries) error { return guarded.MarkRecordingFileDeleted(ctx, rec.ID) }); err != nil {
		slog.WarnContext(ctx, "recording: mark file deleted", "recording", rec.ID, "err", err)
		return
	}
	if rec.Status == "failed" {
		now := s.Now()
		rec.FileDeletedAt = &now
		s.card(ctx, rec)
	}
}

// Janitor removes audio attachments older than RECORDING_KEEP_DAYS and recording files that are
// no longer needed: of done recordings (once the audio is kept), of the others 7 days after
// they stopped, and on the volume any stray .mp4 older than that plus a day (the bucket is not
// swept, storage.go).
func (s *Service) Janitor(ctx context.Context) {
	s.expireAudio(ctx)
	before := s.Now().Add(-s.KeepFiles)
	rows, err := s.db.Q.ListRecordingFilesToDelete(ctx, &before)
	if err != nil {
		slog.WarnContext(ctx, "recording: list files to delete", "err", err)
		return
	}
	for _, rec := range rows {
		s.removeFile(ctx, rec)
	}
	s.store.sweep(ctx, before.Add(-24*time.Hour))
}
