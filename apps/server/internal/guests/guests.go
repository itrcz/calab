// Package guests implements room links and guest accounts (ADR-0016): a link is a capability
// for one room; registered users join the workspace as `guest` (if not members) with access
// to that room; without an account, a guest account is created from a nickname.
package guests

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/workspaces"
)

const (
	defaultExpiry    = 7 * 24 * time.Hour
	maxExpiry        = 365 * 24 * time.Hour
	maxUses          = 10000
	cleanupBatchSize = 200
)

// ReasonMembersOnly is the reason of a members-only room link (ADR-0043) used by someone who
// is not a member of the workspace (or a guest there).
const ReasonMembersOnly = "INVITE_MEMBERS_ONLY"

var errMembersOnly = httpx.Forbidden("this link is for members of the workspace only").WithDetails(ReasonMembersOnly, 0, 0)

var errNotYetValid = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_INVITE_NOT_YET_VALID, "the link works from 15 minutes before the meeting")

// Service serves room links and guest lifecycle.
type Service struct {
	db      *db.DB
	auth    *auth.Service
	events  events.Publisher
	store   blob.Store
	limiter *redisx.RateLimiter // guest creation per IP (5/h)
	origins []string
	// Plans fills Workspace.plan in the snapshot of a newly joined workspace (nil = unset).
	Plans *plans.Service
}

// NewService creates the guests service.
func NewService(d *db.DB, a *auth.Service, ev events.Publisher, store blob.Store, limiter *redisx.RateLimiter, origins []string) *Service {
	return &Service{db: d, auth: a, events: ev, store: store, limiter: limiter, origins: origins}
}

// Routes registers the routes: link management needs auth (wrap); preview and join are public (join
// authenticates optionally).
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/rooms/{id}/invites", wrap(httpx.HandlerFunc(s.create)))
	mux.Handle("GET /api/rooms/{id}/invites", wrap(httpx.HandlerFunc(s.list)))
	mux.Handle("PATCH /api/rooms/{id}/invites/{inviteId}", wrap(httpx.HandlerFunc(s.update)))
	mux.Handle("DELETE /api/rooms/{id}/invites/{inviteId}", wrap(httpx.HandlerFunc(s.revoke)))
	mux.Handle("GET /api/rooms/{id}/admissions", wrap(httpx.HandlerFunc(s.listAdmissions)))
	mux.Handle("POST /api/rooms/{id}/admissions/{userId}", wrap(httpx.HandlerFunc(s.decide)))
	mux.Handle("DELETE /api/rooms/{id}/admissions/me", wrap(httpx.HandlerFunc(s.cancelAdmission)))
	mux.Handle("GET /api/room-invites/{code}", httpx.HandlerFunc(s.preview))
	mux.Handle("POST /api/room-invites/{code}/join", httpx.HandlerFunc(s.join))
}

// AllowBits computes what joiners may do: VIEW_ROOM + CONNECT always, plus the flags.
func AllowBits(speak, messages, files, stream bool) perm.Bits {
	b := perm.ViewRoom | perm.Connect
	if speak {
		b |= perm.Speak
	}
	if messages {
		b |= perm.SendMessages
	}
	if files {
		b |= perm.AttachFiles
	}
	if stream {
		b |= perm.Stream
	}
	return b
}

func toProto(i sqlc.RoomInvite, wsID uuid.UUID) *v1.RoomInvite {
	b := perm.Bits(uint64(i.AllowBits)) //nolint:gosec // bit mask
	out := &v1.RoomInvite{
		Id: i.ID.String(), RoomId: i.RoomID.String(), WorkspaceId: wsID.String(), Code: i.Code,
		CreatedBy: i.CreatedBy.String(), MaxUses: uint32(max(i.MaxUses, 0)), Uses: uint32(max(i.Uses, 0)),
		AllowGuests: i.AllowGuests, AllowSpeak: b.Has(perm.Speak), AllowMessages: b.Has(perm.SendMessages),
		AllowFiles: b.Has(perm.AttachFiles), AllowStream: b.Has(perm.Stream), CreatedAt: timestamppb.New(i.CreatedAt),
		RequireApproval: i.RequireApproval, MembersOnly: i.MembersOnly,
	}
	if i.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*i.ExpiresAt)
	}
	if i.NotBefore != nil {
		out.NotBefore = timestamppb.New(*i.NotBefore)
	}
	if i.EventID != nil {
		out.EventId = i.EventID.String()
	}
	return out
}

// linkRights is what the caller may do with the room's links (ADR-0043): INVITE_GUESTS — every
// link; INVITE_MEMBERS alone — members-only links. Guests never manage links.
type linkRights struct {
	guests, members bool
}

// mayManage reports whether the caller may manage a link of this kind.
func (l linkRights) mayManage(membersOnly bool) bool {
	return l.guests || (membersOnly && l.members)
}

// linkAccess resolves the caller's rights over the room's links; neither right → 403.
func linkAccess(r *http.Request) (uuid.UUID, perm.RoomAccess, linkRights, error) {
	roomID, err := httpx.PathUUID(r, "id", "room")
	if err != nil {
		return uuid.Nil, perm.RoomAccess{}, linkRights{}, err
	}
	acc, err := rooms.Access(r, roomID)
	if err != nil {
		return roomID, acc, linkRights{}, err
	}
	var l linkRights
	if acc.Role != perm.RoleGuest {
		l = linkRights{guests: acc.Bits.Has(perm.InviteGuests), members: acc.Bits.Has(perm.InviteMembers)}
		// The creator of a temporary room manages its members-only links (ADR-0044); guest
		// links still need INVITE_GUESTS.
		l.members = l.members || acc.Creator(auth.MustFromContext(r.Context()).UserID)
	}
	if !l.guests && !l.members {
		return roomID, acc, l, httpx.Forbidden("INVITE_GUESTS or INVITE_MEMBERS required")
	}
	return roomID, acc, l, nil
}

func orDefault(b *bool, def bool) bool {
	if b == nil {
		return def
	}
	return *b
}

func (s *Service) create(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, rights, err := linkAccess(r)
	if err != nil {
		return err
	}
	// Invitations need a verified email (ADR-0023) unless EMAIL_VERIFICATION=optional (ADR-0065).
	if _, err := s.auth.EmailGate().User(r.Context(), s.db.Q, auth.MustFromContext(r.Context()).UserID); err != nil {
		return err
	}
	var req v1.CreateRoomInviteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	membersOnly := req.GetMembersOnly()
	if !rights.mayManage(membersOnly) {
		return httpx.Forbidden("INVITE_GUESTS required (INVITE_MEMBERS allows members-only links)")
	}
	if membersOnly && (req.GetAllowGuests() || req.RequireApproval != nil) {
		return httpx.Validation("membersOnly", "a members-only link admits no guests")
	}
	if req.GetMaxUses() > maxUses {
		return httpx.Validation("maxUses", "maxUses must be 0..10000")
	}
	var expires *time.Time
	d := defaultExpiry
	if req.ExpiresInSeconds != nil {
		d = time.Duration(req.GetExpiresInSeconds()) * time.Second
	}
	if d > maxExpiry {
		return httpx.Validation("expiresInSeconds", "links expire in at most 365 days")
	}
	if d > 0 {
		t := time.Now().Add(d)
		expires = &t
	}
	bits := AllowBits(orDefault(req.AllowSpeak, true), orDefault(req.AllowMessages, true),
		orDefault(req.AllowFiles, false), orDefault(req.AllowStream, false))
	if !acc.Bits.Has(perm.Administrator) && bits&^acc.Bits != 0 {
		return httpx.Forbidden("cannot grant permissions you do not have") // no escalation through links
	}
	uid := auth.MustFromContext(r.Context()).UserID
	for range 3 {
		code, err := rooms.NewLinkCode()
		if err != nil {
			return err
		}
		inv, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.RoomInvite, error) {
			return guarded.CreateRoomInvite(r.Context(), sqlc.CreateRoomInviteParams{
				RoomID: roomID, Code: code, CreatedBy: uid, ExpiresAt: expires,
				MaxUses: int32(req.GetMaxUses()), AllowGuests: !membersOnly && orDefault(req.AllowGuests, true), AllowBits: int64(bits), //nolint:gosec // bounded
				RequireApproval: req.RequireApproval, MembersOnly: membersOnly,
			})
		})
		if db.UniqueViolation(err) != "" {
			continue
		}
		if err != nil {
			return err
		}
		httpx.Write(w, http.StatusCreated, &v1.CreateRoomInviteResponse{Invite: toProto(inv, acc.WorkspaceID)})
		return nil
	}
	return errors.New("guests: invite code collisions")
}

func (s *Service) list(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, rights, err := linkAccess(r)
	if err != nil {
		return err
	}
	rows, err := s.db.Q.ListRoomInvites(r.Context(), roomID)
	if err != nil {
		return err
	}
	out := &v1.ListRoomInvitesResponse{Invites: make([]*v1.RoomInvite, 0, len(rows))}
	for _, inv := range rows {
		if rights.mayManage(inv.MembersOnly) {
			out.Invites = append(out.Invites, toProto(inv, acc.WorkspaceID))
		}
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// update: PATCH /api/rooms/{id}/invites/{inviteId} — the link's approval setting (ADR-0040).
func (s *Service) update(w http.ResponseWriter, r *http.Request) error {
	roomID, acc, rights, err := linkAccess(r)
	if err != nil {
		return err
	}
	if !rights.guests { // approval concerns guests only
		return httpx.Forbidden("INVITE_GUESTS required")
	}
	invID, err := httpx.PathUUID(r, "inviteId", "invite")
	if err != nil {
		return err
	}
	var req v1.UpdateRoomInviteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.GetInheritApproval() && req.RequireApproval != nil {
		return httpx.Validation("requireApproval", "requireApproval and inheritApproval exclude each other")
	}
	if !req.GetInheritApproval() && req.RequireApproval == nil {
		return httpx.Validation("requireApproval", "nothing to change")
	}
	inv, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (sqlc.RoomInvite, error) {
		return guarded.SetRoomInviteApproval(r.Context(), sqlc.SetRoomInviteApprovalParams{ID: invID, RoomID: roomID, RequireApproval: req.RequireApproval})
	})
	if db.IsNotFound(err) {
		return httpx.NotFound("invite")
	}
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusOK, &v1.UpdateRoomInviteResponse{Invite: toProto(inv, acc.WorkspaceID)})
	return nil
}

func (s *Service) revoke(w http.ResponseWriter, r *http.Request) error {
	roomID, _, rights, err := linkAccess(r)
	if err != nil {
		return err
	}
	invID, err := httpx.PathUUID(r, "inviteId", "invite")
	if err != nil {
		return err
	}
	// INVITE_MEMBERS alone revokes members-only links only; others answer 404 as if absent.
	n, err := db.GuardValue(r.Context(), s.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.RevokeRoomInvite(r.Context(), sqlc.RevokeRoomInviteParams{ID: invID, RoomID: roomID, OnlyMembersOnly: !rights.guests})
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

func (s *Service) load(ctx context.Context, code string) (sqlc.GetRoomInviteByCodeRow, error) {
	row, err := s.db.Q.GetRoomInviteByCode(ctx, code)
	if db.IsNotFound(err) {
		return row, auth.ErrInviteInvalid()
	}
	return row, err
}

// preview: GET /api/room-invites/{code} — public, for the /r/<code> page.
func (s *Service) preview(w http.ResponseWriter, r *http.Request) error {
	row, err := s.load(r.Context(), r.PathValue("code"))
	if err != nil {
		return err
	}
	out := &v1.GetRoomInviteResponse{
		RoomName: row.Room.Name, WorkspaceName: row.Workspace.Name, AllowGuests: row.RoomInvite.AllowGuests,
		RoomType:         v1.RoomType_ROOM_TYPE_TEXT,
		RequiresApproval: RequiresApproval(row.Room.GuestApproval, row.RoomInvite.RequireApproval),
		MembersOnly:      row.RoomInvite.MembersOnly,
	}
	if row.Room.Type == "voice" {
		out.RoomType = v1.RoomType_ROOM_TYPE_VOICE
	}
	if row.Workspace.IconFileID != nil {
		out.WorkspaceIconFileId = row.Workspace.IconFileID.String()
	}
	if row.RoomInvite.ExpiresAt != nil {
		out.ExpiresAt = timestamppb.New(*row.RoomInvite.ExpiresAt)
	}
	if row.RoomInvite.NotBefore != nil {
		out.NotBefore = timestamppb.New(*row.RoomInvite.NotBefore)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// granted is what a join changed: the membership made (nil if the user already was a member),
// whether access or a knock changed at all, and the knock when the link requires approval.
type granted struct {
	added   *sqlc.WorkspaceMember
	changed bool
	knock   *sqlc.RoomAdmission
	fresh   bool // the knock is new (deciders are told)
}

// linkCapability gates a room link by the workspace identity policy (ADR-0054). An enforced
// workspace refuses links as public capabilities; assured (nil for an account-less join)
// may still admit a caller whose own session holds a current SSO assurance for the
// workspace — a member with valid SSO keeps using room links.
func linkCapability(ctx context.Context, q *sqlc.Queries, ws uuid.UUID, assured func(context.Context) error) error {
	err := auth.CheckPublicCapability(ctx, q, ws)
	if err == nil || assured == nil {
		return err
	}
	policy, e := q.GetIdentityPolicy(ctx, ws)
	if e != nil || policy.Mode != string(identitypolicy.Enforced) {
		return err
	}
	return assured(ctx)
}

// grant gives userID access to the room inside q: membership as `guest` if needed and a
// user override with the link's bits — or, when the link requires approval (ADR-0040) and the
// user is not a member (a guest at most), the membership without the override and a pending
// knock. It consumes one use of the link only when access or the knock actually changes.
// assured: see linkCapability.
func (s *Service) grant(ctx context.Context, q *sqlc.Queries, row sqlc.GetRoomInviteByCodeRow, userID uuid.UUID, assured func(context.Context) error) (granted, error) {
	wsID, roomID := row.Workspace.ID, row.Room.ID
	if _, err := q.LockOAuthWorkspace(ctx, wsID); err != nil {
		return granted{}, err
	}
	if err := linkCapability(ctx, q, wsID, assured); err != nil {
		return granted{}, err
	}
	member, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: userID})
	isMember := err == nil
	if err != nil && !db.IsNotFound(err) {
		return granted{}, err
	}
	// A suspended workspace takes nobody in; banned users stay out (item 32). A guest takes no
	// paid seat, but a workspace suspended for billing takes nobody in either (ADR-0080 §12).
	if err := moderation.CheckSuspended(ctx, q, wsID); err != nil {
		return granted{}, err
	}
	if err := s.Plans.CheckBillingOpen(ctx, q, wsID); err != nil {
		return granted{}, err
	}
	if !isMember {
		if err := moderation.CheckBan(ctx, q, wsID, userID, nil); err != nil {
			return granted{}, err
		}
	}
	// A members-only link (ADR-0043) takes in members of the workspace only, not guests.
	if row.RoomInvite.MembersOnly && (!isMember || member.Role == string(perm.RoleGuest)) {
		return granted{}, errMembersOnly
	}
	if isMember {
		acc, err := perm.NewResolver(q).Room(ctx, roomID, userID)
		if err != nil && !errors.Is(err, perm.ErrNoRoom) {
			return granted{}, err
		}
		if acc.Bits.Has(perm.ViewRoom) {
			return granted{}, nil // (a) already has access: nothing to change, no use consumed
		}
	}
	// The restricted mode (ADR-0086 amendment) lets nobody new in by a room link, guests
	// included; who already has access (a) passed above.
	if err := s.Plans.CheckActive(ctx, wsID, plans.RestrictedInvite); err != nil {
		return granted{}, err
	}
	// Members of the workspace never wait (not in v1: ADR-0040); guests (b)/(c) do.
	wait := RequiresApproval(row.Room.GuestApproval, row.RoomInvite.RequireApproval) &&
		(!isMember || member.Role == string(perm.RoleGuest))
	var g granted
	if wait {
		adm, fresh, err := s.knock(ctx, q, row, userID)
		if err != nil {
			return granted{}, err
		}
		if !fresh {
			return granted{knock: &adm}, nil // already waiting: no use consumed
		}
		g.knock, g.fresh = &adm, true
	}
	if _, err := q.ConsumeRoomInvite(ctx, row.RoomInvite.ID); err != nil {
		if db.IsNotFound(err) {
			return granted{}, auth.ErrInviteInvalid()
		}
		return granted{}, err
	}
	g.changed = true
	if !isMember { // (b)/(c): join as guest — the role sees no room without an override
		m, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: wsID, UserID: userID, Role: string(perm.RoleGuest)})
		if err != nil {
			return granted{}, err
		}
		g.added = &m
	}
	if wait {
		return g, nil
	}
	if _, err := q.UpsertUserOverride(ctx, sqlc.UpsertUserOverrideParams{RoomID: roomID, UserID: userID.String(), Allow: row.RoomInvite.AllowBits}); err != nil {
		return granted{}, err
	}
	return g, nil
}

// announce publishes the membership and the room's new overrides after a join — or, for a
// knock, the membership and ROOM_ADMISSION_REQUEST to the deciders.
func (s *Service) announce(ctx context.Context, row sqlc.GetRoomInviteByCodeRow, g granted) {
	if g.knock == nil {
		s.publishOverrides(ctx, row.Workspace.ID, row.Room.ID)
	}
	if g.added != nil {
		workspaces.AnnounceJoin(ctx, s.db.Q, s.Plans, s.events, row.Workspace, *g.added)
	}
	if g.knock != nil && g.fresh {
		s.announceKnock(ctx, row, *g.knock)
	}
}

// respond fills the join response with the knock, if any (the guest's view).
func respond(resp *v1.JoinRoomInviteResponse, row sqlc.GetRoomInviteByCodeRow, g granted) {
	if g.knock != nil {
		resp.Admission = guestView(*g.knock, row.Workspace.ID, row.Room.Name, row.Workspace.Name)
	}
}

// join: POST /api/room-invites/{code}/join — scenarios (a)(b) with an access token,
// (c) without one (guest account from `nickname`).
func (s *Service) join(w http.ResponseWriter, r *http.Request) error {
	if auth.IsBotRequest(r) { // ADR-0031: room links are never for bots
		return auth.ErrBotNotAllowed
	}
	row, err := s.load(r.Context(), r.PathValue("code"))
	if err != nil {
		return err
	}
	var req v1.JoinRoomInviteRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	// A meeting's guest link (ADR-0038) works from 15 minutes before the meeting.
	if nb := row.RoomInvite.NotBefore; nb != nil && time.Now().Before(*nb) {
		return errNotYetValid
	}
	resp := &v1.JoinRoomInviteResponse{RoomId: row.Room.ID.String(), WorkspaceId: row.Workspace.ID.String()}

	if auth.HasBearer(r) {
		id, err := s.auth.Authenticate(r)
		if err != nil {
			return err
		}
		// Joining adds a global-account membership, like /api/invites/{code}/join: only a
		// live local_account session (fresh from the database) may do it — never a
		// workspace_sso session of another workspace or a recovery session (ADR-0054).
		// In an enforced workspace the local session must also hold a current SSO
		// assurance for it (checked inside the transaction, after the workspace lock).
		if id.Principal, err = s.auth.ResolvePrincipal(r.Context(), id); err != nil {
			return err
		}
		if err := s.auth.CheckGlobal(r.Context(), id, identitypolicy.GlobalWrite); err != nil {
			return err
		}
		var g granted
		err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
			var err error
			g, err = s.grant(r.Context(), q, row, id.UserID, func(ctx context.Context) error {
				return s.auth.CheckWorkspace(ctx, id, row.Workspace.ID, identitypolicy.WorkspaceWrite)
			})
			return err
		})
		if err != nil {
			return err
		}
		if g.changed {
			s.announce(r.Context(), row, g)
		}
		respond(resp, row, g)
		httpx.Write(w, http.StatusOK, resp)
		return nil
	}

	// (c) no account. A members-only link (ADR-0043) never makes a guest account, whatever
	// allow_guests holds.
	if !row.RoomInvite.AllowGuests || row.RoomInvite.MembersOnly {
		return httpx.Unauthenticated("sign in to use this link")
	}
	if auth.IsWeb(r) && !httpx.SameOrigin(r, s.origins) {
		return httpx.Forbidden("cross-origin request rejected") // it sets a session cookie
	}
	name, err := auth.ValidateDisplayName(req.GetNickname())
	if err != nil {
		return httpx.Validation("nickname", "name must be 1..64 characters")
	}
	if err := s.limiter.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
		return err
	}
	var (
		user   sqlc.User
		tokens *v1.AuthTokens
		g      granted
	)
	err = s.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		var err error
		user, tokens, err = s.auth.NewGuest(r.Context(), q, name,
			auth.Client{DeviceName: req.GetDeviceName(), IP: httpx.ClientIP(r.Context()), UserAgent: r.UserAgent()})
		if err != nil {
			return err
		}
		g, err = s.grant(r.Context(), q, row, user.ID, nil)
		return err
	})
	if err != nil {
		return err
	}
	s.announce(r.Context(), row, g)
	respond(resp, row, g)
	resp.Tokens, resp.Me = tokens, pbconv.Me(user)
	if auth.IsWeb(r) {
		auth.SetRefreshCookie(w, tokens)
	}
	httpx.Write(w, http.StatusCreated, resp)
	return nil
}

// ---- cleanup ----

// Cleanup removes guest accounts inactive for 7 days: memberships, room overrides, files
// and sessions are deleted; the user row is anonymised ("Гость (удалён)") so that their
// messages stay readable. One instance at a time (advisory lock).
func (s *Service) Cleanup(ctx context.Context) (int, error) {
	now := time.Now()
	ids, err := s.db.Q.ListExpiredGuests(ctx, &now)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	// One post-commit budget for the whole pass (session revocations and MEMBER_REMOVE of
	// every guest in every workspace): with a hung Redis the pass must not wait 3 s per
	// publish — once the budget is spent, the remaining publishes fail at once.
	ctx = events.WithBudget(ctx, events.RequestBudget)
	n := 0
	for _, uid := range ids {
		if err := s.removeGuest(ctx, uid); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

func (s *Service) removeGuest(ctx context.Context, uid uuid.UUID) error {
	wids, err := s.db.Q.ListUserWorkspaceIDs(ctx, uid)
	if err != nil {
		return err
	}
	var (
		gone     []sqlc.File
		sessions []uuid.UUID
	)
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		// Row lock + re-check: a refresh may have extended the guest since the listing.
		if _, err := q.LockExpiredGuest(ctx, uid); err != nil {
			if db.IsNotFound(err) {
				return errNotExpired
			}
			return err
		}
		files, err := q.ListUserFiles(ctx, uid)
		if err != nil {
			return err
		}
		for _, f := range files {
			n, err := q.DeleteFile(ctx, f.ID)
			if err != nil {
				return err
			}
			if n == 0 {
				continue // removed concurrently (orphan cleanup): its quota is already released
			}
			if f.WorkspaceID != nil {
				if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: *f.WorkspaceID, Size: f.Size}); err != nil {
					return err
				}
			}
			gone = append(gone, f)
		}
		if err := q.DeleteUserRoomOverrides(ctx, uid.String()); err != nil {
			return err
		}
		if err := q.DeleteUserMemberships(ctx, uid); err != nil {
			return err
		}
		if err := q.DeleteNotesAbout(ctx, uid); err != nil { // by and about the guest
			return err
		}
		if sessions, err = q.RevokeAllUserSessions(ctx, sqlc.RevokeAllUserSessionsParams{UserID: uid, Reason: auth.RevokeGuestExpired}); err != nil {
			return err
		}
		return q.AnonymizeGuest(ctx, uid)
	})
	if errors.Is(err, errNotExpired) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, f := range gone {
		_ = s.store.Delete(ctx, f.Key)
		blob.DeleteThumbs(ctx, s.store, f.Key, f.ThumbnailKey)
	}
	s.auth.MarkRevoked(ctx, auth.RevokeGuestExpired, sessions...) // access tokens die now, gateway closes with 4010 (own budget)
	for _, w := range wids {
		s.events.Workspace(ctx, w, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
			WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: w.String(), UserId: uid.String()},
		}})
	}
	return nil
}

var errNotExpired = errors.New("guests: no longer expired")

// RunCleanup runs Cleanup every interval until ctx is done.
func (s *Service) RunCleanup(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.Cleanup(ctx); err != nil {
				slog.Error("guest cleanup", "err", err)
			} else if n > 0 {
				slog.Info("inactive guests removed", "count", n)
			}
		}
	}
}
