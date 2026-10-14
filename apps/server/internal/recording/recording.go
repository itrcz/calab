// Package recording records meetings and hands them to GPTunneL for transcription
// (ADR-0025).
//
// A workspace pairs with GPTunneL once (a device token, sealed at rest). Any member (not a
// guest) starts the recording of a voice room: the server starts a LiveKit Egress (room
// composite, audio only, MP4 on the shared recordings volume or uploaded into the files bucket,
// storage.go) and announces ROOM_RECORDING.
// When the egress ends (stop, auto-stop, the call ended) the file is uploaded to GPTunneL in
// resumable chunks by a single worker (Valkey lock, Postgres queue with leases, retries with
// backoff), GPTunneL's status is polled until done or failed, and a card in the room chat
// follows each step. After done the file becomes the card's audio attachment (kept
// RECORDING_KEEP_DAYS) and the summary and transcript are copied from GPTunneL (result.go);
// other recording files go away after 7 days.
package recording

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/buildinfo"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/sealbox"
	"github.com/calaba/calaba/server/internal/voice"
)

// Integration kind of GPTunneL in workspace_integrations.
const kindGPTunnel = "gptunnel"

// Platform sent when pairing: GPTunneL's device contract knows macos | windows | linux, and
// the recorder is a Linux server.
const platform = "linux"

// Config of the service.
type Config struct {
	Dir           string // RECORDINGS_PATH: the recordings volume as the API sees it
	EgressDir     string // RECORDING_EGRESS_DIR: the same volume in the egress container
	MaxConcurrent int    // RECORDING_MAX_CONCURRENT, server-wide
	Secret        []byte // JWT_SECRET: seals device tokens
	WebURL        string // GPTUNNEL_WEB_URL: app.gptunnel.ai links are shown on it (docs/17 §4)
	// Bucket (STORAGE_DRIVER=s3) keeps the recordings in the files bucket instead of the volume:
	// the egress uploads them there itself, Dir and EgressDir are not used (storage.go).
	Bucket *Bucket
}

// Service implements the integration and recording endpoints and the background worker.
type Service struct {
	cfg    Config
	db     *db.DB
	redis  rueidis.Client
	eg     rtc.Egress  // nil = voice (LiveKit) not configured
	store  recordStore // where the recordings' files are: the volume or the bucket
	gpt    *gptunnel.Client
	files  *files.Service // audio attachments of done recordings (SetFiles); nil = not kept
	box    *sealbox.Box
	events events.Publisher
	system *messages.System
	voice  voice.Store
	pair   *redisx.RateLimiter
	wake   chan struct{}
	token  string // this instance's worker lock token

	// Tunables (tests shorten them).
	Tick          time.Duration // worker loop period
	LockTTL       time.Duration
	Lease         time.Duration   // a claimed job is not picked again for this long
	MaxDuration   time.Duration   // auto-stop: 2 min under GPTunneL's 4 h, the stop takes a few seconds
	EmptyTimeout  time.Duration   // auto-stop when nobody is in the call (2 min)
	UploadFor     time.Duration   // give up retrying an upload after this (24 h)
	PollFor       time.Duration   // give up polling GPTunneL after this (2 h)
	PollMin       time.Duration   // first status poll after the upload, and the shortest interval (20 s)
	KeepFiles     time.Duration   // files of failed recordings (7 days)
	StorageWait   time.Duration   // an ended recording waits for a bucket that does not answer (30 min)
	KeepAudio     time.Duration   // audio attachments of done recordings (RECORDING_KEEP_DAYS, 30 days)
	ResultBackoff []time.Duration // waits between result attempts; past the last one it gives up
	Now           func() time.Time
	// OnStarted is told about every recording that started (the calendar links it to the
	// room's meeting, ADR-0038 §6); nil = nobody.
	OnStarted func(ctx context.Context, rec sqlc.RoomRecording)
	// PlanInactive reports the workspace in the restricted mode («тариф не активен», ADR-0086
	// amendment 1): its recordings stop (Maintain, StopWorkspace). nil = never. An unreadable
	// plan keeps recording: the start route is closed by the identity gate anyway.
	PlanInactive func(ctx context.Context, workspace uuid.UUID) bool
}

// StopPlanInactive stops the running recordings of a workspace that just entered the restricted
// mode (billing hook; Maintain repeats it for the rows this instance missed).
func (s *Service) StopPlanInactive(ctx context.Context, workspace uuid.UUID) {
	rows, err := s.db.Q.ListActiveRecordings(ctx, &workspace)
	if err != nil {
		slog.WarnContext(ctx, "recording: list active for the plan stop", "workspace", workspace, "err", err)
		return
	}
	for _, rec := range rows {
		if rec.Status != "recording" || rec.StoppedAt != nil {
			continue
		}
		if _, err := s.requestStop(ctx, rec, StopPlanInactive, nil); err != nil {
			slog.WarnContext(ctx, "recording: plan stop", "recording", rec.ID, "err", err)
		}
	}
}

// StopPlanInactive is RoomRecording.stop_reason of a recording stopped by the restricted mode.
const StopPlanInactive = "plan_inactive"

// New creates the service. eg nil = recording unavailable (start answers 503).
func New(cfg Config, d *db.DB, r rueidis.Client, eg rtc.Egress, gpt *gptunnel.Client, ev events.Publisher) *Service {
	if cfg.MaxConcurrent < 1 {
		cfg.MaxConcurrent = 1
	}
	var store recordStore = volume{dir: cfg.Dir, egressDir: cfg.EgressDir}
	if cfg.Bucket != nil {
		store = *cfg.Bucket
	}
	return &Service{
		cfg: cfg, db: d, redis: r, eg: eg, gpt: gpt, events: ev, store: store,
		box:    sealbox.New("calaba/workspace-integration/v1", cfg.Secret),
		system: messages.NewSystem(d, ev),
		voice:  voice.Store{C: r},
		pair:   redisx.NewRateLimiter(r, "rl:gptunnel-pair:", 10, 10.0/60), // 10 at once, 10 per hour per workspace
		wake:   make(chan struct{}, 1),
		token:  uuid.NewString(),
		Tick:   5 * time.Second, LockTTL: 30 * time.Second, Lease: 15 * time.Minute,
		MaxDuration: gptunnel.MaxDuration - 2*time.Minute, EmptyTimeout: 2 * time.Minute,
		UploadFor: 24 * time.Hour, PollFor: 2 * time.Hour, PollMin: 20 * time.Second, KeepFiles: 7 * 24 * time.Hour,
		KeepAudio: 30 * 24 * time.Hour, ResultBackoff: defaultResultBackoff, StorageWait: 30 * time.Minute,
		Now: time.Now,
	}
}

// Routes registers the endpoints; wrap applies auth + the permission resolver.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/workspaces/{id}/integrations/gptunnel", wrap(httpx.HandlerFunc(s.getIntegration)))
	mux.Handle("POST /api/workspaces/{id}/integrations/gptunnel", wrap(httpx.HandlerFunc(s.pairIntegration)))
	mux.Handle("DELETE /api/workspaces/{id}/integrations/gptunnel", wrap(httpx.HandlerFunc(s.unpairIntegration)))
	mux.Handle("POST /api/rooms/{id}/recording/start", wrap(httpx.HandlerFunc(s.start)))
	mux.Handle("POST /api/rooms/{id}/recording/stop", wrap(httpx.HandlerFunc(s.stop)))
	mux.Handle("POST /api/rooms/{id}/recordings/{rid}/recheck", wrap(httpx.HandlerFunc(s.recheck)))
	mux.Handle("POST /api/rooms/{id}/recordings/{rid}/reupload", wrap(httpx.HandlerFunc(s.reupload)))
	mux.Handle("GET /api/rooms/{id}/recordings/{rid}/transcript", wrap(httpx.HandlerFunc(s.transcript)))
	mux.Handle("DELETE /api/rooms/{id}/recordings/{rid}", wrap(httpx.HandlerFunc(s.remove)))
}

var (
	errNotPaired = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_NOT_PAIRED,
		"the workspace is not connected to GPTunneL: an owner or admin connects it in the workspace settings")
	errAlready = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_ALREADY_RECORDING, "the room is already being recorded")
	errLimit   = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_RECORDING_LIMIT,
		"too many meetings are being recorded on this server; try again later")
	errNoEgress = httpx.Unavailable(errors.New("recording: LiveKit is not configured"))
)

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// ---- integration ----

// workspaceAccess returns the workspace of the path and the caller's bits and role (404 for
// non-members).
func workspaceAccess(r *http.Request) (uuid.UUID, perm.Bits, perm.Role, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return uuid.Nil, 0, "", err
	}
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return uuid.Nil, 0, "", httpx.NotFound("workspace")
	}
	return wsID, bits, role, err
}

func (s *Service) integrationProto(row *sqlc.WorkspaceIntegration) *v1.GptunnelIntegration {
	if row == nil || row.TokenEnc == nil {
		return &v1.GptunnelIntegration{}
	}
	out := &v1.GptunnelIntegration{Paired: true, DeviceName: row.DeviceName, Account: row.Account,
		WebUrl: gptunnel.NormalizeWebURL(row.WebUrl, s.cfg.WebURL), PairedAt: timestamppb.New(row.PairedAt)}
	if row.PairedBy != nil {
		out.PairedBy = row.PairedBy.String()
	}
	return out
}

func (s *Service) integration(ctx context.Context, wsID uuid.UUID) (*sqlc.WorkspaceIntegration, error) {
	row, err := s.db.Q.GetIntegration(ctx, sqlc.GetIntegrationParams{WorkspaceID: wsID, Kind: kindGPTunnel})
	if db.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// deviceToken returns the workspace's device token and its sealed form ("" = not paired).
func (s *Service) deviceToken(ctx context.Context, wsID uuid.UUID) (string, []byte, error) {
	row, err := s.integration(ctx, wsID)
	if err != nil || row == nil || row.TokenEnc == nil {
		return "", nil, err
	}
	plain, err := s.box.Open(row.TokenEnc)
	if err != nil {
		return "", nil, err
	}
	return string(plain), row.TokenEnc, nil
}

func (s *Service) getIntegration(w http.ResponseWriter, r *http.Request) error {
	wsID, _, role, err := workspaceAccess(r)
	if err != nil {
		return err
	}
	if role == perm.RoleGuest {
		return httpx.Forbidden("not available to guests")
	}
	row, err := s.integration(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetGptunnelIntegrationResponse{Integration: s.integrationProto(row)})
	return nil
}

// pairCode: GPTunneL codes are 8 characters of A–Z / 2–9, shown as ABCD-EFGH.
var pairCode = regexp.MustCompile(`^[A-Z0-9]{8}$`)

func (s *Service) pairIntegration(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, role, err := workspaceAccess(r)
	if err != nil {
		return err
	}
	if !bits.Has(perm.ManageIntegrations) || role == perm.RoleGuest { // ADR-0048
		return httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	var req v1.PairGptunnelRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	code := strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(strings.TrimSpace(req.GetCode())))
	if !pairCode.MatchString(code) {
		return httpx.Validation("code", "the code has 8 letters and digits, e.g. ABCD-EFGH")
	}
	if err := s.pair.Take(r.Context(), wsID.String()); err != nil {
		return err
	}
	ws, err := s.db.Q.GetWorkspace(r.Context(), wsID)
	if err != nil {
		return err
	}
	name := "Calab · " + ws.Name
	if utf8.RuneCountInString(name) > 100 {
		name = string([]rune(name)[:100])
	}
	sess, err := s.gpt.Pair(r.Context(), gptunnel.PairRequest{Code: code, Name: name, Platform: platform, AppVersion: buildinfo.Version})
	if err != nil {
		return pairError(err)
	}
	sealed, err := s.box.Seal([]byte(sess.Token))
	if err != nil {
		return err
	}
	oldToken, _, err := s.deviceToken(r.Context(), wsID)
	if err != nil {
		slog.WarnContext(r.Context(), "gptunnel: read the previous device token", "workspace", wsID, "err", err)
	}
	me := uid(r)
	row, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.WorkspaceIntegration, error) {
		return guarded.PutIntegration(r.Context(), sqlc.PutIntegrationParams{
			WorkspaceID: wsID, Kind: kindGPTunnel, TokenEnc: sealed, DeviceID: clip(sess.Device.ID, 200),
			DeviceName: clip(sess.Device.Name, 200), Account: clip(sess.User.Label(), 320), WebUrl: clip(sess.WebURL, 2000), PairedBy: &me,
		})
	})
	if err != nil {
		return err
	}
	if oldToken != "" && oldToken != sess.Token {
		s.revokeRemote(r.Context(), oldToken)
	}
	slog.InfoContext(r.Context(), "gptunnel: workspace paired", "workspace", wsID, "by", me, "device", sess.Device.ID)
	httpx.Write(w, http.StatusOK, &v1.PairGptunnelResponse{Integration: s.integrationProto(&row)})
	return nil
}

var errCodeInvalid = httpx.Coded(http.StatusUnprocessableEntity, v1.ErrorCode_ERROR_CODE_CODE_INVALID,
	"the code is wrong or expired: get a new one in GPTunneL")

func pairError(err error) error {
	e, ok := gptunnel.AsError(err)
	if !ok {
		return httpx.Unavailable(err)
	}
	switch {
	case e.Code == gptunnel.CodeInvalidCode || e.Code == gptunnel.CodeNotFound || (e.Status >= 400 && e.Status < 500 && e.Status != http.StatusTooManyRequests && !e.Retryable() && e.Code != gptunnel.CodeServerUnsupported):
		return errCodeInvalid
	case e.Code == gptunnel.CodeTooManyAttempts || e.Status == http.StatusTooManyRequests:
		return httpx.RateLimited()
	}
	return httpx.Unavailable(err)
}

// revokeRemote revokes a device token in GPTunneL, best effort (a revoked or unknown token
// is fine).
func (s *Service) revokeRemote(ctx context.Context, token string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	if err := s.gpt.Revoke(ctx, token); err != nil {
		if e, ok := gptunnel.AsError(err); ok && e.Unauthorized() {
			return
		}
		slog.WarnContext(ctx, "gptunnel: revoke device token", "err", err)
	}
}

func (s *Service) unpairIntegration(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, role, err := workspaceAccess(r)
	if err != nil {
		return err
	}
	if !bits.Has(perm.ManageIntegrations) || role == perm.RoleGuest { // ADR-0048
		return httpx.Forbidden("MANAGE_INTEGRATIONS required")
	}
	token, _, err := s.deviceToken(r.Context(), wsID)
	if err != nil {
		slog.WarnContext(r.Context(), "gptunnel: read the device token to revoke", "workspace", wsID, "err", err)
	}
	if _, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.RevokeIntegration(r.Context(), sqlc.RevokeIntegrationParams{WorkspaceID: wsID, Kind: kindGPTunnel})
	}); err != nil {
		return err
	}
	if token != "" {
		s.revokeRemote(r.Context(), token)
	}
	slog.InfoContext(r.Context(), "gptunnel: workspace unpaired", "workspace", wsID, "by", uid(r))
	httpx.NoContent(w)
	return nil
}

func clip(s string, n int) string {
	s = strings.ToValidUTF8(s, "")
	if utf8.RuneCountInString(s) > n {
		return string([]rune(s)[:n])
	}
	return s
}

// ---- start / stop ----

// participant checks who may start or stop a recording: a workspace member (not a guest)
// with VIEW_ROOM and CONNECT in a voice room of the workspace.
func (s *Service) participant(r *http.Request) (sqlc.Room, perm.RoomAccess, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return sqlc.Room{}, perm.RoomAccess{}, err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return sqlc.Room{}, acc, err
	}
	if acc.DM {
		return sqlc.Room{}, acc, httpx.NotFound("room")
	}
	if acc.Role == perm.RoleGuest {
		return sqlc.Room{}, acc, httpx.Forbidden("guests cannot record meetings")
	}
	if !acc.Bits.Has(perm.ViewRoom | perm.Connect) {
		return sqlc.Room{}, acc, httpx.Forbidden("CONNECT required")
	}
	// A bot records without being seen in the call: it needs MANAGE_RECORDINGS too (ADR-0051).
	if id := auth.MustFromContext(r.Context()); id.IsBot {
		ws, _, err := perm.FromContext(r.Context()).Workspace(r.Context(), acc.WorkspaceID, id.UserID)
		if err != nil {
			return sqlc.Room{}, acc, err
		}
		if !ws.Has(perm.ManageRecordings) {
			return sqlc.Room{}, acc, httpx.Forbidden("MANAGE_RECORDINGS required for bots")
		}
	}
	room, err := s.db.Q.GetRoom(r.Context(), roomID)
	if db.IsNotFound(err) {
		return room, acc, httpx.NotFound("room")
	}
	if err != nil {
		return room, acc, err
	}
	if room.Type != "voice" {
		return room, acc, httpx.Validation("id", "only voice rooms can be recorded")
	}
	return room, acc, nil
}

// File of a recording: <workspace>/<recording>.mp4, under the recordings volume or a blob key
// in the files bucket (storage.go).
func recordingFile(wsID, id uuid.UUID) string { return wsID.String() + "/" + id.String() + ".mp4" }

func (s *Service) start(w http.ResponseWriter, r *http.Request) error {
	room, acc, err := s.participant(r)
	if err != nil {
		return err
	}
	if s.eg == nil {
		return errNoEgress
	}
	if !room.AllowRecording {
		return httpx.Forbidden("recording is not allowed in this room")
	}
	ctx := r.Context()
	if tok, _, err := s.deviceToken(ctx, acc.WorkspaceID); err != nil {
		return err
	} else if tok == "" {
		return errNotPaired
	}
	started, err := s.voice.StartedAt(ctx, []uuid.UUID{room.ID})
	if err != nil {
		return err
	}
	if _, ok := started[room.ID]; !ok {
		return httpx.Conflict("nobody is in the call")
	}
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	me := uid(r)
	var rec sqlc.RoomRecording
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockRecordings(ctx); err != nil {
			return err
		}
		if _, err := q.GetActiveRecording(ctx, room.ID); err == nil {
			return errAlready
		} else if !db.IsNotFound(err) {
			return err
		}
		n, err := q.CountActiveRecordings(ctx)
		if err != nil {
			return err
		}
		if n >= int64(s.cfg.MaxConcurrent) {
			return errLimit.WithDetails("", uint64(n), uint64(s.cfg.MaxConcurrent)) //nolint:gosec // small non-negative counts
		}
		rec, err = q.InsertRecording(ctx, sqlc.InsertRecordingParams{
			ID: id, WorkspaceID: acc.WorkspaceID, RoomID: room.ID, StartedBy: &me, File: recordingFile(acc.WorkspaceID, id),
		})
		if db.UniqueViolation(err) != "" {
			return errAlready
		}
		return err
	})
	if err != nil {
		return err
	}
	fail := func(cause error) error {
		if _, err := db.GuardValue(context.WithoutCancel(ctx), s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
			return guarded.MarkRecordingFailed(context.WithoutCancel(ctx), sqlc.MarkRecordingFailedParams{ID: rec.ID, Error: "recorder_failed", StopReason: "egress"})
		}); err != nil {
			slog.WarnContext(ctx, "recording: mark failed", "recording", rec.ID, "err", err)
		}
		return httpx.Unavailable(cause)
	}
	out, err := s.store.output(rec.File)
	if err != nil {
		return fail(err)
	}
	info, err := s.eg.StartAudioRecording(ctx, voice.RoomName(acc.WorkspaceID, room.ID), out)
	if err != nil {
		slog.WarnContext(ctx, "recording: start egress", "room", room.ID, "err", err)
		return fail(err)
	}
	upd, err := db.GuardValue(context.WithoutCancel(ctx), s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
		return guarded.MarkRecordingStarted(context.WithoutCancel(ctx), sqlc.MarkRecordingStartedParams{ID: rec.ID, EgressID: &info.EgressID})
	})
	if err != nil {
		// The egress runs but the row is lost: stop it (reconcile would do it too).
		s.stopEgress(context.WithoutCancel(ctx), info.EgressID, "start_not_stored", "start", "recording", rec.ID, "err", err)
		return err
	}
	if upd.StoppedAt != nil {
		// Stopped while the egress was starting (the stop had no egress id to send yet).
		s.stopEgress(context.WithoutCancel(ctx), info.EgressID, upd.StopReason, "start: stopped while starting", "recording", upd.ID)
	}
	slog.InfoContext(ctx, "recording started", "recording", upd.ID, "room", room.ID, "egress", info.EgressID, "by", me)
	pb := pbconv.RoomRecording(upd)
	s.publish(ctx, pb)
	if s.OnStarted != nil {
		s.OnStarted(context.WithoutCancel(ctx), upd)
	}
	httpx.Write(w, http.StatusOK, &v1.StartRecordingResponse{Recording: pb})
	return nil
}

func (s *Service) stop(w http.ResponseWriter, r *http.Request) error {
	room, _, err := s.participant(r)
	if err != nil {
		return err
	}
	rec, err := s.db.Q.GetActiveRecording(r.Context(), room.ID)
	if db.IsNotFound(err) || (err == nil && rec.StoppedAt != nil) {
		return httpx.NotFound("recording of this room")
	}
	if err != nil {
		return err
	}
	me := uid(r)
	upd, err := s.requestStop(r.Context(), rec, "user", &me)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.StopRecordingResponse{Recording: pbconv.RoomRecording(upd)})
	return nil
}

// requestStop records the stop, tells the egress to stop and announces STOPPED. The row
// stays 'recording' until the egress reports its file (webhook / reconcile). An egress that
// cannot be reached now is stopped again by the worker.
func (s *Service) requestStop(ctx context.Context, rec sqlc.RoomRecording, reason string, by *uuid.UUID) (sqlc.RoomRecording, error) {
	upd, err := db.GuardValue(ctx, s.db, func(guarded *sqlc.Queries) (sqlc.RoomRecording, error) {
		return guarded.MarkRecordingStopRequested(ctx, sqlc.MarkRecordingStopRequestedParams{ID: rec.ID, StopReason: reason, StoppedBy: by})
	})
	if db.IsNotFound(err) {
		return rec, httpx.NotFound("recording of this room")
	}
	if err != nil {
		return rec, err
	}
	if upd.EgressID != nil && s.eg != nil {
		s.stopEgress(ctx, *upd.EgressID, reason, "requestStop", "recording", upd.ID) // retried by the worker on failure
	}
	slog.InfoContext(ctx, "recording stopped", "recording", upd.ID, "reason", reason)
	s.publish(ctx, pbconv.RoomRecording(upd))
	return upd, nil
}

func (s *Service) publish(ctx context.Context, rec *v1.RoomRecording) {
	wid, err := uuid.Parse(rec.GetWorkspaceId())
	if err != nil {
		return
	}
	s.events.Workspace(ctx, wid, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomRecording{RoomRecording: rec}})
}
