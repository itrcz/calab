package workspaces

import (
	"github.com/google/uuid"

	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

const maxBanReason = 500

func (h *Handlers) banRoutes(handle func(string, httpx.HandlerFunc)) {
	handle("GET /api/workspaces/{id}/bans", h.listBans)
	handle("POST /api/workspaces/{id}/bans", h.createBan)
	handle("DELETE /api/workspaces/{id}/bans/{userId}", h.deleteBan)
}

// createBan: POST /api/workspaces/{id}/bans {user_id, reason} (backlog item 32). Same rights
// as removing a member: MANAGE_MEMBERS (ADR-0048); the owner cannot be banned, an admin only by the
// owner; nobody bans themself. The member is removed in the same transaction; pending email
// invitations of their address are revoked.
func (h *Handlers) createBan(w http.ResponseWriter, r *http.Request) error {
	wsID, actorRole, err := requireMembers(r)
	if err != nil {
		return err
	}
	var req v1.CreateBanRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	target, err := uuid.Parse(req.GetUserId())
	if err != nil {
		return httpx.Validation("userId", "invalid user id")
	}
	reason := strings.TrimSpace(req.GetReason())
	if utf8.RuneCountInString(reason) > maxBanReason {
		return httpx.Validation("reason", "reason must be at most 500 characters")
	}
	if target == uid(r) {
		return httpx.Forbidden("cannot ban yourself")
	}
	if err := outranks(r, wsID, target); err != nil {
		return err
	}
	u, err := h.db.Q.GetUser(r.Context(), target)
	if db.IsNotFound(err) {
		return httpx.NotFound("user")
	}
	if err != nil {
		return err
	}
	actor := uid(r)
	var (
		ban     sqlc.WorkspaceBan
		removed bool
	)
	err = h.db.Tx(r.Context(), func(q *sqlc.Queries) error {
		if _, err := q.LockOAuthWorkspace(r.Context(), wsID); err != nil {
			return err
		}
		cur, err := q.GetMember(r.Context(), sqlc.GetMemberParams{WorkspaceID: wsID, UserID: target})
		switch {
		case err == nil:
			switch role := perm.Role(cur.Role); {
			case role == perm.RoleOwner:
				return httpx.Forbidden("the owner cannot be banned")
			case role == perm.RoleAdmin && actorRole != perm.RoleOwner:
				return httpx.Forbidden("only the owner can ban an admin")
			}
			if _, err := q.RemoveMember(r.Context(), sqlc.RemoveMemberParams{WorkspaceID: wsID, UserID: target}); err != nil {
				return err
			}
			if err := h.limits.Plans.SeatRemoved(r.Context(), q, wsID, target, cur.Role); err != nil {
				return err
			}
			if err := q.DeleteUserOverridesInWorkspace(r.Context(), sqlc.DeleteUserOverridesInWorkspaceParams{WorkspaceID: wsID, UserID: target.String()}); err != nil {
				return err
			}
			removed = true
		case !db.IsNotFound(err):
			return err
		}
		if u.Email != nil {
			if err := q.DeletePendingEmailInvitesFor(r.Context(), sqlc.DeletePendingEmailInvitesForParams{WorkspaceID: wsID, Email: *u.Email}); err != nil {
				return err
			}
		}
		if err := auth.InvalidateIdentity(r.Context(), q, wsID, &target, &actor, "member_banned"); err != nil {
			return err
		}
		ban, err = q.CreateBan(r.Context(), sqlc.CreateBanParams{
			WorkspaceID: wsID, UserID: target, Email: u.Email, Reason: reason, BannedBy: &actor,
		})
		return err
	})
	if err != nil {
		return err
	}
	perm.FromContext(r.Context()).Invalidate()
	slog.InfoContext(r.Context(), "member banned", "workspace", wsID, "user", target, "by", actor, "was_member", removed)
	if removed {
		// LiveKit participants of the removed user are disconnected by rtc.SyncPublisher.
		h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceMemberRemove{
			WorkspaceMemberRemove: &v1.WorkspaceMemberRemove{WorkspaceId: wsID.String(), UserId: target.String()},
		}})
		h.events.User(r.Context(), target, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceDelete{
			WorkspaceDelete: &v1.WorkspaceDelete{WorkspaceId: wsID.String()},
		}})
	}
	pb := pbconv.Ban(ban, u)
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceBanAdd{
		WorkspaceBanAdd: &v1.WorkspaceBanAdd{Ban: pb},
	}})
	httpx.Write(w, http.StatusCreated, &v1.CreateBanResponse{Ban: pb})
	return nil
}

func (h *Handlers) listBans(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireMembers(r)
	if err != nil {
		return err
	}
	rows, err := h.db.Q.ListBans(r.Context(), wsID)
	if err != nil {
		return err
	}
	out := &v1.ListBansResponse{Bans: make([]*v1.WorkspaceBan, len(rows))}
	for i, row := range rows {
		out.Bans[i] = pbconv.Ban(row.WorkspaceBan, row.User)
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// deleteBan: DELETE /api/workspaces/{id}/bans/{userId}. Lifting a ban does not restore the
// membership: the user can be invited again.
func (h *Handlers) deleteBan(w http.ResponseWriter, r *http.Request) error {
	wsID, _, err := requireMembers(r)
	if err != nil {
		return err
	}
	target, err := httpx.PathUUID(r, "userId", "ban")
	if err != nil {
		return err
	}
	n, err := db.GuardValue(r.Context(), h.db, func(guarded *sqlc.Queries) (int64, error) {
		return guarded.DeleteBan(r.Context(), sqlc.DeleteBanParams{WorkspaceID: wsID, UserID: target})
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return httpx.NotFound("ban")
	}
	slog.InfoContext(r.Context(), "member unbanned", "workspace", wsID, "user", target, "by", uid(r))
	h.events.Workspace(r.Context(), wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceBanRemove{
		WorkspaceBanRemove: &v1.WorkspaceBanRemove{WorkspaceId: wsID.String(), UserId: target.String()},
	}})
	httpx.NoContent(w)
	return nil
}
