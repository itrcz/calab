package workspaces

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/rooms"
)

// Former-member reasons (workspace_former_members.reason, ADR-0097).
const (
	ReasonLeft         = "left"
	ReasonRemoved      = "removed"
	ReasonBanned       = "banned"
	ReasonGuestExpired = "guest_expired"
	// ReasonDirectoryDisabled is reserved: a directory-disabled member is suspended, not
	// removed (internal/directory keeps the membership), so nothing writes it yet.
	ReasonDirectoryDisabled = "directory_disabled"
)

const (
	maxUserRefIDs  = 100
	formerPageSize = 50
	maxFormerQuery = 100
)

var reasonPB = map[string]v1.FormerMemberReason{
	ReasonLeft:              v1.FormerMemberReason_FORMER_MEMBER_REASON_LEFT,
	ReasonRemoved:           v1.FormerMemberReason_FORMER_MEMBER_REASON_REMOVED,
	ReasonBanned:            v1.FormerMemberReason_FORMER_MEMBER_REASON_BANNED,
	ReasonGuestExpired:      v1.FormerMemberReason_FORMER_MEMBER_REASON_GUEST_EXPIRED,
	ReasonDirectoryDisabled: v1.FormerMemberReason_FORMER_MEMBER_REASON_DIRECTORY_DISABLED,
}

// FormerInfo is the WORKSPACE_MEMBER_REMOVE.former of a former-member row.
func FormerInfo(f sqlc.WorkspaceFormerMember) *v1.FormerMemberInfo {
	return &v1.FormerMemberInfo{LeftAt: timestamppb.New(f.LeftAt), Reason: reasonPB[f.Reason]}
}

// RemoveMembership deletes the user's membership inside q and keeps a former-member row
// (ADR-0097), frees the paid seat and drops the user's room / board / disk overrides in the
// workspace. removed = false: not a member (nothing changed). The caller invalidates the
// identity (auth.InvalidateIdentity, with its own reason) and publishes PublishRemoved after
// the commit. by: the manager who removed them; nil = themself or the server.
//
// A bot is not a former member: its membership goes without a row, and f.Reason is empty
// (PublishRemoved then leaves WORKSPACE_MEMBER_REMOVE.former unset).
func RemoveMembership(ctx context.Context, q *sqlc.Queries, pl *plans.Service, wsID, userID uuid.UUID, reason string, by *uuid.UUID) (f sqlc.WorkspaceFormerMember, removed bool, err error) {
	u, err := q.GetUser(ctx, userID)
	if db.IsNotFound(err) {
		return f, false, nil
	}
	if err != nil {
		return f, false, err
	}
	if u.IsBot {
		m, err := q.GetMember(ctx, sqlc.GetMemberParams{WorkspaceID: wsID, UserID: userID})
		if db.IsNotFound(err) {
			return f, false, nil
		}
		if err != nil {
			return f, false, err
		}
		if n, err := q.RemoveMember(ctx, sqlc.RemoveMemberParams{WorkspaceID: wsID, UserID: userID}); err != nil || n == 0 {
			return f, false, err
		}
		f = sqlc.WorkspaceFormerMember{WorkspaceID: wsID, UserID: userID, Role: m.Role}
	} else {
		f, err = q.RemoveMemberAsFormer(ctx, sqlc.RemoveMemberAsFormerParams{WorkspaceID: wsID, UserID: userID, Reason: reason, RemovedBy: by})
		if db.IsNotFound(err) {
			return f, false, nil
		}
		if err != nil {
			return f, false, err
		}
	}
	if err := pl.SeatRemoved(ctx, q, wsID, userID, f.Role); err != nil {
		return f, false, err
	}
	if err := q.DeleteUserOverridesInWorkspace(ctx, sqlc.DeleteUserOverridesInWorkspaceParams{WorkspaceID: wsID, UserID: userID.String()}); err != nil {
		return f, false, err
	}
	return f, true, nil
}

// PublishRemoved announces a removed membership: WORKSPACE_MEMBER_REMOVE with `former` to the
// workspace, WORKSPACE_DELETE to the user (LiveKit participants are disconnected by
// rtc.SyncPublisher).
func PublishRemoved(ctx context.Context, ev events.Publisher, f sqlc.WorkspaceFormerMember) {
	rm := &v1.WorkspaceMemberRemove{WorkspaceId: f.WorkspaceID.String(), UserId: f.UserID.String()}
	if f.Reason != "" { // a bot leaves no former-member row
		rm.Former = FormerInfo(f)
	}
	ev.Workspace(ctx, f.WorkspaceID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{WorkspaceMemberRemove: rm}})
	ev.User(ctx, f.UserID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{
		WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: f.WorkspaceID.String()},
	}})
}

func (h *Handlers) formerRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/users", h.listUsers)
	handle("GET /api/workspaces/{id}/former-members", h.listFormerMembers)
}

// userRef builds the public reference. An anonymised guest account (disabled, ADR-0016) shows
// the name and avatar it had when it left; any other account its live profile.
func userRef(id uuid.UUID, name string, avatar *uuid.UUID, username *string, isGuest, isBot bool, disabled *time.Time,
	former bool, formerName *string, formerAvatar *uuid.UUID, leftAt *time.Time, reason string,
) *v1.UserRef {
	out := &v1.UserRef{UserId: id.String(), DisplayName: name, IsGuest: isGuest, IsBot: isBot}
	if avatar != nil {
		out.AvatarFileId = avatar.String()
	}
	if username != nil {
		out.Username = *username
	}
	if !former {
		return out
	}
	out.Former, out.Reason = true, reasonPB[reason]
	if leftAt != nil {
		out.LeftAt = timestamppb.New(*leftAt)
	}
	if isGuest && disabled != nil && formerName != nil {
		out.DisplayName, out.AvatarFileId = *formerName, ""
		if formerAvatar != nil {
			out.AvatarFileId = formerAvatar.String()
		}
	}
	return out
}

// listUsers: GET /api/workspaces/{id}/users?ids=a,b,… (any member, ADR-0097 §2) — profiles of
// members and former members among the ids; other ids are skipped, so the route reveals
// nobody who never was in the workspace. A guest resolves only the members visible to it
// (the same set as GET …/members), no former members.
func (h *Handlers) listUsers(w http.ResponseWriter, r *http.Request) error {
	wsID, _, role, err := access(r)
	if err != nil {
		return err
	}
	ids, err := parseIDs(r.URL.Query().Get("ids"))
	if err != nil {
		return err
	}
	out := &v1.ListWorkspaceUsersResponse{Users: []*v1.UserRef{}}
	if len(ids) == 0 {
		httpx.Write(w, http.StatusOK, out)
		return nil
	}
	var allowed map[uuid.UUID]bool
	if role == perm.RoleGuest {
		if allowed, err = rooms.GuestVisibleUsers(r.Context(), h.db.Q, h.voice, wsID, uid(r)); err != nil {
			return err
		}
	}
	rows, err := h.db.Q.ListWorkspaceUserRefs(r.Context(), sqlc.ListWorkspaceUserRefsParams{WorkspaceID: wsID, Ids: ids})
	if err != nil {
		return err
	}
	for _, row := range rows {
		if allowed != nil && (!row.IsMember || !allowed[row.ID]) {
			continue
		}
		reason := ""
		if row.Reason != nil {
			reason = *row.Reason
		}
		out.Users = append(out.Users, userRef(row.ID, row.DisplayName, row.AvatarFileID, row.Username, row.IsGuest, row.IsBot,
			row.DisabledAt, !row.IsMember, row.FormerName, row.FormerAvatar, row.LeftAt, reason))
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

func parseIDs(raw string) ([]uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	if len(parts) > maxUserRefIDs {
		return nil, httpx.Validation("ids", "at most 100 ids")
	}
	seen := make(map[uuid.UUID]bool, len(parts))
	out := make([]uuid.UUID, 0, len(parts))
	for _, p := range parts {
		id, err := uuid.Parse(strings.TrimSpace(p))
		if err != nil {
			return nil, httpx.Validation("ids", "invalid user id")
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

// formerCursor is the position after the last row of a former-members page.
type formerCursor struct {
	LeftAt time.Time `json:"t"`
	ID     uuid.UUID `json:"i"`
}

func (c formerCursor) encode() string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeFormerCursor(raw string) (*formerCursor, error) {
	if raw == "" {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	var c formerCursor
	if err != nil || json.Unmarshal(b, &c) != nil || c.ID == uuid.Nil {
		return nil, httpx.Validation("cursor", "invalid cursor")
	}
	return &c, nil
}

// listFormerMembers: GET /api/workspaces/{id}/former-members?guests=0|1&q=&cursor= (MANAGE_MEMBERS,
// like bans; ADR-0097 §3) — newest first, formerPageSize per page; former guests only with
// guests=1.
func (h *Handlers) listFormerMembers(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireMembers(r)
	if err != nil {
		return err
	}
	qs := r.URL.Query()
	cur, err := decodeFormerCursor(qs.Get("cursor"))
	if err != nil {
		return err
	}
	q := strings.TrimSpace(qs.Get("q"))
	if utf8.RuneCountInString(q) > maxFormerQuery {
		return httpx.Validation("q", "query must be at most 100 characters")
	}
	pattern := ""
	if q != "" {
		pattern = "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q) + "%"
	}
	params := sqlc.ListFormerMembersParams{
		WorkspaceID: wsID, IncludeGuests: qs.Get("guests") == "1", Q: pattern, Lim: formerPageSize + 1,
	}
	if cur != nil {
		params.BeforeAt, params.BeforeID = &cur.LeftAt, &cur.ID
	}
	rows, err := h.db.Q.ListFormerMembers(r.Context(), params)
	if err != nil {
		return err
	}
	out := &v1.ListFormerMembersResponse{Members: make([]*v1.FormerMember, 0, min(len(rows), formerPageSize))}
	for i, row := range rows {
		if i == formerPageSize {
			last := rows[i-1].WorkspaceFormerMember
			out.NextCursor = formerCursor{LeftAt: last.LeftAt, ID: last.UserID}.encode()
			break
		}
		f := row.WorkspaceFormerMember
		fm := &v1.FormerMember{
			User: userRef(f.UserID, row.LiveName, row.LiveAvatar, row.Username, row.IsGuest, row.IsBot, row.DisabledAt,
				true, &f.DisplayName, f.AvatarFileID, &f.LeftAt, f.Reason),
			Role: perm.Role(f.Role).Proto(), Nickname: f.Nickname, OpenTasks: row.OpenTasks,
		}
		if f.JoinedAt != nil {
			fm.JoinedAt = timestamppb.New(*f.JoinedAt)
		}
		if f.RemovedBy != nil {
			fm.RemovedBy = f.RemovedBy.String()
		}
		out.Members = append(out.Members, fm)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}
