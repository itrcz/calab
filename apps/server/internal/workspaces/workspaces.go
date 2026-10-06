// Package workspaces implements workspaces, membership, roles and invites.
package workspaces

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
)

const (
	// Invite codes: 10 chars from an alphabet without look-alikes (0/O, 1/l/I) ≈ 58 bits.
	inviteAlphabet  = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
	inviteCodeLen   = 10
	maxInviteUses   = 10000
	maxInviteExpiry = 365 * 24 * time.Hour
)

func newInviteCode() (string, error) {
	b := make([]byte, inviteCodeLen)
	n := big.NewInt(int64(len(inviteAlphabet)))
	for i := range b {
		k, err := rand.Int(rand.Reader, n)
		if err != nil {
			return "", err
		}
		b[i] = inviteAlphabet[k.Int64()]
	}
	return string(b), nil
}

// Handlers serves workspace endpoints.
type Handlers struct {
	db     *db.DB
	events events.Publisher
	store  blob.Store
	limits Limits
	email  EmailInvites
	files  *files.Service
	voice  rooms.VoiceRooms // nil: guests see nobody through a call (WithVoice)
	// emailGate: whether creating workspaces and invitations needs a confirmed address
	// (ADR-0023, EMAIL_VERIFICATION, ADR-0065). The zero value requires one.
	emailGate auth.EmailGate
}

// Limits against abuse of the shared disk (security review H2).
type Limits struct {
	MaxOwned      int                 // workspaces a user may own
	Quota         int64               // storage quota of a new workspace
	CreateLimiter *redisx.RateLimiter // creations per user (3/h)
	Plans         *plans.Service      // fills Workspace.plan (ADR-0024); nil = unset
	// PreviewLimiter: public invite previews per IP (30/min); nil = unlimited.
	PreviewLimiter *redisx.RateLimiter
}

// NewHandlers creates the workspace handlers.
func NewHandlers(d *db.DB, ev events.Publisher, store blob.Store, limits Limits) *Handlers {
	return &Handlers{db: d, events: ev, store: store, limits: limits}
}

// WithEmailGate applies EMAIL_VERIFICATION to creating workspaces and invitations (ADR-0065).
func (h *Handlers) WithEmailGate(g auth.EmailGate) *Handlers { h.emailGate = g; return h }

// Routes registers authenticated routes; wrap must apply auth + perm resolver.
func (h *Handlers) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	handle := func(pattern string, f httpx.HandlerFunc) { mux.Handle(pattern, wrap(f)) }
	handle("POST /api/workspaces", h.create)
	handle("GET /api/workspaces", h.list)
	handle("GET /api/workspaces/discover", h.discover)
	handle("GET /api/workspaces/{id}", h.get)
	handle("PATCH /api/workspaces/{id}", h.update)
	handle("DELETE /api/workspaces/{id}", h.delete)
	handle("POST /api/workspaces/{id}/join", h.joinOpen)
	handle("PUT /api/workspaces/{id}/notifications", h.setNotifications)
	handle("GET /api/workspaces/{id}/invites", h.listInvites)
	handle("POST /api/workspaces/{id}/invites", h.createInvite)
	handle("DELETE /api/workspaces/{id}/invites/{inviteId}", h.deleteInvite)
	handle("GET /api/workspaces/{id}/members", h.listMembers)
	handle("GET /api/workspaces/{id}/members/{userId}", h.getMember)
	handle("PATCH /api/workspaces/{id}/members/{userId}", h.updateMember)
	handle("DELETE /api/workspaces/{id}/members/{userId}", h.removeMember)
	handle("POST /api/workspaces/{id}/members/{userId}/promote", h.promote)
	// Public: the /join/<code> page of a signed-out visitor (invitation email) needs it.
	mux.Handle("GET /api/invites/{code}", httpx.HandlerFunc(h.getInvite))
	handle("POST /api/invites/{code}/join", h.joinInvite)
	h.emailRoutes(handle)
	h.roleRoutes(handle)
	h.banRoutes(handle)
	h.birthdayRoutes(handle)
	h.badgeRoutes(handle)
	h.backgroundRoutes(handle)
	h.appRoutes(handle)
}

func uid(r *http.Request) uuid.UUID { return auth.MustFromContext(r.Context()).UserID }

// errBotAdmin: a bot keeps the built-in member role (ADR-0031); its rights come from custom
// roles and room overrides.
var errBotAdmin = httpx.Validation("role", "a bot cannot be an admin or a guest: give it a role instead")

// access returns the caller's workspace bits and role; non-members get 404.
func access(r *http.Request) (uuid.UUID, perm.Bits, perm.Role, error) {
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

// requireManage: MANAGE_WORKSPACE — settings, appearance, plan, danger zone, guest policy,
// camera backgrounds (what ADR-0048 left there).
func requireManage(r *http.Request) (uuid.UUID, perm.Role, error) {
	return requireBit(r, perm.ManageWorkspace, "MANAGE_WORKSPACE")
}

// requireMembers: MANAGE_MEMBERS (ADR-0048) — remove, ban, promote, badges, built-in role.
func requireMembers(r *http.Request) (uuid.UUID, perm.Role, error) {
	return requireBit(r, perm.ManageMembers, "MANAGE_MEMBERS")
}

// requireBit: the caller holds the workspace-level bit; guests never pass (none of these bits
// is in the guest set, a role given to a guest could still carry one).
func requireBit(r *http.Request, bit perm.Bits, name string) (uuid.UUID, perm.Role, error) {
	wsID, bits, role, err := access(r)
	if err != nil {
		return uuid.Nil, "", err
	}
	if !bits.Has(bit) || (role == perm.RoleGuest && bit != perm.ManageWorkspace) {
		return uuid.Nil, "", httpx.Forbidden(name + " required")
	}
	return wsID, role, nil
}

// requireInvite: the caller may invite members to the workspace (INVITE_MEMBERS, ADR-0043) —
// invite links, e-mail invitations, adding an account.
func requireInvite(r *http.Request) (uuid.UUID, perm.Role, error) {
	wsID, bits, role, err := access(r)
	if err != nil {
		return uuid.Nil, "", err
	}
	if !bits.Has(perm.InviteMembers) || role == perm.RoleGuest { // guests never invite (ADR-0043)
		return uuid.Nil, "", httpx.Forbidden("INVITE_MEMBERS required")
	}
	return wsID, role, nil
}

// Snapshot builds the workspace state as seen by userID (rooms filtered by VIEW_ROOM), with
// the plan from pl (nil = unset). Voice states and presences are filled in by the gateway.
func Snapshot(ctx context.Context, q *sqlc.Queries, pl *plans.Service, ws sqlc.Workspace, userID uuid.UUID, me perm.Member) (*v1.WorkspaceSnapshot, error) {
	role := me.Role
	rs, err := rooms.Visible(ctx, q, ws, me)
	if err != nil {
		return nil, err
	}
	ms, err := q.ListMembers(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	roles, err := q.ListWorkspaceRoles(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	badges, err := q.ListWorkspaceBadges(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	backgrounds, err := q.ListWorkspaceBackgrounds(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	sounds, err := q.ListWorkspaceSounds(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	// Web apps (ADR-0050): not for guests; the gateway drops them for bots.
	var apps []sqlc.WorkspaceApp
	if SeesApps(role) {
		if apps, err = q.ListWorkspaceApps(ctx, ws.ID); err != nil {
			return nil, err
		}
	}
	var allowed map[uuid.UUID]bool
	if role == perm.RoleGuest { // the people in the guest's calls are added by the gateway (fillLive)
		if allowed, err = rooms.GuestVisibleUsers(ctx, q, nil, ws.ID, userID); err != nil {
			return nil, err
		}
	}
	members := make([]*v1.WorkspaceMember, 0, len(ms))
	for _, m := range ms {
		if allowed == nil || allowed[m.User.ID] {
			members = append(members, pbconv.Member(m.WorkspaceMember, m.User, m.RoleIds))
		}
	}
	bits := make(map[string]uint64, len(rs))
	for _, r := range rs {
		bits[r.GetId()] = uint64(perm.ComputeIn(me, r.GetRestricted(), pbconv.ProtoOverrideTargets(r.GetPermissionOverrides())))
	}
	cats, err := q.ListCategories(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	pw := pbconv.Workspace(ws)
	if err := pl.Fill(ctx, pw); err != nil {
		return nil, err
	}
	recs, err := q.ListActiveRecordings(ctx, &ws.ID)
	if err != nil {
		return nil, err
	}
	var recordings []*v1.RoomRecording
	for _, rec := range recs {
		if _, ok := bits[rec.RoomID.String()]; ok && pbconv.RecordingActive(rec) {
			recordings = append(recordings, pbconv.RoomRecording(rec))
		}
	}
	// Phone calls (ADR-0046) live in the visible rooms.
	var sipCalls []*v1.SipCall
	if ws.SipEnabled {
		live, err := q.ListLiveSipCallsByWorkspace(ctx, ws.ID)
		if err != nil {
			return nil, err
		}
		for _, c := range live {
			if c.RoomID == nil {
				continue
			}
			if _, ok := bits[c.RoomID.String()]; ok {
				sipCalls = append(sipCalls, pbconv.SipCall(c))
			}
		}
	}
	// Task boards (ADR-0042 §4): the visible ones with the recipient's bits, and their unread tasks.
	bs, unread, err := boards.Snapshot(ctx, q, ws.ID, me)
	if err != nil {
		return nil, err
	}
	// Board categories (ADR-0058 §1): names only, to everyone but guests.
	var boardCats []*v1.BoardCategory
	if role != perm.RoleGuest {
		rows, err := q.ListBoardCategories(ctx, ws.ID)
		if err != nil {
			return nil, err
		}
		boardCats = boards.Categories(rows)
	}
	// active_events (ADR-0038 §6) are filled by the caller with calendar.FillActive: one query
	// for all the snapshots of a READY.
	return &v1.WorkspaceSnapshot{Workspace: pbconv.ForViewer(pw, role), Role: role.Proto(), Rooms: rs, Members: members,
		Permissions: bits, Categories: pbconv.Categories(cats), Recordings: recordings, Roles: pbconv.Roles(roles),
		Badges: pbconv.Badges(badges), Backgrounds: pbconv.Backgrounds(backgrounds), Sounds: pbconv.Sounds(sounds),
		Boards: bs, UnreadTaskIds: unread, SipCalls: sipCalls, Apps: pbconv.WorkspaceApps(apps), BoardCategories: boardCats}, nil
}

// MemberPB loads a member's role ids and converts the membership row.
func MemberPB(ctx context.Context, q *sqlc.Queries, m sqlc.WorkspaceMember, u sqlc.User) (*v1.WorkspaceMember, error) {
	ids, err := q.ListMemberRoleIDs(ctx, sqlc.ListMemberRoleIDsParams{WorkspaceID: m.WorkspaceID, UserID: m.UserID})
	if err != nil {
		return nil, err
	}
	return pbconv.Member(m, u, ids), nil
}

// joined publishes membership events after a user joined a workspace.
func (h *Handlers) joined(ctx context.Context, ws sqlc.Workspace, m sqlc.WorkspaceMember) {
	AnnounceJoin(ctx, h.db.Q, h.limits.Plans, h.events, ws, m)
}

// AnnounceJoin publishes WORKSPACE_MEMBER_ADD to the workspace and WORKSPACE_CREATE (with a
// snapshot) to the new member's devices.
func AnnounceJoin(ctx context.Context, q *sqlc.Queries, pl *plans.Service, pub events.Publisher, ws sqlc.Workspace, m sqlc.WorkspaceMember) {
	u, err := q.GetUser(ctx, m.UserID)
	if err == nil {
		if pb, err := MemberPB(ctx, q, m, u); err == nil {
			pub.Workspace(ctx, ws.ID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberAdd{
				WorkspaceMemberAdd: &v1.WorkspaceMemberAdd{Member: pb},
			}})
		}
	}
	me, err := perm.NewResolver(q).Member(ctx, ws.ID, m.UserID)
	if err != nil {
		return
	}
	if snap, err := Snapshot(ctx, q, pl, ws, m.UserID, me); err == nil {
		isBot := false
		if u, err := q.GetUser(ctx, m.UserID); err == nil {
			isBot = u.IsBot
		}
		if isBot {
			snap.Apps = nil // web apps are for people (ADR-0050)
		}
		if err := calendar.FillActive(ctx, q, m.UserID, isBot, []*v1.WorkspaceSnapshot{snap}, time.Now()); err != nil {
			slog.WarnContext(ctx, "workspace snapshot: meetings", "err", err)
		}
		pub.User(ctx, m.UserID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceCreate{
			WorkspaceCreate: &v1.WorkspaceCreate{Snapshot: snap},
		}})
	}
}

// notGuestAccount rejects guest accounts (ADR-0016: guests only use the rooms they were
// invited to; they cannot create or join workspaces on their own).
func (h *Handlers) notGuestAccount(r *http.Request) error {
	u, err := h.db.Q.GetUser(r.Context(), uid(r))
	if err != nil {
		return err
	}
	if u.IsGuest {
		return httpx.Forbidden("not available for guest accounts")
	}
	return nil
}

func slugConflict(err error) error {
	if db.UniqueViolation(err) == "workspaces_slug_key" {
		e := httpx.Conflict("slug is already taken")
		e.Field = "slug"
		return e
	}
	return err
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) error {
	if _, err := h.verifiedAccount(r); err != nil {
		return err
	}
	var req v1.CreateWorkspaceRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if err := ValidateSlug(req.GetSlug()); err != nil {
		return err
	}
	name, err := validateName(req.GetName())
	if err != nil {
		return err
	}
	vis, ok := pbconv.VisibilityToDB(req.GetVisibility())
	if !ok {
		return httpx.Validation("visibility", "invalid visibility")
	}
	if h.limits.CreateLimiter != nil {
		if err := h.limits.CreateLimiter.Take(r.Context(), uid(r).String()); err != nil {
			return err
		}
	}
	var (
		ws sqlc.Workspace
		m  sqlc.WorkspaceMember
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.LockUserWorkspaces(r.Context(), uid(r).String()); err != nil {
			return err
		}
		if h.limits.MaxOwned > 0 {
			n, err := q.CountOwnedWorkspaces(r.Context(), uid(r))
			if err != nil {
				return err
			}
			if int(n) >= h.limits.MaxOwned {
				return httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_WORKSPACE_LIMIT,
					fmt.Sprintf("you can own at most %d workspaces", h.limits.MaxOwned))
			}
		}
		var err error
		ws, err = q.CreateWorkspace(r.Context(), sqlc.CreateWorkspaceParams{Slug: req.GetSlug(), Name: name, Visibility: vis,
			OwnerID: uid(r), StorageQuotaBytes: h.limits.Quota})
		if err != nil {
			return slugConflict(err)
		}
		m, err = q.AddMember(r.Context(), sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: uid(r), Role: string(perm.RoleOwner)})
		return err
	})
	if err != nil {
		return err
	}
	h.joined(r.Context(), ws, m)
	pw := pbconv.Workspace(ws)
	if err := h.limits.Plans.Fill(r.Context(), pw); err != nil {
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.CreateWorkspaceResponse{Workspace: pw})
	return nil
}

func workspaceList(rows []sqlc.Workspace) []*v1.Workspace {
	out := make([]*v1.Workspace, len(rows))
	for i, w := range rows {
		out[i] = pbconv.Workspace(w)
	}
	return out
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) error {
	rows, err := h.db.Q.ListUserWorkspaces(r.Context(), uid(r))
	if err != nil {
		return err
	}
	filtered := rows[:0]
	for _, row := range rows {
		if err := perm.CheckAccess(r.Context(), row.ID, uid(r)); err == nil {
			filtered = append(filtered, row)
		} else if httpx.AsError(err).Status >= 500 {
			return err
		}
	}
	list := workspaceList(filtered)
	if err := h.limits.Plans.FillAll(r.Context(), list); err != nil {
		return err
	}
	for i, ws := range list { // the suspension reason is for the owner / admins only
		if ws.GetSuspension() == nil {
			continue
		}
		id, _ := uuid.Parse(ws.GetId())
		_, role, err := perm.FromContext(r.Context()).Workspace(r.Context(), id, uid(r))
		if err != nil && !errors.Is(err, perm.ErrNotMember) {
			return err
		}
		list[i] = pbconv.ForViewer(ws, role)
	}
	httpx.Write(w, http.StatusOK, &v1.ListWorkspacesResponse{Workspaces: list})
	return nil
}

func (h *Handlers) discover(w http.ResponseWriter, r *http.Request) error {
	if err := h.notGuestAccount(r); err != nil {
		return err
	}
	rows, err := h.db.Q.ListOpenWorkspacesForUser(r.Context(), uid(r))
	if err != nil {
		return err
	}
	list := workspaceList(rows)
	for i, ws := range list {
		list[i] = pbconv.ForViewer(ws, "")
	}
	httpx.Write(w, http.StatusOK, &v1.DiscoverWorkspacesResponse{Workspaces: list})
	return nil
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) error {
	wsID, _, role, err := access(r)
	if err != nil {
		return err
	}
	ws, err := h.db.Q.GetWorkspace(r.Context(), wsID)
	if err != nil {
		return err
	}
	pw := pbconv.Workspace(ws)
	if err := h.limits.Plans.Fill(r.Context(), pw); err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetWorkspaceResponse{Workspace: pbconv.ForViewer(pw, role), Role: role.Proto()})
	return nil
}

func (h *Handlers) update(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireManage(r)
	if err != nil {
		return err
	}
	var req v1.UpdateWorkspaceRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	p := sqlc.UpdateWorkspaceParams{ID: wsID}
	if req.Slug != nil {
		if err := ValidateSlug(req.GetSlug()); err != nil {
			return err
		}
		p.Slug = req.Slug
	}
	if req.Name != nil {
		n, err := validateName(req.GetName())
		if err != nil {
			return err
		}
		p.Name = &n
	}
	if req.Visibility != nil {
		v, ok := pbconv.VisibilityToDB(req.GetVisibility())
		if !ok || req.GetVisibility() == v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_UNSPECIFIED {
			return httpx.Validation("visibility", "visibility must be PRIVATE or OPEN")
		}
		p.Visibility = &v
	}
	if req.IconFileId != nil {
		p.SetIcon = true
		if s := req.GetIconFileId(); s != "" {
			fid, err := uuid.Parse(s)
			if err != nil {
				return httpx.Validation("iconFileId", "invalid file id")
			}
			if err := files.ValidateOwnImage(r.Context(), h.db.Q, fid, uid(r), &wsID); err != nil {
				if files.IsBadImage(err) {
					return httpx.Validation("iconFileId", "must be an image uploaded to this workspace")
				}
				return err
			}
			p.IconFileID = &fid
		}
	}
	mediaChanged := false
	if req.DefaultAudioBitrateKbps != nil {
		if !rooms.ValidAudioBitrate(req.GetDefaultAudioBitrateKbps()) {
			return httpx.Validation("defaultAudioBitrateKbps", rooms.AudioBitrateError)
		}
		cur, err := h.db.Q.GetWorkspace(r.Context(), wsID)
		if err != nil {
			return err
		}
		// Above the plan's voice tier cap (ADR-0024); the stored value itself stays accepted.
		if err := h.limits.Plans.CheckAudio(r.Context(), wsID, req.GetDefaultAudioBitrateKbps(), uint32(max(cur.DefaultAudioBitrateKbps, 0))); err != nil { //nolint:gosec // DB CHECK bounds it
			return err
		}
		v := int32(req.GetDefaultAudioBitrateKbps()) //nolint:gosec // validated
		p.DefaultAudioBitrateKbps, mediaChanged = &v, true
	}
	if req.DefaultMaxStreamPreset != nil {
		s, ok := pbconv.PresetToDB(req.GetDefaultMaxStreamPreset())
		if !ok {
			return httpx.Validation("defaultMaxStreamPreset", "invalid stream preset")
		}
		p.DefaultMaxStreamPreset, mediaChanged = &s, true
	}
	if req.DefaultMaxStreams != nil {
		if req.GetDefaultMaxStreams() > 10 {
			return httpx.Validation("defaultMaxStreams", "max streams must be 0..10")
		}
		v := int32(req.GetDefaultMaxStreams()) //nolint:gosec // validated
		p.DefaultMaxStreams, mediaChanged = &v, true
	}
	if req.DefaultCameraLimit != nil {
		if req.GetDefaultCameraLimit() > rooms.MaxCameraLimit {
			return httpx.Validation("defaultCameraLimit", "camera limit must be 0..25")
		}
		v := int32(req.GetDefaultCameraLimit()) //nolint:gosec // validated
		p.DefaultCameraLimit, mediaChanged = &v, true
	}
	p.AllowSelfNickname = req.AllowSelfNickname
	if req.TimeFormat != nil {
		f, ok := pbconv.TimeFormatToDB(req.GetTimeFormat())
		if !ok {
			return httpx.Validation("timeFormat", "time format must be AUTO, H24 or H12")
		}
		p.TimeFormat = &f
	}
	ws, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.Workspace, error) { return guarded.UpdateWorkspace(r.Context(), p) })
	if db.IsForeignKeyViolation(err) {
		return httpx.Validation("iconFileId", "file not found")
	}
	if err != nil {
		return slugConflict(err)
	}
	pb := pbconv.Workspace(ws)
	if err := h.limits.Plans.Fill(r.Context(), pb); err != nil {
		return err
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceUpdate{WorkspaceUpdate: &v1.WorkspaceUpdate{Workspace: pb}}})
	if mediaChanged {
		h.publishRoomMedia(r.Context(), ws)
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateWorkspaceResponse{Workspace: pb})
	return nil
}

// publishRoomMedia re-sends voice rooms after workspace media defaults changed, since
// Room.media carries effective (merged) values.
func (h *Handlers) publishRoomMedia(ctx context.Context, ws sqlc.Workspace) {
	rs, err := h.db.Q.ListRooms(ctx, ws.ID)
	if err != nil {
		return
	}
	ovs, err := h.db.Q.ListWorkspaceRoomOverrides(ctx, ws.ID)
	if err != nil {
		return
	}
	byRoom := map[uuid.UUID][]sqlc.RoomPermission{}
	for _, o := range ovs {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
	}
	defaults := pbconv.WorkspaceDefaults(ws)
	var evs []*v1.DispatchEvent
	for _, room := range rs {
		if room.Type != "voice" {
			continue
		}
		evs = append(evs, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomUpdate{
			RoomUpdate: &v1.RoomUpdate{Room: pbconv.Room(room, defaults, byRoom[room.ID])},
		}})
	}
	h.events.WorkspaceEvents(ctx, ws.ID, evs)
}

func (h *Handlers) delete(w http.ResponseWriter, r *http.Request) error {
	wsID, _, role, err := access(r)
	if err != nil {
		return err
	}
	if role != perm.RoleOwner {
		return httpx.Forbidden("only the owner can delete a workspace")
	}
	var keys []sqlc.ListWorkspaceFileKeysRow
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		// Keys and deletion in one transaction: an upload committed in between would
		// otherwise leave its blob behind (uploads after the delete fail on the FK).
		var err error
		if keys, err = q.ListWorkspaceFileKeys(r.Context(), &wsID); err != nil {
			return err
		}
		_, err = q.DeleteWorkspace(r.Context(), wsID)
		return err
	})
	if err != nil {
		return err
	}
	if h.store != nil { // rows cascaded; remove the bytes
		go files.DeleteBlobs(context.WithoutCancel(r.Context()), h.store, keys)
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{
		WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: wsID.String()},
	}})
	httpx.NoContent(w)
	return nil
}

// join adds the caller as a member inside q, within the plan's members limit. Already a
// member → existing row, added=false.
func join(ctx context.Context, q *sqlc.Queries, pl *plans.Service, wsID, userID uuid.UUID) (m sqlc.WorkspaceMember, added bool, err error) {
	if m, err = q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: userID}); err == nil || !db.IsNotFound(err) {
		return m, false, err
	}
	if err = pl.Check(ctx, q, wsID, plans.KindMembers, true); err != nil {
		return m, false, err
	}
	m, err = q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: wsID, UserID: userID, Role: string(perm.RoleMember)})
	if db.IsNotFound(err) { // ON CONFLICT DO NOTHING
		m, err = q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: userID})
		return m, false, err
	}
	return m, err == nil, err
}

func (h *Handlers) memberResponse(ctx context.Context, ws sqlc.Workspace, m sqlc.WorkspaceMember) (*v1.JoinWorkspaceResponse, error) {
	if err := auth.CheckPublicCapability(ctx, h.db.Q, ws.ID); err != nil {
		if httpx.AsError(err).Code == v1.ErrorCode_ERROR_CODE_SSO_REQUIRED {
			return &v1.JoinWorkspaceResponse{IdentityAccess: &v1.WorkspaceIdentityAccess{WorkspaceId: ws.ID.String(), Mode: v1.IdentityPolicyMode_IDENTITY_POLICY_MODE_ENFORCED, Reason: v1.IdentityAccessReason_IDENTITY_ACCESS_REASON_SSO_REQUIRED}}, nil
		}
		return nil, err
	}
	u, err := h.db.Q.GetUser(ctx, m.UserID)
	if err != nil {
		return nil, err
	}
	pw := pbconv.Workspace(ws)
	if err := h.limits.Plans.Fill(ctx, pw); err != nil {
		return nil, err
	}
	pb, err := MemberPB(ctx, h.db.Q, m, u)
	if err != nil {
		return nil, err
	}
	return &v1.JoinWorkspaceResponse{Workspace: pbconv.ForViewer(pw, perm.Role(m.Role)), Member: pb}, nil
}

func (h *Handlers) joinOpen(w http.ResponseWriter, r *http.Request) error {
	if err := h.notGuestAccount(r); err != nil {
		return err
	}
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	ws, err := h.db.Q.GetWorkspace(r.Context(), wsID)
	if db.IsNotFound(err) {
		return httpx.NotFound("workspace")
	}
	if err != nil {
		return err
	}
	if ws.Visibility != "open" {
		// Do not reveal that a private workspace exists.
		if _, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: uid(r)}); err != nil {
			return httpx.NotFound("workspace")
		}
	}
	if _, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: uid(r)}); db.IsNotFound(err) {
		u, err := h.db.Q.GetUser(r.Context(), uid(r))
		if err != nil {
			return err
		}
		if err := moderation.CheckBan(r.Context(), h.db.Q, wsID, u.ID, u.Email); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	var (
		m     sqlc.WorkspaceMember
		added bool
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		m, added, err = join(r.Context(), q, h.limits.Plans, wsID, uid(r))
		return err
	})
	if err != nil {
		return err
	}
	if added {
		h.joined(r.Context(), ws, m)
	}
	resp, err := h.memberResponse(r.Context(), ws, m)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func inviteUsable(i sqlc.WorkspaceInvite, now time.Time) bool {
	return (i.ExpiresAt == nil || now.Before(*i.ExpiresAt)) && (i.MaxUses == 0 || i.Uses < i.MaxUses)
}

// getInvite: GET /api/invites/{code} — public preview (no token), limited per IP. It shows
// only what the link's holder may see before joining: the workspace's name / slug / icon,
// the member count and, for an invitation by email, the invited address.
func (h *Handlers) getInvite(w http.ResponseWriter, r *http.Request) error {
	if l := h.limits.PreviewLimiter; l != nil {
		if err := l.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
			return err
		}
	}
	inv, err := h.db.Q.GetInviteByCode(r.Context(), r.PathValue("code"))
	if db.IsNotFound(err) {
		return auth.ErrInviteInvalid()
	}
	if err != nil {
		return err
	}
	ei, err := h.db.Q.GetEmailInviteByInvite(r.Context(), inv.ID)
	emailed := err == nil
	if err != nil && !db.IsNotFound(err) {
		return err
	}
	// An accepted email invitation stays previewable until it expires: its invitee opens
	// the link again after the auto-join (joining then answers with the membership).
	if emailed && ei.AcceptedAt != nil {
		if inv.ExpiresAt != nil && !time.Now().Before(*inv.ExpiresAt) {
			return auth.ErrInviteInvalid()
		}
	} else if !inviteUsable(inv, time.Now()) {
		return auth.ErrInviteInvalid()
	}
	ws, err := h.db.Q.GetWorkspace(r.Context(), inv.WorkspaceID)
	if err != nil {
		return err
	}
	n, err := h.db.Q.CountWorkspaceMembers(r.Context(), ws.ID)
	if err != nil {
		return err
	}
	full := pbconv.Workspace(ws)
	resp := &v1.GetInviteResponse{
		Workspace:   &v1.Workspace{Id: full.GetId(), Slug: full.GetSlug(), Name: full.GetName(), IconFileId: full.GetIconFileId()},
		MemberCount: uint32(max(n, 0)), //nolint:gosec // a count
	}
	if inv.ExpiresAt != nil {
		resp.ExpiresAt = timestamppb.New(*inv.ExpiresAt)
	}
	if emailed {
		resp.Email = ei.Email
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) joinInvite(w http.ResponseWriter, r *http.Request) error {
	if err := h.notGuestAccount(r); err != nil { // guests only use room links (ADR-0016)
		return err
	}
	code := r.PathValue("code")
	caller, err := h.db.Q.GetUser(r.Context(), uid(r))
	if err != nil {
		return err
	}
	var (
		ws    sqlc.Workspace
		m     sqlc.WorkspaceMember
		added bool
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		inv, err := q.GetInviteByCode(r.Context(), code)
		if db.IsNotFound(err) {
			return auth.ErrInviteInvalid()
		}
		if err != nil {
			return err
		}
		if _, err = q.LockOAuthWorkspace(r.Context(), inv.WorkspaceID); err != nil {
			return err
		}
		if ws, err = q.GetWorkspace(r.Context(), inv.WorkspaceID); err != nil {
			return err
		}
		// An existing member does not burn a use.
		if existing, err := q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: ws.ID, UserID: uid(r)}); err == nil {
			m = existing
			return nil
		} else if !db.IsNotFound(err) {
			return err
		}
		if err := moderation.CheckBan(r.Context(), q, ws.ID, caller.ID, caller.Email); err != nil {
			return err
		}
		// The email binding first: a clear 403 for the wrong address beats «used up».
		role, err := boundInvite(r.Context(), q, inv, caller)
		if err != nil {
			return err
		}
		if err := h.limits.Plans.Check(r.Context(), q, ws.ID, plans.KindMembers, true); err != nil {
			return err
		}
		if _, err := q.ConsumeInvite(r.Context(), code); err != nil {
			if db.IsNotFound(err) {
				return auth.ErrInviteInvalid()
			}
			return err
		}
		m, err = q.AddMember(r.Context(), sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: uid(r), Role: string(role)})
		if db.IsNotFound(err) { // joined concurrently (ON CONFLICT DO NOTHING)
			m, err = q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: ws.ID, UserID: uid(r)})
			return err
		}
		added = err == nil
		return err
	})
	if err != nil {
		return err
	}
	if added {
		h.joined(r.Context(), ws, m)
	}
	resp, err := h.memberResponse(r.Context(), ws, m)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, resp)
	return nil
}

func (h *Handlers) createInvite(w http.ResponseWriter, r *http.Request) error {
	_, wsID, _, err := h.inviter(r)
	if err != nil {
		return err
	}
	// A link into a full workspace would only fail at the join: refuse it now (ADR-0024).
	if err := h.limits.Plans.Check(r.Context(), h.db.Q, wsID, plans.KindMembers, false); err != nil {
		return err
	}
	var req v1.CreateInviteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.GetMaxUses() > maxInviteUses {
		return httpx.Validation("maxUses", "maxUses must be 0..10000")
	}
	var expires *time.Time
	if s := req.GetExpiresInSeconds(); s > 0 {
		d := time.Duration(s) * time.Second
		if d > maxInviteExpiry {
			return httpx.Validation("expiresInSeconds", "invites expire in at most 365 days")
		}
		t := time.Now().Add(d)
		expires = &t
	}
	for range 3 {
		code, err := newInviteCode()
		if err != nil {
			return err
		}
		inv, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.WorkspaceInvite, error) {
			return guarded.CreateInvite(r.Context(), sqlc.CreateInviteParams{
				WorkspaceID: wsID, Code: code, CreatedBy: uid(r),
				MaxUses: int32(req.GetMaxUses()), ExpiresAt: expires, //nolint:gosec // validated
			})
		})
		if db.UniqueViolation(err) != "" {
			continue // astronomically unlikely code collision
		}
		if err != nil {
			return err
		}
		httpx.Write(w, http.StatusCreated, &v1.CreateInviteResponse{Invite: pbconv.Invite(inv)})
		return nil
	}
	return errors.New("invite code collisions")
}

func (h *Handlers) listInvites(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireInvite(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListInvites(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListInvitesResponse{Invites: make([]*v1.Invite, len(rows))}
	for i, inv := range rows {
		out.Invites[i] = pbconv.Invite(inv)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func (h *Handlers) deleteInvite(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireInvite(r)
	if err != nil {
		return err
	}
	invID, err := httpx.PathUUID(r, "inviteId", "invite")
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteInvite(r.Context(), sqlc.DeleteInviteParams{ID: invID, WorkspaceID: wsID})
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("invite")
	}
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) listMembers(w http.ResponseWriter, r *http.Request) error {
	wsID, _, role, err := access(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListMembers(r.Context(), wsID)
	if err != nil {
		return err
	}
	var allowed map[uuid.UUID]bool
	if role == perm.RoleGuest {
		if allowed, err = rooms.GuestVisibleUsers(r.Context(), h.db.Q, h.voice, wsID, uid(r)); err != nil {
			return err
		}
	}
	out := &v1.ListMembersResponse{Members: make([]*v1.WorkspaceMember, 0, len(rows))}
	for _, m := range rows {
		if allowed == nil || allowed[m.User.ID] {
			out.Members = append(out.Members, pbconv.Member(m.WorkspaceMember, m.User, m.RoleIds))
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// getMember: GET /api/workspaces/{id}/members/{userId} — one member's profile with their open
// tasks on the boards the caller sees (ADR-0051). A guest sees only the members visible to it.
func (h *Handlers) getMember(w http.ResponseWriter, r *http.Request) error {
	wsID, _, role, err := access(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	if role == perm.RoleGuest {
		allowed, err := rooms.GuestVisibleUsers(r.Context(), h.db.Q, h.voice, wsID, uid(r))
		if err != nil {
			return err
		}
		if !allowed[target] {
			return httpx.NotFound("member")
		}
	}
	m, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target})
	if db.IsNotFound(err) {
		return httpx.NotFound("member")
	}
	if err != nil {
		return err
	}
	u, err := h.db.Q.GetUser(r.Context(), target)
	if err != nil {
		return err
	}
	pb, err := MemberPB(r.Context(), h.db.Q, m, u)
	if err != nil {
		return err
	}
	me, err := perm.FromContext(r.Context()).Member(r.Context(), wsID, uid(r))
	if err != nil {
		return err
	}
	tasks, err := boards.OpenTasksOf(r.Context(), h.db.Pool, h.db.Q, wsID, me, uid(r), target)
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.GetMemberResponse{Member: pb, OpenTasks: tasks})
	return nil
}

// WithVoice lets the member endpoints count the people in a guest's call (perm.GuestVisible).
// Without it a guest does not see them through REST (fail-closed).
func (h *Handlers) WithVoice(v rooms.VoiceRooms) *Handlers {
	h.voice = v
	return h
}

// targetUser resolves the {userId} path value; "@me" is the caller.
func targetUser(r *http.Request) (uuid.UUID, error) {
	if strings.EqualFold(r.PathValue("userId"), "@me") {
		return uid(r), nil
	}
	return httpx.PathUUID(r, "userId", "member")
}

func (h *Handlers) updateMember(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, actorRole, err := access(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	var req v1.UpdateMemberRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	self := target == uid(r)
	cur, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target})
	if db.IsNotFound(err) {
		return httpx.NotFound("member")
	}
	if err != nil {
		return err
	}
	p := sqlc.UpdateMemberParams{WorkspaceID: wsID, UserID: target}
	if req.Nickname != nil {
		if !bits.Has(perm.ManageNicknames) {
			if !self {
				return httpx.Forbidden("MANAGE_NICKNAMES required to change others' nicknames")
			}
			ws, err := h.db.Q.GetWorkspace(r.Context(), wsID)
			if err != nil {
				return err
			}
			if !ws.AllowSelfNickname {
				return httpx.Forbidden("nicknames are set by admins in this workspace")
			}
		}
		n, err := validateNickname(req.GetNickname())
		if err != nil {
			return err
		}
		p.Nickname = &n
	}
	if req.Role != nil {
		newRole, ok := perm.RoleFromProto(req.GetRole())
		switch {
		case !ok:
			return httpx.Validation("role", "invalid role")
		case !bits.Has(perm.ManageMembers) || actorRole == perm.RoleGuest:
			return httpx.Forbidden("MANAGE_MEMBERS required")
		case self:
			return httpx.Forbidden("cannot change your own role")
		case newRole == perm.RoleOwner || perm.Role(cur.Role) == perm.RoleOwner:
			return httpx.Forbidden("ownership cannot be changed here")
		case (newRole == perm.RoleAdmin || perm.Role(cur.Role) == perm.RoleAdmin) && actorRole != perm.RoleOwner:
			return httpx.Forbidden("only the owner can grant or revoke admin")
		case perm.Role(cur.Role) == perm.RoleGuest && newRole != perm.RoleGuest:
			// Promotion also keeps guest accounts from being cleaned up: one path only.
			return httpx.Validation("role", "use POST …/members/{userId}/promote to make a guest a member")
		}
		if newRole == perm.RoleAdmin || newRole == perm.RoleGuest {
			if tu, err := h.db.Q.GetUser(r.Context(), target); err != nil {
				return err
			} else if tu.IsBot {
				return errBotAdmin
			}
		}
		if err := outranks(r, wsID, target); err != nil {
			return err
		}
		s := string(newRole)
		p.Role = &s
	}
	m, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (sqlc.WorkspaceMember, error) { return guarded.UpdateMember(r.Context(), p) })
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	u, err := h.db.Q.GetUser(r.Context(), target)
	if err != nil {
		return err
	}
	pb, err := MemberPB(r.Context(), h.db.Q, m, u)
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{
		WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: pb},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateMemberResponse{Member: pb})
	return nil
}

func (h *Handlers) removeMember(w http.ResponseWriter, r *http.Request) error {
	wsID, bits, actorRole, err := access(r)
	if err != nil {
		return err
	}
	target, err := targetUser(r)
	if err != nil {
		return err
	}
	cur, err := h.db.Q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target})
	if db.IsNotFound(err) {
		return httpx.NotFound("member")
	}
	if err != nil {
		return err
	}
	targetRole := perm.Role(cur.Role)
	if target == uid(r) {
		if targetRole == perm.RoleOwner {
			return httpx.Conflict("the owner cannot leave; delete the workspace or transfer ownership")
		}
	} else {
		switch {
		case !bits.Has(perm.ManageMembers) || actorRole == perm.RoleGuest:
			return httpx.Forbidden("MANAGE_MEMBERS required")
		case targetRole == perm.RoleOwner:
			return httpx.Forbidden("the owner cannot be removed")
		case targetRole == perm.RoleAdmin && actorRole != perm.RoleOwner:
			return httpx.Forbidden("only the owner can remove an admin")
		}
		if err := outranks(r, wsID, target); err != nil {
			return err
		}
	}
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		actor := uid(r)
		if err := auth.InvalidateIdentity(r.Context(), q, wsID, &target, &actor, "member_removed"); err != nil {
			return err
		}
		if _, err := q.RemoveMember(r.Context(), sqlc.RemoveMemberParams{WorkspaceID: wsID, UserID: target}); err != nil {
			return err
		}
		return q.DeleteUserOverridesInWorkspace(r.Context(), sqlc.DeleteUserOverridesInWorkspaceParams{WorkspaceID: wsID, UserID: target.String()})
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	// LiveKit participants of the removed user are disconnected by rtc.SyncPublisher.
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
		WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: wsID.String(), UserId: target.String()},
	}})
	h.events.User(r.Context(), target, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{
		WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: wsID.String()},
	}})
	httpx.NoContent(w)
	return nil
}

// promote: POST /api/workspaces/{id}/members/{userId}/promote (MANAGE_MEMBERS, ADR-0048) turns
// a guest into a member. A guest account is kept from then on (no inactivity cleanup).
func (h *Handlers) promote(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireMembers(r)
	if err != nil {
		return err
	}
	target, err := httpx.PathUUID(r, "userId", "member")
	if err != nil {
		return err
	}
	var m sqlc.WorkspaceMember
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		// A guest takes no seat, a member does (ADR-0024).
		if err := h.limits.Plans.Check(r.Context(), q, wsID, plans.KindMembers, true); err != nil {
			return err
		}
		var err error
		m, err = q.PromoteGuest(r.Context(), sqlc.PromoteGuestParams{WorkspaceID: wsID, UserID: target})
		if db.IsNotFound(err) {
			return httpx.NotFound("guest")
		}
		if err != nil {
			return err
		}
		return q.ClearGuestExpiry(r.Context(), target)
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	u, err := h.db.Q.GetUser(r.Context(), target)
	if err != nil {
		return err
	}
	pb, err := MemberPB(r.Context(), h.db.Q, m, u)
	if err != nil {
		return err
	}
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberUpdate{
		WorkspaceMemberUpdate: &v1.WorkspaceMemberUpdate{Member: pb},
	}})
	httpx.Write(w, http.StatusOK, &v1.UpdateMemberResponse{Member: pb})
	return nil
}
