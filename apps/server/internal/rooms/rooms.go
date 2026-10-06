// Package rooms implements room CRUD, per-room media settings and permission overrides.
package rooms

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
)

// MaxOverrides caps permission overrides per room.
const MaxOverrides = 100

// Handlers serves room endpoints.
type Handlers struct {
	db     *db.DB
	events events.Publisher
	plans  *plans.Service // voice tier cap of the plan (ADR-0024); nil = none
	// Meetings: the calendar side of temporary rooms (ADR-0044); nil = no meetings.
	Meetings Meetings
	// PublicURL: the app's public address, for the link of a temporary room.
	PublicURL string
	// EmailGate: whether a guest link of a temporary room needs a confirmed address
	// (ADR-0023, EMAIL_VERIFICATION, ADR-0065). The zero value requires one.
	EmailGate auth.EmailGate
}

// NewHandlers creates the room handlers.
func NewHandlers(d *db.DB, ev events.Publisher) *Handlers { return &Handlers{db: d, events: ev} }

// WithPlans makes room media settings respect the workspace plan's voice tier cap.
func (h *Handlers) WithPlans(p *plans.Service) *Handlers { h.plans = p; return h }

// storedAudio is a room's own voice bitrate (0 = the workspace default).
func storedAudio(v *int32) uint32 {
	if v == nil {
		return 0
	}
	return uint32(max(*v, 0)) //nolint:gosec // DB CHECK bounds it
}

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/workspaces/{id}/rooms", wrap(httpx.HandlerFunc(h.create)))
	mux.Handle("GET /api/workspaces/{id}/rooms", wrap(httpx.HandlerFunc(h.list)))
	mux.Handle("POST /api/workspaces/{id}/rooms/temp", wrap(httpx.HandlerFunc(h.createTemp)))
	mux.Handle("GET /api/rooms/{id}", wrap(httpx.HandlerFunc(h.get)))
	mux.Handle("PATCH /api/rooms/{id}", wrap(httpx.HandlerFunc(h.update)))
	mux.Handle("DELETE /api/rooms/{id}", wrap(httpx.HandlerFunc(h.delete)))
	mux.Handle("PUT /api/rooms/{id}/permissions", wrap(httpx.HandlerFunc(h.setPermissions)))
	mux.Handle("PUT /api/rooms/{id}/notifications", wrap(httpx.HandlerFunc(h.setNotifications)))
}

// Visible returns the workspace's rooms that userID can see (VIEW_ROOM), in display order,
// with their newest live message as a list preview (WorkspaceSnapshot.room_last_messages,
// ADR-0073 §5): room id -> preview, rooms without live messages absent. VIEW_ROOM is also the
// right to read a room's history (ReadAccess), so every visible room gets its preview.
func Visible(ctx context.Context, q *sqlc.Queries, ws sqlc.Workspace, m perm.Member) ([]*v1.Room, map[string]*v1.DmLastMessage, error) {
	var last map[string]*v1.DmLastMessage
	rs, err := visible(ctx, q, ws, m, &last)
	return rs, last, err
}

// lastMessage converts a LastMessagesRow to the list preview (same shape as a DM's).
func lastMessage(l sqlc.LastMessagesRow) *v1.DmLastMessage {
	return &v1.DmLastMessage{
		Id: l.ID.String(), AuthorId: l.AuthorID.String(), Content: l.Preview,
		AttachmentCount: uint32(max(l.Attachments, 0)), CreatedAt: timestamppb.New(l.CreatedAt), //nolint:gosec // 0..20
		StickerEmoji: l.StickerEmoji,
	}
}

// VisibleIDs returns the ids of rooms userID can see (no last-message lookup).
func VisibleIDs(ctx context.Context, q *sqlc.Queries, ws sqlc.Workspace, m perm.Member) ([]uuid.UUID, error) {
	rs, err := visible(ctx, q, ws, m, nil)
	if err != nil {
		return nil, err
	}
	out := make([]uuid.UUID, len(rs))
	for i, r := range rs {
		out[i] = uuid.MustParse(r.GetId())
	}
	return out, nil
}

// VisibleBits returns the member's effective bits in every room they can see (ADR-0038: which
// meetings they see and may edit), without the last-message lookup.
func VisibleBits(ctx context.Context, q *sqlc.Queries, ws sqlc.Workspace, m perm.Member) (map[uuid.UUID]perm.Bits, error) {
	rs, err := visible(ctx, q, ws, m, nil)
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]perm.Bits, len(rs))
	for _, r := range rs {
		out[uuid.MustParse(r.GetId())] = perm.ComputeIn(m, r.GetRestricted(), pbconv.ProtoOverrideTargets(r.GetPermissionOverrides()))
	}
	return out, nil
}

// visible lists the rooms m can see; with last set it also fills Room.last_message_* and
// *last with the previews (one LastMessages query for all the rooms).
func visible(ctx context.Context, q *sqlc.Queries, ws sqlc.Workspace, m perm.Member, last *map[string]*v1.DmLastMessage) ([]*v1.Room, error) {
	rows, err := q.ListRooms(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	ovRows, err := q.ListWorkspaceRoomOverrides(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	byRoom := make(map[uuid.UUID][]sqlc.RoomPermission)
	for _, o := range ovRows {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
	}
	defaults := pbconv.WorkspaceDefaults(ws)
	out := make([]*v1.Room, 0, len(rows))
	ids := make([]uuid.UUID, 0, len(rows))
	for _, r := range rows {
		ovs := byRoom[r.ID]
		if !perm.ComputeIn(m, r.Restricted, pbconv.OverrideTargets(ovs)).Has(perm.ViewRoom) {
			continue
		}
		out = append(out, pbconv.Room(r, defaults, ovs))
		ids = append(ids, r.ID)
	}
	if last != nil && len(ids) > 0 {
		rows, err := q.LastMessages(ctx, ids)
		if err != nil {
			return nil, err
		}
		byID := make(map[string]*v1.DmLastMessage, len(rows))
		for _, l := range rows {
			byID[l.RoomID.String()] = lastMessage(l)
		}
		for _, r := range out {
			if l, ok := byID[r.GetId()]; ok {
				r.LastMessageId = l.GetId()
				r.LastMessageAt = l.GetCreatedAt()
			}
		}
		*last = byID
	}
	return out, nil
}

// workspaceAccess resolves the caller's workspace permissions; non-members get 404.
func workspaceAccess(r *http.Request, wsID uuid.UUID) (perm.Bits, perm.Role, error) {
	bits, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), wsID, auth.MustFromContext(r.Context()).UserID)
	if errors.Is(err, perm.ErrNotMember) {
		return 0, "", httpx.NotFound("workspace")
	}
	return bits, role, err
}

// Access resolves the caller's permissions in a room. Rooms the caller cannot see
// are reported as 404 so that their existence does not leak.
func Access(r *http.Request, roomID uuid.UUID) (perm.RoomAccess, error) { return roomAccess(r, roomID) }

// Publish sends an event of a room to everyone who may see it: a workspace room's event goes
// to the workspace channel (the gateway filters by VIEW_ROOM), a DM's to the user channels
// of its two participants (ADR-0020).
func Publish(ctx context.Context, pub events.Publisher, acc perm.RoomAccess, ev *v1.DispatchEvent) {
	if acc.DM {
		for _, u := range acc.Members {
			pub.User(ctx, u, ev)
		}
		return
	}
	pub.Workspace(ctx, acc.WorkspaceID, ev)
}

// WorkspaceIDString is the workspace_id of a room's events: empty for a DM.
func WorkspaceIDString(acc perm.RoomAccess) string {
	if acc.DM {
		return ""
	}
	return acc.WorkspaceID.String()
}

// WorkspaceMember returns the caller's roles in a workspace (404 for non-members).
func WorkspaceMember(r *http.Request, wsID uuid.UUID) (perm.Member, error) {
	m, err := perm.FromContext(r.Context()).Member(r.Context(), wsID, auth.MustFromContext(r.Context()).UserID)
	if errors.Is(err, perm.ErrNotMember) {
		return perm.Member{}, httpx.NotFound("workspace")
	}
	return m, err
}

// roomAccess: a live room the caller sees, else 404 — or 410 ROOM_ARCHIVED for an archived
// temporary room the caller could read (ADR-0044: nothing but its history is served).
func roomAccess(r *http.Request, roomID uuid.UUID) (perm.RoomAccess, error) {
	ctx, uid := r.Context(), auth.MustFromContext(r.Context()).UserID
	res := perm.FromContext(ctx)
	acc, err := res.Room(ctx, roomID, uid)
	if errors.Is(err, perm.ErrArchived) {
		if a, err := res.ReadRoom(ctx, roomID, uid); err == nil && a.Bits.Has(perm.ViewRoom) {
			return perm.RoomAccess{}, ErrRoomArchived
		}
		return perm.RoomAccess{}, httpx.NotFound("room")
	}
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && !acc.Bits.Has(perm.ViewRoom)) {
		return perm.RoomAccess{}, httpx.NotFound("room")
	}
	return acc, err
}

// ReadAccess is Access for reading a room's history: it also resolves an archived temporary
// room (acc.Archived) the caller has VIEW_ROOM in (ADR-0044). Only history reads use it.
func ReadAccess(r *http.Request, roomID uuid.UUID) (perm.RoomAccess, error) {
	acc, err := perm.FromContext(r.Context()).ReadRoom(r.Context(), roomID, auth.MustFromContext(r.Context()).UserID)
	if errors.Is(err, perm.ErrNoRoom) || (err == nil && !acc.Bits.Has(perm.ViewRoom)) {
		return perm.RoomAccess{}, httpx.NotFound("room")
	}
	return acc, err
}

// MaxUserLimit caps rooms.user_limit (0 = unlimited).
const MaxUserLimit = 99

func validLimit(limit uint32, roomType string) error {
	if limit > MaxUserLimit {
		return httpx.Validation("userLimit", "user limit must be 0..99")
	}
	if limit > 0 && roomType != "voice" {
		return httpx.Validation("userLimit", "user limit applies to voice rooms only")
	}
	return nil
}

// audioBitrates are the voice quality tiers 8 | 16 | 32 | 64 kbps (docs/02 «Битрейт»); 24 and 48
// predate the tiers and stay valid (older clients may still send them, the UI maps them to the
// nearest tier).
var audioBitrates = map[uint32]bool{8: true, 16: true, 24: true, 32: true, 48: true, 64: true}

// AudioBitrateError is the validation message for a bitrate outside audioBitrates.
const AudioBitrateError = "audio bitrate must be one of 8, 16, 32, 64"

// ValidAudioBitrate reports whether kbps is an allowed voice bitrate.
func ValidAudioBitrate(kbps uint32) bool { return audioBitrates[kbps] }

// MaxCameraLimit caps camera_limit (webcams at once in a voice room; 0 = cameras off).
const MaxCameraLimit = 25

// mediaDB is a validated media override in its DB form (nil = workspace default).
type mediaDB struct {
	audio, streams, cameras *int32
	preset                  *string
}

// mediaParams validates a media override and returns its DB form (nil = default).
func mediaParams(o *v1.RoomMediaOverride, field string) (mediaDB, error) {
	var m mediaDB
	if o == nil {
		return m, nil
	}
	if o.AudioBitrateKbps != nil {
		if !ValidAudioBitrate(o.GetAudioBitrateKbps()) {
			return m, httpx.Validation(field+".audioBitrateKbps", AudioBitrateError)
		}
		v := int32(o.GetAudioBitrateKbps()) //nolint:gosec // validated above
		m.audio = &v
	}
	if o.MaxStreamPreset != nil {
		s, ok := pbconv.PresetToDB(o.GetMaxStreamPreset())
		if !ok {
			return m, httpx.Validation(field+".maxStreamPreset", "invalid stream preset")
		}
		m.preset = &s
	}
	if o.MaxStreams != nil {
		if o.GetMaxStreams() > 10 {
			return m, httpx.Validation(field+".maxStreams", "max streams must be 0..10")
		}
		v := int32(o.GetMaxStreams()) //nolint:gosec // validated above
		m.streams = &v
	}
	if o.CameraLimit != nil {
		if o.GetCameraLimit() > MaxCameraLimit {
			return m, httpx.Validation(field+".cameraLimit", "camera limit must be 0..25")
		}
		v := int32(o.GetCameraLimit()) //nolint:gosec // validated above
		m.cameras = &v
	}
	return m, nil
}

func validName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 100 {
		return "", httpx.Validation("name", "name must be 1..100 characters")
	}
	return s, nil
}

func validTopic(s string) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > 1024 {
		return "", httpx.Validation("topic", "topic must be at most 1024 characters")
	}
	return s, nil
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	bits, _, err := workspaceAccess(r, wsID)
	if err != nil {
		return err
	}
	if !bits.Has(perm.ManageRoom) {
		return httpx.Forbidden("MANAGE_ROOM required")
	}
	var req v1.CreateRoomRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	typ, ok := pbconv.RoomTypeToDB(req.GetType())
	if !ok {
		return httpx.Validation("type", "room type must be VOICE or TEXT")
	}
	name, err := validName(req.GetName())
	if err != nil {
		return err
	}
	topic, err := validTopic(req.GetTopic())
	if err != nil {
		return err
	}
	media, err := mediaParams(req.GetMediaOverride(), "mediaOverride")
	if err != nil {
		return err
	}
	if typ != "voice" && (media.audio != nil || media.preset != nil || media.streams != nil || media.cameras != nil) {
		return httpx.Validation("mediaOverride", "media settings apply to voice rooms only")
	}
	if media.audio != nil {
		if err := h.plans.CheckAudio(r.Context(), wsID, storedAudio(media.audio), 0); err != nil {
			return err
		}
	}
	category, err := parseCategory(r.Context(), h.db.Q, wsID, req.GetCategoryId())
	if err != nil {
		return err
	}
	if err := validLimit(req.GetUserLimit(), typ); err != nil {
		return err
	}

	var (
		room sqlc.Room
		ws   sqlc.Workspace
		ovs  []sqlc.RoomPermission
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		if ws, err = q.GetWorkspace(r.Context(), wsID); err != nil {
			return err
		}
		room, err = q.CreateRoom(r.Context(), sqlc.CreateRoomParams{
			WorkspaceID:      wsID,
			Type:             typ,
			Name:             name,
			Topic:            topic,
			Position:         req.Position,
			IsPrivate:        req.GetIsPrivate(),
			AudioBitrateKbps: media.audio,
			MaxStreamPreset:  media.preset,
			MaxStreams:       media.streams,
			CameraLimit:      media.cameras,
			CategoryID:       category,
			UserLimit:        int32(req.GetUserLimit()), //nolint:gosec // ≤ 99
			CreatedBy:        ptr(auth.MustFromContext(r.Context()).UserID),
		})
		if err != nil {
			return err
		}
		if room.IsPrivate {
			if err := setPrivate(r.Context(), q, wsID, room.ID, true); err != nil {
				return err
			}
		}
		ovs, err = q.ListRoomOverrides(r.Context(), room.ID)
		return err
	})
	if err != nil {
		return err
	}
	pb := pbconv.Room(room, pbconv.WorkspaceDefaults(ws), ovs)
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomCreate{RoomCreate: &v1.RoomCreate{Room: pb}}})
	httpx.Write(w, http.StatusCreated, &v1.CreateRoomResponse{Room: pb})
	return nil
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	m, err := WorkspaceMember(r, wsID)
	if err != nil {
		return err
	}
	if r.URL.Query().Get("archived") == "1" {
		return h.listArchived(w, r, wsID, m)
	}
	ws, err := h.db.Q.GetWorkspace(r.Context(), wsID)
	if err != nil {
		return err
	}
	rooms, _, err := Visible(r.Context(), h.db.Q, ws, m)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.ListRoomsResponse{Rooms: rooms})
	return nil
}

// load returns the wire room (effective media + overrides).
func (h *Handlers) load(ctx context.Context, q *sqlc.Queries, room sqlc.Room) (*v1.Room, error) {
	return Load(ctx, q, room)
}

// Load returns the wire room (effective media + overrides), as sent in ROOM_UPDATE.
func Load(ctx context.Context, q *sqlc.Queries, room sqlc.Room) (*v1.Room, error) {
	if room.WorkspaceID == nil {
		return pbconv.DMRoom(room), nil
	}
	ws, err := q.GetWorkspace(ctx, *room.WorkspaceID)
	if err != nil {
		return nil, err
	}
	ovs, err := q.ListRoomOverrides(ctx, room.ID)
	if err != nil {
		return nil, err
	}
	return pbconv.Room(room, pbconv.WorkspaceDefaults(ws), ovs), nil
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) error {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return err
	}
	acc, err := roomAccess(r, roomID)
	if err != nil {
		return err
	}
	room, err := h.db.Q.GetRoom(r.Context(), roomID)
	if db.IsNotFound(err) {
		return httpx.NotFound("room")
	}
	if err != nil {
		return err
	}
	pb, err := h.load(r.Context(), h.db.Q, room)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetRoomResponse{Room: pb, Permissions: uint64(acc.Bits)})
	return nil
}

func (h *Handlers) manage(r *http.Request) (uuid.UUID, perm.RoomAccess, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return uuid.Nil, perm.RoomAccess{}, err
	}
	acc, err := roomAccess(r, roomID)
	if err != nil {
		return uuid.Nil, perm.RoomAccess{}, err
	}
	if !MayManage(acc, auth.MustFromContext(r.Context()).UserID) {
		return uuid.Nil, perm.RoomAccess{}, httpx.Forbidden("MANAGE_ROOM required")
	}
	return roomID, acc, nil
}

func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, err := h.manage(r)
	if err != nil {
		return err
	}
	var req v1.UpdateRoomRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateRoomParams{ID: roomID, Position: req.Position}
	if req.Name != nil {
		n, err := validName(req.GetName())
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.Topic != nil {
		t, err := validTopic(req.GetTopic())
		if err != nil {
			return err
		}
		p.Topic = &t
	}
	if req.UserLimit != nil {
		if req.GetUserLimit() > MaxUserLimit {
			return httpx.Validation("userLimit", "user limit must be 0..99")
		}
		v := int32(req.GetUserLimit()) //nolint:gosec // ≤ 99
		p.UserLimit = &v
	}
	if req.AllowRecording != nil {
		// Recording consent is the workspace's call (ADR-0025): MANAGE_RECORDINGS (ADR-0048).
		if !acc.Member.Workspace().Has(perm.ManageRecordings) || acc.Role == perm.RoleGuest {
			return httpx.Forbidden("MANAGE_RECORDINGS required to change allow_recording")
		}
		p.AllowRecording = req.AllowRecording
	}
	if req.Restricted != nil {
		// A closed room (ADR-0048, was owner-only in ADR-0029): MANAGE_ROOM in the room (h.manage;
		// the creator of a temporary room too). In a closed room only the owner and those let in
		// by an override have it, so the owner can always open it again.
		p.Restricted = req.Restricted
	}
	if req.GuestApproval != nil && !acc.Bits.Has(perm.ManageRoom) && !acc.Bits.Has(perm.InviteGuests) {
		// The creator of a temporary room (ADR-0044) decides how guests enter only with INVITE_GUESTS.
		return httpx.Forbidden("INVITE_GUESTS required to change guest_approval")
	}
	p.GuestApproval = req.GuestApproval // ADR-0040: MANAGE_ROOM, like the room's links
	tp, err := tempPatch(&req, acc, time.Now())
	if err != nil {
		return err
	}
	if req.CategoryId != nil {
		p.SetCategory = true
		if p.CategoryID, err = parseCategory(r.Context(), h.db.Q, acc.WorkspaceID, req.GetCategoryId()); err != nil {
			return err
		}
	}
	if req.MediaOverride != nil {
		p.SetMedia = true
		m, err := mediaParams(req.GetMediaOverride(), "mediaOverride")
		if err != nil {
			return err
		}
		p.AudioBitrateKbps, p.MaxStreamPreset, p.MaxStreams, p.CameraLimit = m.audio, m.preset, m.streams, m.cameras
		if m.audio != nil {
			cur, err := h.db.Q.GetRoom(r.Context(), roomID)
			if err != nil {
				return err
			}
			if err := h.plans.CheckAudio(r.Context(), acc.WorkspaceID, storedAudio(m.audio), storedAudio(cur.AudioBitrateKbps)); err != nil {
				return err
			}
		}
	}
	var pb *v1.Room
	var publishMeetings func(context.Context)
	restrictedChanged := false // who sees the room changed (restricted or is_private)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if p.Restricted != nil || tp.any() {
			cur, err := q.GetRoomForUpdate(r.Context(), roomID)
			if db.IsNotFound(err) {
				return httpx.NotFound("room")
			}
			if err != nil {
				return err
			}
			private := cur.IsPrivate
			if tp.private != nil {
				private = *tp.private
			}
			restricted := cur.Restricted
			if p.Restricted != nil {
				restricted = *p.Restricted
			}
			if p.Restricted != nil && *p.Restricted && !private {
				return httpx.Validation("restricted", "only private rooms can be restricted")
			}
			if restricted && !private {
				return httpx.Validation("isPrivate", "a restricted room stays private")
			}
			restrictedChanged = cur.Restricted != restricted || cur.IsPrivate != private
			if publishMeetings, err = h.applyTempPatch(r.Context(), q, cur, tp); err != nil {
				return err
			}
			if restricted && !cur.Restricted && acc.Role != perm.RoleOwner {
				// Whoever closes the room keeps it (ADR-0048): a personal VIEW_ROOM, plus MANAGE_ROOM
				// when they had it — the creator of a temporary room manages it as its creator, and
				// closing must not hand them MANAGE_ROOM (make_permanent, wider overrides).
				if err := q.GrantUserOverride(r.Context(), sqlc.GrantUserOverrideParams{
					RoomID: roomID, UserID: auth.MustFromContext(r.Context()).UserID.String(), Allow: int64(perm.ViewRoom | acc.Bits&perm.ManageRoom), //nolint:gosec // bit mask
				}); err != nil {
					return err
				}
			}
		}
		room, err := q.UpdateRoom(r.Context(), p)
		if db.IsNotFound(err) {
			return httpx.NotFound("room")
		}
		if err != nil {
			return err
		}
		if room.Type != "voice" && room.UserLimit > 0 {
			return httpx.Validation("userLimit", "user limit applies to voice rooms only")
		}
		if room.Type != "voice" && (room.AudioBitrateKbps != nil || room.MaxStreamPreset != nil || room.MaxStreams != nil || room.CameraLimit != nil) {
			return httpx.Validation("mediaOverride", "media settings apply to voice rooms only")
		}
		pb, err = h.load(r.Context(), q, room)
		return err
	})
	if err != nil {
		return err
	}
	update := &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{RoomUpdate: &v1.RoomUpdate{Room: pb}}}
	if !restrictedChanged {
		h.events.Workspace(r.Context(), acc.WorkspaceID, update)
	} else {
		// Who sees the room changed (ADR-0029): the gateway turns the ROOM_UPDATE into
		// ROOM_CREATE / ROOM_DELETE per recipient; the permissions update (same overrides)
		// makes rtc.SyncPublisher re-grant or remove the room's call participants.
		perm.FromContext(r.Context()).Invalidate()
		h.events.WorkspaceEvents(r.Context(), acc.WorkspaceID, []*v1.DispatchEvent{update, {Event: &v1.DispatchEvent_RoomPermissionsUpdate{RoomPermissionsUpdate: &v1.RoomPermissionsUpdate{
			WorkspaceId: acc.WorkspaceID.String(), RoomId: roomID.String(), Permissions: pb.GetPermissionOverrides(),
		}}}})
	}
	if publishMeetings != nil {
		publishMeetings(r.Context())
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateRoomResponse{Room: pb})
	return nil
}

// ReasonOwnerOnly (ApiError.reason, 403): only the workspace owner may do this (ADR-0029).
const ReasonOwnerOnly = "OWNER_ONLY"

func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, err := h.manage(r)
	if err != nil {
		return err
	}
	if acc.Temp {
		// ADR-0044: into the archive — history readable, links revoked, meetings closed, the
		// call ends (ROOM_DELETE).
		ok, err := h.archiveTemp(r.Context(), roomID, false)
		if err != nil {
			return err
		}
		if !ok {
			return httpx.NotFound("room")
		}
		httpx.NoContent(w)
		return nil
	}
	// A permanent room: archived and hidden for good (unchanged).
	n, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) { return guarded.ArchiveRoom(r.Context(), roomID) })
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("room")
	}
	h.events.Workspace(r.Context(), acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomDelete{
		RoomDelete: &v1.RoomDelete{WorkspaceId: acc.WorkspaceID.String(), RoomId: roomID.String()},
	}})
	httpx.NoContent(w)
	return nil
}

// validateOverrides checks targets and bits. A non-administrator may only allow bits
// they hold in this room themselves (no privilege escalation through overrides).
func validateOverrides(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, actor perm.RoomAccess, existing []sqlc.RoomPermission, in []*v1.RoomPermissionOverride) ([]sqlc.InsertRoomOverrideParams, error) {
	if len(in) > MaxOverrides {
		return nil, httpx.Validation("overrides", "too many overrides")
	}
	// A non-administrator may only change what is within their own bits: they cannot add
	// allows they lack, and cannot drop allows (set by an admin) that they lack either.
	// Re-submitting an existing entry unchanged is always fine.
	prev := map[string]perm.Bits{}
	prevDeny := map[string]perm.Bits{}
	for _, e := range existing {
		prev[e.TargetType+":"+e.TargetID] = perm.Bits(uint64(e.Allow))    //nolint:gosec // bit mask
		prevDeny[e.TargetType+":"+e.TargetID] = perm.Bits(uint64(e.Deny)) //nolint:gosec // bit mask
	}
	admin := actor.Bits.Has(perm.Administrator)
	// Without MANAGE_ROOM the actor is the creator of a temporary room (ADR-0044, MayManage):
	// their denies are bounded by their own bits too (no MANAGE_ROOM deny locking moderators
	// out), and a guest account gets in only with INVITE_GUESTS (as through a guest link).
	creator := !actor.Bits.Has(perm.ManageRoom)
	// Role targets: a role id of this workspace, or (clients before ADR-0026) the name of a
	// built-in role, stored as its id.
	roleRows, err := q.ListWorkspaceRoles(ctx, wsID)
	if err != nil {
		return nil, err
	}
	roleIDs := make(map[string]string, len(roleRows)+4)
	for _, rr := range roleRows {
		roleIDs[rr.ID.String()] = rr.ID.String()
		if rr.Builtin != nil {
			roleIDs[*rr.Builtin] = rr.ID.String()
		}
	}
	seen := map[string]bool{}
	out := make([]sqlc.InsertRoomOverrideParams, 0, len(in))
	for i, o := range in {
		field := "overrides[" + strconv.Itoa(i) + "]"
		tt, ok := pbconv.TargetTypeToDB(o.GetTargetType())
		if !ok {
			return nil, httpx.Validation(field+".targetType", "target type must be ROLE or USER")
		}
		target := o.GetTargetId()
		switch tt {
		case "role":
			id, ok := roleIDs[strings.ToLower(target)]
			if !ok {
				return nil, httpx.Validation(field+".targetId", "unknown role")
			}
			target = id
		case "user":
			uid, err := uuid.Parse(target)
			if err != nil {
				return nil, httpx.Validation(field+".targetId", "invalid user id")
			}
			m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: uid})
			if err != nil {
				if db.IsNotFound(err) {
					return nil, httpx.Validation(field+".targetId", "user is not a member of the workspace")
				}
				return nil, err
			}
			target = uid.String()
			if creator && !admin && m.Role == string(perm.RoleGuest) && !actor.Bits.Has(perm.InviteGuests) &&
				perm.Bits(o.GetAllow())&^prev["user:"+target] != 0 {
				return nil, httpx.Forbidden("INVITE_GUESTS required to let a guest into the room")
			}
		}
		if seen[tt+":"+target] {
			return nil, httpx.Validation(field, "duplicate target")
		}
		seen[tt+":"+target] = true
		allow, deny := perm.Bits(o.GetAllow()), perm.Bits(o.GetDeny())
		if (allow|deny)&^perm.RoomOnly != 0 {
			return nil, httpx.Validation(field, "workspace-level and board permissions cannot be set per room")
		}
		if allow&deny != 0 {
			return nil, httpx.Validation(field, "a bit cannot be both allowed and denied")
		}
		if !admin {
			old := prev[tt+":"+target]
			if (allow&^old)&^actor.Bits != 0 {
				return nil, httpx.Forbidden("cannot allow permissions you do not have")
			}
			if (old&^allow)&^actor.Bits != 0 {
				return nil, httpx.Forbidden("cannot remove permissions you do not have")
			}
			if creator && (deny^prevDeny[tt+":"+target])&^actor.Bits != 0 {
				return nil, httpx.Forbidden("cannot deny or lift permissions you do not have")
			}
			delete(prev, tt+":"+target)
			delete(prevDeny, tt+":"+target)
		}
		out = append(out, sqlc.InsertRoomOverrideParams{
			TargetType: tt, TargetID: target,
			Allow: int64(allow), Deny: int64(deny), //nolint:gosec // bits < 2^11
		})
	}
	if !admin {
		for k, old := range prev { // entries the request drops entirely
			if old&^actor.Bits != 0 || (creator && prevDeny[k]&^actor.Bits != 0) {
				return nil, httpx.Forbidden("cannot remove permissions you do not have")
			}
		}
	}
	return out, nil
}

func (h *Handlers) setPermissions(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, err := h.manage(r)
	if err != nil {
		return err
	}
	var req v1.SetRoomPermissionsRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var pb *v1.Room
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		existing, err := q.ListRoomOverrides(r.Context(), roomID)
		if err != nil {
			return err
		}
		params, err := validateOverrides(r.Context(), q, acc.WorkspaceID, acc, existing, req.GetOverrides())
		if err != nil {
			return err
		}
		room, err := q.GetRoom(r.Context(), roomID)
		if db.IsNotFound(err) {
			return httpx.NotFound("room")
		}
		if err != nil {
			return err
		}
		if err := q.DeleteRoomOverrides(r.Context(), roomID); err != nil {
			return err
		}
		for _, p := range params {
			p.RoomID = roomID
			if err := q.InsertRoomOverride(r.Context(), p); err != nil {
				return err
			}
		}
		pb, err = h.load(r.Context(), q, room)
		return err
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	h.events.Workspace(r.Context(), acc.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomPermissionsUpdate{
		RoomPermissionsUpdate: &v1.RoomPermissionsUpdate{
			WorkspaceId: acc.WorkspaceID.String(), RoomId: roomID.String(), Permissions: pb.GetPermissionOverrides(),
		},
	}})
	httpx.Write(w, http.StatusOK, &v1.SetRoomPermissionsResponse{Room: pb})
	return nil
}

func ptr[T any](v T) *T { return &v }
