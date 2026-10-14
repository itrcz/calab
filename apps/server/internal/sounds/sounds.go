// Package sounds implements the soundboard (ADR-0036): the sound library of a workspace, managed
// with MANAGE_STICKERS (clips made by the server from the admin's upload), and the play event
// that tells everyone in a voice call to play a clip locally — a sound never goes through a media
// track.
package sounds

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/voice"
)

// Library limits (ADR-0036 §2).
const (
	MaxSounds       = 50
	maxNameLen      = 32
	maxEmojiBytes   = 64
	BuiltinPrefix   = "builtin:"
	playUserBurst   = 1  // one sound per 2 s per user
	playRoomBurst   = 5  // five sounds per 10 s per room
	playRefillPerMn = 30 // one token per 2 s for both buckets
)

var builtinName = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)

// Handlers serves the soundboard endpoints.
type Handlers struct {
	db     *db.DB
	events events.Publisher
	files  *files.Service
	voice  voice.Store
	user   *redisx.RateLimiter // plays per user
	room   *redisx.RateLimiter // plays per room
}

// NewHandlers creates the soundboard handlers with their play limiters.
func NewHandlers(d *db.DB, ev events.Publisher, fs *files.Service, vs voice.Store) *Handlers {
	return &Handlers{db: d, events: ev, files: fs, voice: vs,
		user: redisx.NewRateLimiter(vs.C, "rl:sound:user:", playUserBurst, playRefillPerMn),
		room: redisx.NewRateLimiter(vs.C, "rl:sound:room:", playRoomBurst, playRefillPerMn)}
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	handle := func(p string, f httpx.HandlerFunc) { mux.Handle(p, wrap(f)) }
	handle("GET /api/workspaces/{id}/sounds", h.list)
	handle("POST /api/workspaces/{id}/sounds", h.create)
	handle("PATCH /api/workspaces/{id}/sounds/{soundId}", h.update)
	handle("DELETE /api/workspaces/{id}/sounds/{soundId}", h.delete)
	handle("POST /api/rooms/{id}/sounds/play", h.play)
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// member resolves the caller in the workspace of the path: 404 for non-members.
func member(r *http.Request) (uuid.UUID, perm.Member, error) {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return wsID, perm.Member{}, err
	}
	m, err := perm.FromContext(r.Context()).Member(r.Context(), wsID, uid(r))
	if errors.Is(err, perm.ErrNotMember) {
		return wsID, m, httpx.NotFound("workspace")
	}
	return wsID, m, err
}

// manager checks MANAGE_STICKERS («Стикеры и звуки») and that the workspace is not suspended.
func (h *Handlers) manager(r *http.Request) (uuid.UUID, error) {
	wsID, m, err := member(r)
	if err != nil {
		return wsID, err
	}
	if !m.Workspace().Has(perm.ManageStickers) {
		return wsID, httpx.Forbidden("MANAGE_STICKERS required")
	}
	return wsID, moderation.CheckSuspended(r.Context(), h.db.Q, wsID)
}

// soundName: 1..32 characters after trimming, no control characters.
func soundName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > maxNameLen || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", httpx.Validation("name", "name must be 1.."+strconv.Itoa(maxNameLen)+" characters without control characters")
	}
	return s, nil
}

// soundEmoji: "" or one emoji sequence.
func soundEmoji(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	if len(s) > maxEmojiBytes || !messages.ValidEmoji(s) {
		return "", httpx.Validation("emoji", "must be one emoji or empty")
	}
	return s, nil
}

// source checks the upload a clip is made from: a file the caller uploaded to this workspace
// (at most 2 MB), not a sticker's, badge's or camera background's file — the badge rule: a file
// of someone else (e.g. an attachment of a restricted room) must not become a clip every member
// reads. Whether it is audio at all is up to ffmpeg.
func source(ctx context.Context, q *sqlc.Queries, wsID, caller uuid.UUID, raw string) (sqlc.File, error) {
	bad := httpx.Validation("fileId", "an MP3, Ogg or WAV file you uploaded to this workspace, at most 2 MB")
	id, err := uuid.Parse(raw)
	if err != nil {
		return sqlc.File{}, bad
	}
	f, err := q.GetFile(ctx, id)
	if db.IsNotFound(err) {
		return f, bad
	}
	if err != nil {
		return f, err
	}
	if f.WorkspaceID == nil || *f.WorkspaceID != wsID || f.UploaderID != caller || f.Size > files.MaxSoundSourceBytes || f.Width != nil {
		return f, bad
	}
	if _, err := q.GetStickerFileWorkspace(ctx, id); err == nil {
		return f, bad
	} else if !db.IsNotFound(err) {
		return f, err
	}
	for _, used := range []func(context.Context, uuid.UUID) (bool, error){q.IsWorkspaceBadge, q.IsWorkspaceBackground, q.IsWorkspaceSound, isAchievement(q)} {
		if yes, err := used(ctx, id); err != nil {
			return f, err
		} else if yes {
			return f, bad
		}
	}
	return f, nil
}

// prepare makes the clip of the upload raw (before any transaction: ffmpeg is slow).
func (h *Handlers) prepare(r *http.Request, wsID uuid.UUID, raw string) (*files.PreparedFile, int32, error) {
	src, err := source(r.Context(), h.db.Q, wsID, uid(r), raw)
	if err != nil {
		return nil, 0, err
	}
	prep, ms, err := h.files.PrepareSound(r.Context(), src)
	switch {
	case files.IsBadAudio(err):
		return nil, 0, httpx.Validation("fileId", "the file could not be read as an MP3, Ogg or WAV clip")
	case errors.Is(err, files.ErrNoFFmpeg):
		return nil, 0, httpx.Unavailable(err)
	}
	return prep, ms, err
}

func loadSound(r *http.Request, q *sqlc.Queries, wsID uuid.UUID) (sqlc.WorkspaceSound, error) {
	id, err := httpx.PathUUID(r, "soundId", "sound")
	if err != nil {
		return sqlc.WorkspaceSound{}, err
	}
	s, err := q.GetWorkspaceSound(r.Context(), sqlc.GetWorkspaceSoundParams{ID: id, WorkspaceID: wsID})
	if db.IsNotFound(err) {
		return s, httpx.NotFound("sound")
	}
	return s, err
}

func tooMany() error {
	return httpx.Conflict("a workspace has at most " + strconv.Itoa(MaxSounds) + " sounds")
}

func updateEvent(s sqlc.WorkspaceSound) *v1.DispatchEvent {
	return &v1.DispatchEvent{Event: &v1.DispatchEvent_SoundUpdate{SoundUpdate: &v1.SoundUpdate{Sound: pbconv.Sound(s)}}}
}

// list: GET /api/workspaces/{id}/sounds (any member, guests and bots too).
func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := member(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListWorkspaceSounds(r.Context(), wsID)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListSoundsResponse{Sounds: pbconv.Sounds(rows)})
	return nil
}

// create: POST /api/workspaces/{id}/sounds (MANAGE_STICKERS): the clip is made from the caller's
// upload before the transaction, then counted in the quota; the upload stays unattached.
func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	wsID, err := h.manager(r)
	if err != nil {
		return err
	}
	var req v1.CreateSoundRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := soundName(req.GetName())
	if err != nil {
		return err
	}
	emoji, err := soundEmoji(req.GetEmoji())
	if err != nil {
		return err
	}
	// A cheap early refusal: no conversion when the library is full (checked again under the lock).
	if n, err := h.db.Q.CountWorkspaceSounds(r.Context(), wsID); err != nil {
		return err
	} else if n >= MaxSounds {
		return tooMany()
	}
	prep, ms, err := h.prepare(r, wsID, req.GetFileId())
	if err != nil {
		return err
	}
	var created sqlc.WorkspaceSound
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceSounds(r.Context(), wsID); err != nil {
			return err
		}
		n, err := q.CountWorkspaceSounds(r.Context(), wsID)
		if err != nil {
			return err
		}
		if n >= MaxSounds {
			return tooMany()
		}
		f, err := h.files.InsertPrepared(r.Context(), q, prep)
		if err != nil {
			return err
		}
		created, err = q.InsertWorkspaceSound(r.Context(), sqlc.InsertWorkspaceSoundParams{
			WorkspaceID: wsID, Name: name, Emoji: emoji, FileID: f.ID, DurationMs: ms})
		return err
	})
	if err != nil {
		h.files.Discard(prep)
		return err
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_SoundCreate{
		SoundCreate: &v1.SoundCreate{Sound: pbconv.Sound(created)},
	}})
	httpx.Write(w, http.StatusCreated, &v1.SoundResponse{Sound: pbconv.Sound(created)})
	return nil
}

// update: PATCH /api/workspaces/{id}/sounds/{soundId} (MANAGE_STICKERS): rename, emoji, a new
// clip, a new place in the library.
func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	wsID, err := h.manager(r)
	if err != nil {
		return err
	}
	var req v1.UpdateSoundRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	cur, err := loadSound(r, h.db.Q, wsID)
	if err != nil {
		return err
	}
	name, emoji := cur.Name, cur.Emoji
	if req.Name != nil {
		if name, err = soundName(req.GetName()); err != nil {
			return err
		}
	}
	if req.Emoji != nil {
		if emoji, err = soundEmoji(req.GetEmoji()); err != nil {
			return err
		}
	}
	var prep *files.PreparedFile
	ms := cur.DurationMs
	if req.FileId != nil {
		if prep, ms, err = h.prepare(r, wsID, req.GetFileId()); err != nil {
			return err
		}
	}
	var changed []sqlc.WorkspaceSound
	var updated sqlc.WorkspaceSound
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceSounds(r.Context(), wsID); err != nil {
			return err
		}
		fileID := cur.FileID
		if prep != nil {
			f, err := h.files.InsertPrepared(r.Context(), q, prep)
			if err != nil {
				return err
			}
			fileID = f.ID
		}
		var err error
		updated, err = q.UpdateWorkspaceSound(r.Context(), sqlc.UpdateWorkspaceSoundParams{
			ID: cur.ID, WorkspaceID: wsID, Name: name, Emoji: emoji, FileID: fileID, DurationMs: ms})
		if db.IsNotFound(err) {
			return httpx.NotFound("sound")
		}
		if err != nil {
			return err
		}
		if req.Position == nil {
			changed = []sqlc.WorkspaceSound{updated}
			return nil
		}
		changed, err = move(r.Context(), q, wsID, updated, int(req.GetPosition()))
		for _, s := range changed {
			if s.ID == updated.ID {
				updated = s
			}
		}
		return err
	})
	if err != nil {
		h.files.Discard(prep)
		return err
	}
	// The previous clip is now unreferenced and goes with the orphan cleanup.
	evs := make([]*v1.DispatchEvent, len(changed))
	for i, s := range changed {
		evs[i] = updateEvent(s)
	}
	h.events.WorkspaceEvents(r.Context(), wsID, evs)
	httpx.Write(w, http.StatusOK, &v1.SoundResponse{Sound: pbconv.Sound(updated)})
	return nil
}

// move puts s at index pos of the library (clamped) and renumbers it 0..n-1; returns the sounds
// whose position changed, s always among them.
func move(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, s sqlc.WorkspaceSound, pos int) ([]sqlc.WorkspaceSound, error) {
	all, err := q.ListWorkspaceSounds(ctx, wsID)
	if err != nil {
		return nil, err
	}
	order := make([]sqlc.WorkspaceSound, 0, len(all))
	for _, x := range all {
		if x.ID != s.ID {
			order = append(order, x)
		}
	}
	pos = min(max(pos, 0), len(order))
	order = append(order[:pos], append([]sqlc.WorkspaceSound{s}, order[pos:]...)...)
	var changed []sqlc.WorkspaceSound
	for i, x := range order {
		if int(x.Position) == i && x.ID != s.ID {
			continue
		}
		x.Position = int16(i) //nolint:gosec // ≤ MaxSounds
		if err := q.SetWorkspaceSoundPosition(ctx, sqlc.SetWorkspaceSoundPositionParams{ID: x.ID, WorkspaceID: wsID, Position: x.Position}); err != nil {
			return nil, err
		}
		changed = append(changed, x)
	}
	return changed, nil
}

// delete: DELETE /api/workspaces/{id}/sounds/{soundId} (MANAGE_STICKERS): only the row goes; its
// clip is left to the orphan cleanup.
func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) error {
	wsID, err := h.manager(r)
	if err != nil {
		return err
	}
	cur, err := loadSound(r, h.db.Q, wsID)
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteWorkspaceSound(r.Context(), sqlc.DeleteWorkspaceSoundParams{ID: cur.ID, WorkspaceID: wsID})
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("sound")
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_SoundDelete{
		SoundDelete: &v1.SoundDelete{WorkspaceId: wsID.String(), SoundId: cur.ID.String()},
	}})
	httpx.NoContent(w)
	return nil
}

// play: POST /api/rooms/{id}/sounds/play {sound_id} → 204. The caller must be connected to the
// room's call; SOUND_PLAY goes to the user channel of everyone connected to it.
func (h *Handlers) play(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return err
	}
	if acc.DM {
		return httpx.Validation("id", "sounds play in the voice rooms of a workspace")
	}
	var req v1.PlaySoundRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	caller := uid(r)
	sessions, err := h.voice.List(r.Context(), acc.WorkspaceID)
	if err != nil {
		return httpx.Unavailable(err)
	}
	var listeners []uuid.UUID
	inCall := false
	for _, vs := range voice.AggregateAll(acc.WorkspaceID, sessions) {
		if vs.GetRoomId() != roomID.String() || vs.GetPending() {
			continue
		}
		u, err := uuid.Parse(vs.GetUserId())
		if err != nil {
			continue
		}
		listeners = append(listeners, u)
		inCall = inCall || u == caller
	}
	if !inCall {
		return httpx.Forbidden("join the voice call of this room first")
	}
	id := req.GetSoundId()
	if name, ok := strings.CutPrefix(id, BuiltinPrefix); ok {
		if !builtinName.MatchString(name) {
			return httpx.NotFound("sound")
		}
	} else {
		sid, err := uuid.Parse(id)
		if err != nil {
			return httpx.NotFound("sound")
		}
		s, err := h.db.Q.GetWorkspaceSound(r.Context(), sqlc.GetWorkspaceSoundParams{ID: sid, WorkspaceID: acc.WorkspaceID})
		if db.IsNotFound(err) {
			return httpx.NotFound("sound")
		}
		if err != nil {
			return err
		}
		id = s.ID.String()
	}
	if err := h.user.Take(r.Context(), caller.String()); err != nil {
		return err
	}
	if err := h.room.Take(r.Context(), roomID.String()); err != nil {
		return err
	}
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_SoundPlay{SoundPlay: &v1.SoundPlay{
		RoomId: roomID.String(), SoundId: id, UserId: caller.String(), At: timestamppb.New(time.Now()),
	}}}
	for _, u := range listeners {
		h.events.User(r.Context(), u, ev)
	}
	httpx.NoContent(w)
	return nil
}

// isAchievement adapts IsWorkspaceAchievement (a nullable column) to the source checks.
func isAchievement(q *sqlc.Queries) func(context.Context, uuid.UUID) (bool, error) {
	return func(ctx context.Context, id uuid.UUID) (bool, error) { return q.IsWorkspaceAchievement(ctx, &id) }
}
