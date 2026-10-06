package rooms

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Temporary rooms (ADR-0044): voice rooms with rooms.expires_at, created with CREATE_TEMP_ROOMS
// together with a room link, archived by the sweeper when they expire.

// Limits of temporary rooms: lifetime at creation and extension (MinTempTTL, MaxTempTTL), live
// rooms per workspace and per creator, people of a private one; TempSweep is how often
// expired rooms are archived.
const (
	MinTempTTL          = 15 * time.Minute
	MaxTempTTL          = 7 * 24 * time.Hour
	MaxTempPerWorkspace = 20
	MaxTempPerUser      = 5
	MaxTempMembers      = 50
	TempSweep           = 30 * time.Second
)

const (
	tempPurgeEvery = time.Hour // the retention purge of the archive
	tempBatch      = 200
)

// TempAllow are the personal allow bits of a private temporary room (creator, chosen people,
// members arriving by the link) and the bits of its link — bounded by what the creator holds.
const TempAllow = perm.ViewRoom | perm.Connect | perm.Speak | perm.Video | perm.Stream | perm.SendMessages | perm.AttachFiles

// ReasonPerUser (ApiError.reason of TEMP_ROOM_LIMIT): the creator's own cap, not the workspace's.
const ReasonPerUser = "PER_USER"

// ErrRoomArchived is 410 ROOM_ARCHIVED: an archived temporary room serves its history only (ADR-0044).
var ErrRoomArchived = httpx.Coded(http.StatusGone, v1.ErrorCode_ERROR_CODE_ROOM_ARCHIVED, "the room is archived")

// Meetings is what temporary rooms need from the calendar (ADR-0038); calendar.Service
// implements it. Both run inside the caller's transaction and return what to publish after
// the commit.
type Meetings interface {
	CreateRoomMeeting(ctx context.Context, q *sqlc.Queries, wsID, organizer, roomID uuid.UUID, title string, start, end time.Time) (*v1.CalendarEvent, func(context.Context), error)
	CloseRoomMeetings(ctx context.Context, q *sqlc.Queries, roomID uuid.UUID) (func(context.Context), error)
	FollowRoomExpiry(ctx context.Context, q *sqlc.Queries, roomID uuid.UUID, oldEnd, newEnd time.Time) (func(context.Context), error)
}

// MayManage is the one MANAGE_ROOM check of a room (ADR-0044): the bit in the room, or — on a
// temporary room only — being its creator (not a guest). It never widens rights on a
// permanent room.
func MayManage(acc perm.RoomAccess, userID uuid.UUID) bool {
	return acc.Bits.Has(perm.ManageRoom) || acc.Creator(userID)
}

const linkAlphabet = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"

// NewLinkCode returns a random room link code (12 characters ≈ 70 bits: the code is the
// capability, ADR-0016).
func NewLinkCode() (string, error) {
	b := make([]byte, 12)
	n := big.NewInt(int64(len(linkAlphabet)))
	for i := range b {
		k, err := rand.Int(rand.Reader, n)
		if err != nil {
			return "", err
		}
		b[i] = linkAlphabet[k.Int64()]
	}
	return string(b), nil
}

// LinkURL is the shareable address of a room link.
func LinkURL(publicURL, code string) string {
	return strings.TrimRight(publicURL, "/") + "/r/" + code
}

// ceil5 rounds t up to 5 minutes (the meeting of a temporary room).
func ceil5(t time.Time) time.Time {
	s := t.Truncate(5 * time.Minute)
	if s.Before(t) {
		s = s.Add(5 * time.Minute)
	}
	return s
}

// tempMembers validates member_ids: workspace members that are not guests, ≤ 50, without the
// creator and duplicates.
func tempMembers(ctx context.Context, q *sqlc.Queries, wsID, me uuid.UUID, ids []string) ([]uuid.UUID, error) {
	if len(ids) > MaxTempMembers {
		return nil, httpx.Validation("memberIds", "at most 50 people")
	}
	seen := map[uuid.UUID]bool{me: true}
	out := make([]uuid.UUID, 0, len(ids))
	for i, s := range ids {
		field := "memberIds[" + strconv.Itoa(i) + "]"
		id, err := uuid.Parse(s)
		if err != nil {
			return nil, httpx.Validation(field, "invalid user id")
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: id})
		if db.IsNotFound(err) {
			return nil, httpx.Validation(field, "user is not a member of the workspace")
		}
		if err != nil {
			return nil, err
		}
		if m.Role == string(perm.RoleGuest) {
			return nil, httpx.Validation(field, "guests join a temporary room by its link")
		}
		out = append(out, id)
	}
	return out, nil
}

// createTemp: POST /api/workspaces/{id}/rooms/temp.
func (h *Handlers) createTemp(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, err := httpx.PathUUID(r, "id", "workspace")
	if err != nil {
		return err
	}
	m, err := WorkspaceMember(r, wsID)
	if err != nil {
		return err
	}
	bits := m.Workspace()
	if m.Role == perm.RoleGuest || !bits.Has(perm.CreateTempRooms) {
		return httpx.Forbidden("CREATE_TEMP_ROOMS required")
	}
	var req v1.CreateTempRoomRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	name, err := validName(req.GetName())
	if err != nil {
		return err
	}
	ttl := time.Duration(req.GetTtlSeconds()) * time.Second
	if ttl < MinTempTTL || ttl > MaxTempTTL {
		return httpx.Validation("ttlSeconds", "lifetime must be 15 minutes .. 7 days")
	}
	guests := req.Guests == nil || req.GetGuests()
	if auth.IsBotRequest(r) && (guests || req.GetWithEvent()) {
		return auth.ErrBotNotAllowed // ADR-0031: bots neither invite guests nor book meetings
	}
	if !req.GetPrivate() && len(req.GetMemberIds()) > 0 {
		return httpx.Validation("memberIds", "people are chosen for a private room only")
	}
	me := auth.MustFromContext(ctx).UserID
	if guests {
		if !bits.Has(perm.InviteGuests) {
			return httpx.Forbidden("INVITE_GUESTS required for a link that admits guests (guests=false: members only)")
		}
		if _, err := h.EmailGate.User(ctx, h.db.Q, me); err != nil { // invitations need a verified email (ADR-0023, ADR-0065)
			return err
		}
	}
	code, err := NewLinkCode()
	if err != nil {
		return err
	}
	now := time.Now()
	expires := now.Add(ttl).Truncate(time.Second)
	// The creator cannot hand out more than they hold (as with links and overrides).
	allow := perm.ViewRoom | TempAllow&bits
	var (
		room    sqlc.Room
		ws      sqlc.Workspace
		ovs     []sqlc.RoomPermission
		event   *v1.CalendarEvent
		publish func(context.Context)
	)
	err = h.db.Tx(ctx, func(q *sqlc.Queries) error {
		members, err := tempMembers(ctx, q, wsID, me, req.GetMemberIds())
		if err != nil {
			return err
		}
		if err := q.LockTempRooms(ctx, wsID); err != nil {
			return err
		}
		n, err := q.CountLiveTempRooms(ctx, sqlc.CountLiveTempRoomsParams{WorkspaceID: wsID, UserID: me})
		if err != nil {
			return err
		}
		if n.Total >= MaxTempPerWorkspace {
			return errTempLimit.WithDetails("", uint64(n.Total), MaxTempPerWorkspace) //nolint:gosec // count ≥ 0
		}
		if n.Mine >= MaxTempPerUser {
			return errTempLimit.WithDetails(ReasonPerUser, uint64(n.Mine), MaxTempPerUser) //nolint:gosec // count ≥ 0
		}
		if ws, err = q.GetWorkspace(ctx, wsID); err != nil {
			return err
		}
		room, err = q.CreateRoom(ctx, sqlc.CreateRoomParams{
			WorkspaceID: wsID, Type: "voice", Name: name, IsPrivate: req.GetPrivate(),
			ExpiresAt: &expires, CreatedBy: &me,
		})
		if err != nil {
			return err
		}
		if room.IsPrivate {
			if err := setPrivate(ctx, q, wsID, room.ID, true); err != nil {
				return err
			}
			for _, u := range append([]uuid.UUID{me}, members...) {
				if err := q.GrantUserOverride(ctx, sqlc.GrantUserOverrideParams{RoomID: room.ID, UserID: u.String(), Allow: int64(allow)}); err != nil { //nolint:gosec // bit mask
					return err
				}
			}
		}
		if _, err := q.CreateRoomInvite(ctx, sqlc.CreateRoomInviteParams{
			RoomID: room.ID, Code: code, CreatedBy: me, ExpiresAt: &expires,
			AllowGuests: guests, AllowBits: int64(allow), MembersOnly: !guests, //nolint:gosec // bit mask
		}); err != nil {
			return err
		}
		if req.GetWithEvent() && h.Meetings != nil {
			if event, publish, err = h.Meetings.CreateRoomMeeting(ctx, q, wsID, me, room.ID, name, ceil5(now), expires); err != nil {
				return err
			}
		}
		ovs, err = q.ListRoomOverrides(ctx, room.ID)
		return err
	})
	if err != nil {
		return err
	}
	pb := pbconv.Room(room, pbconv.WorkspaceDefaults(ws), ovs)
	h.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomCreate{RoomCreate: &v1.RoomCreate{Room: pb}}})
	if publish != nil {
		publish(ctx)
	}
	httpx.Write(w, http.StatusCreated, &v1.TempRoomResponse{Room: pb, InviteUrl: LinkURL(h.PublicURL, code), InviteCode: code, Event: event})
	return nil
}

var errTempLimit = httpx.Coded(http.StatusConflict, v1.ErrorCode_ERROR_CODE_TEMP_ROOM_LIMIT, "too many temporary rooms")

// setPrivate hides a room from the built-in member role (docs/04: a private room is the member
// role's deny VIEW_ROOM; guests never had it) or lifts that deny. Personal overrides stay.
func setPrivate(ctx context.Context, q *sqlc.Queries, wsID, roomID uuid.UUID, private bool) error {
	member, err := q.GetBuiltinRole(ctx, sqlc.GetBuiltinRoleParams{WorkspaceID: wsID, Builtin: ptr(string(perm.RoleMember))})
	if err != nil {
		return err
	}
	if private {
		return q.AddRoleDeny(ctx, sqlc.AddRoleDenyParams{RoomID: roomID, TargetID: member.ID.String(), Deny: int64(perm.ViewRoom)})
	}
	if err := q.RemoveRoleDeny(ctx, sqlc.RemoveRoleDenyParams{RoomID: roomID, TargetID: member.ID.String(), Bits: int64(perm.ViewRoom)}); err != nil {
		return err
	}
	return q.DropEmptyRoleOverride(ctx, sqlc.DropEmptyRoleOverrideParams{RoomID: roomID, TargetID: member.ID.String()})
}

// archiveTemp archives a live temporary room in one transaction — archived_at, every link
// revoked, its meetings closed — then announces ROOM_DELETE (rtc.SyncPublisher closes the
// LiveKit room: participants leave). onlyExpired: the sweeper's re-check (an extension that
// raced it wins). Reports whether the room was archived.
func (h *Handlers) archiveTemp(ctx context.Context, roomID uuid.UUID, onlyExpired bool) (bool, error) {
	var (
		room    sqlc.Room
		publish func(context.Context)
	)
	err := h.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		if room, err = q.ArchiveTempRoom(ctx, sqlc.ArchiveTempRoomParams{ID: roomID, OnlyExpired: onlyExpired}); err != nil {
			return err
		}
		if err := q.RevokeAllRoomInvites(ctx, roomID); err != nil {
			return err
		}
		if h.Meetings != nil {
			publish, err = h.Meetings.CloseRoomMeetings(ctx, q, roomID)
		}
		return err
	})
	if db.IsNotFound(err) {
		return false, nil
	}
	if err != nil || room.WorkspaceID == nil {
		return false, err
	}
	wsID := *room.WorkspaceID
	h.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomDelete{
		RoomDelete: &v1.RoomDelete{WorkspaceId: wsID.String(), RoomId: roomID.String()},
	}})
	if publish != nil {
		publish(ctx)
	}
	return true, nil
}

// listArchived: GET /api/workspaces/{id}/rooms?archived=1 — the archive of temporary rooms
// (MANAGE_ROOM at workspace level; rooms the caller sees only).
func (h *Handlers) listArchived(w http.ResponseWriter, r *http.Request, wsID uuid.UUID, m perm.Member) error {
	if !m.Workspace().Has(perm.ManageRoom) {
		return httpx.Forbidden("MANAGE_ROOM required")
	}
	ctx := r.Context()
	rows, err := h.db.Q.ListArchivedTempRooms(ctx, wsID)
	if err != nil {
		return err
	}
	ws, err := h.db.Q.GetWorkspace(ctx, wsID)
	if err != nil {
		return err
	}
	ids := make([]uuid.UUID, len(rows))
	for i, row := range rows {
		ids[i] = row.Room.ID
	}
	ovRows, err := h.db.Q.ListRoomOverridesIn(ctx, ids)
	if err != nil {
		return err
	}
	byRoom := make(map[uuid.UUID][]sqlc.RoomPermission)
	for _, o := range ovRows {
		byRoom[o.RoomID] = append(byRoom[o.RoomID], o)
	}
	defaults := pbconv.WorkspaceDefaults(ws)
	out := &v1.ListRoomsResponse{Rooms: make([]*v1.Room, 0, len(rows))}
	for _, row := range rows {
		ovs := byRoom[row.Room.ID]
		if !perm.ComputeIn(m, perm.FlagsOf(row.Room), pbconv.OverrideTargets(ovs)).Has(perm.ViewRoom) {
			continue
		}
		pb := pbconv.Room(row.Room, defaults, ovs)
		pb.MessageCount = uint32(max(row.MessageCount, 0))
		out.Rooms = append(out.Rooms, pb)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// ---- sweeper ----

// RunTempRooms archives expired temporary rooms every TempSweep and purges the archive past
// retention hourly, until ctx is done. With Redis only one instance does each per period.
func (h *Handlers) RunTempRooms(ctx context.Context, r rueidis.Client, retention time.Duration) {
	t := time.NewTicker(TempSweep)
	defer t.Stop()
	lock := func(name string, ttl time.Duration) bool {
		return r == nil || r.Do(ctx, r.B().Set().Key(redisx.Key(name)).Value("1").Nx().Ex(ttl).Build()).Error() == nil
	}
	for {
		if lock("rooms:temp-sweep", TempSweep-5*time.Second) {
			if n, err := h.SweepTempRooms(ctx); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "temporary rooms: expiry", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "temporary rooms archived", "count", n)
			}
		}
		if lock("rooms:temp-purge", tempPurgeEvery-time.Minute) {
			if n, err := h.PurgeTempRooms(ctx, time.Now().Add(-retention)); err != nil && ctx.Err() == nil {
				slog.WarnContext(ctx, "temporary rooms: retention", "err", err)
			} else if n > 0 {
				slog.InfoContext(ctx, "archived temporary rooms deleted", "count", n)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// SweepTempRooms archives the temporary rooms whose expires_at has passed and returns how many.
func (h *Handlers) SweepTempRooms(ctx context.Context) (int, error) {
	ctx = events.WithBudget(ctx, events.RequestBudget) // publishes of the whole pass
	ids, err := h.db.Q.DueTempRooms(ctx, tempBatch)
	if err != nil {
		return 0, err
	}
	n := 0
	var errs []error
	for _, id := range ids {
		ok, err := h.archiveTemp(ctx, id, true)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if ok {
			n++
		}
	}
	return n, errors.Join(errs...)
}

// PurgeTempRooms deletes archived temporary rooms archived before `before` with their history
// (messages, reactions, pins by cascade; uploads become orphans for the file cleanup) and
// returns how many. Nobody sees them any more: no event.
func (h *Handlers) PurgeTempRooms(ctx context.Context, before time.Time) (int, error) {
	ids, err := h.db.Q.PurgeableTempRooms(ctx, sqlc.PurgeableTempRoomsParams{Before: &before, Lim: tempBatch})
	if err != nil {
		return 0, err
	}
	n := 0
	for _, id := range ids {
		k, err := db.GuardValue(ctx, h.db, func(guarded *sqlc.Queries) (int64, error) { return guarded.DeleteArchivedTempRoom(ctx, id) })
		if err != nil {
			return n, err
		}
		n += int(k)
	}
	return n, nil
}
