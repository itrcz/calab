// Package account implements account deletion by the user (ADR-0153): POST /api/me/delete turns
// the caller's account into an anonymous tombstone at once. Other people's history (messages,
// tasks, files in workspaces and DMs) keeps the account id as its author, shown as
// «Удалённый пользователь»; everything that only describes the user is erased.
package account

import (
	"context"
	"log/slog"
	"net/http"
	"slices"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/workspaces"
)

// ReasonOwnsWorkspaces is the ApiError.reason of a deletion refused while the caller owns
// workspaces (the client lists them from its own store).
const ReasonOwnsWorkspaces = "OWNS_WORKSPACES"

// auditAction names the deletion in each workspace's identity audit and invalidation outbox.
const auditAction = "account_deleted"

// Service deletes accounts.
type Service struct {
	db     *db.DB
	auth   *auth.Service
	creds  *auth.Handlers // the shared bucket of password checks
	events events.Publisher
	plans  *plans.Service
}

// New creates the service.
func New(d *db.DB, a *auth.Service, creds *auth.Handlers, ev events.Publisher, pl *plans.Service) *Service {
	return &Service{db: d, auth: a, creds: creds, events: ev, plans: pl}
}

// Routes registers POST /api/me/delete; wrap must apply authentication and the identity gate.
func (s *Service) Routes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /api/me/delete", wrap(httpx.HandlerFunc(s.handleDelete)))
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) error {
	id := auth.MustFromContext(r.Context())
	if id.IsBot || id.OnBehalf() {
		return auth.ErrBotNotAllowed // the route table denies them already; never a bot's own account
	}
	var req v1.DeleteAccountRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	if req.GetCurrentPassword() == "" {
		return httpx.Validation("currentPassword", "the current password is required")
	}
	if err := s.creds.CredentialLimit(r, id.UserID); err != nil {
		return err
	}
	if err := s.Delete(r.Context(), id.UserID, req.GetCurrentPassword()); err != nil {
		return err
	}
	httpx.NoContent(w)
	return nil
}

// removal is what the transaction hands to the after-commit steps.
type removal struct {
	user       sqlc.User
	workspaces []uuid.UUID
	formers    []sqlc.WorkspaceFormerMember
	sessions   []uuid.UUID
}

// Delete re-authenticates userID with password and deletes the account (ADR-0153). Refused with
// 409 OWNS_WORKSPACES while the user owns a workspace. ctx carries the request's commit admission
// (scopeGlobal: the user and the session are locked exclusively and re-checked inside the
// transaction).
func (s *Service) Delete(ctx context.Context, userID uuid.UUID, password string) error {
	if err := s.auth.CheckPassword(ctx, userID, password); err != nil {
		return err
	}
	var out removal
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		var err error
		out, err = s.remove(ctx, q, userID)
		return err
	})
	if err != nil {
		return err
	}
	s.after(ctx, out)
	return nil
}

func (s *Service) remove(ctx context.Context, q *sqlc.Queries, uid uuid.UUID) (out removal, err error) {
	// The lock workspace creation takes: no workspace can become the user's after the check.
	if err = q.LockUserWorkspaces(ctx, uid.String()); err != nil {
		return out, err
	}
	owned, err := q.CountOwnedWorkspaces(ctx, uid)
	if err != nil {
		return out, err
	}
	if owned > 0 {
		return out, httpx.Conflict("delete the workspaces you own first").WithDetails(ReasonOwnsWorkspaces, 0, 0)
	}
	u, err := q.GetUser(ctx, uid)
	if err != nil {
		return out, err
	}
	if u.IsGuest || u.IsBot || u.DeletedAt != nil {
		return out, httpx.Forbidden("this account cannot be deleted")
	}
	// Memberships first, in a fixed order (workspace source locks of InvalidateIdentity): each
	// one is left like a member who leaves — identity grants revoked, seat freed, overrides
	// dropped — and kept as a former member with the reason account_deleted.
	if out.workspaces, err = q.ListUserWorkspaceIDs(ctx, uid); err != nil {
		return out, err
	}
	slices.SortFunc(out.workspaces, func(a, b uuid.UUID) int { return slices.Compare(a[:], b[:]) })
	for _, ws := range out.workspaces {
		if err = auth.InvalidateIdentity(ctx, q, ws, &uid, &uid, auditAction); err != nil {
			return out, err
		}
		f, removed, err := workspaces.RemoveMembership(ctx, q, s.plans, ws, uid, workspaces.ReasonAccountDeleted, nil)
		if err != nil {
			return out, err
		}
		if removed {
			out.formers = append(out.formers, f)
		}
	}
	if err = q.DeleteUserRoomOverrides(ctx, uid.String()); err != nil {
		return out, err
	}
	if _, err = q.DeleteUserNotesRooms(ctx, uid); err != nil { // personal shelves (ADR-0039)
		return out, err
	}
	if err = q.DeleteAccountPersonalData(ctx, uid); err != nil {
		return out, err
	}
	if out.sessions, err = q.RevokeAllUserSessions(ctx, sqlc.RevokeAllUserSessionsParams{UserID: uid, Reason: auth.RevokeAccountDeleted}); err != nil {
		return out, err
	}
	if err = q.ScrubUserSessions(ctx, uid); err != nil {
		return out, err
	}
	// The avatar file is not deleted here: an avatar may be any image the user uploaded, also one
	// attached to a message, a Disk item or a wiki page (or forwarded by someone else), and
	// deleting the row would cascade into other people's history. With avatar_file_id cleared
	// below, the orphan cleanup (files.CleanupOrphans) removes it once nothing references it.
	if out.user, err = q.AnonymizeDeletedUser(ctx, uid); err != nil {
		return out, err
	}
	return out, q.ScrubFormerSnapshots(ctx, uid)
}

// after runs the post-commit steps: the revocation (access tokens die now, the gateway closes the
// sockets 4010), the anonymous profile and the removals to the workspaces.
func (s *Service) after(ctx context.Context, out removal) {
	ctx = context.WithoutCancel(ctx)
	// Revocation first, before the identity invalidation of the memberships can ask the sockets
	// to resync (4000; their next IDENTIFY gets 4010 then).
	s.auth.MarkRevoked(ctx, auth.RevokeAccountDeleted, out.sessions...)
	if len(out.workspaces) > 0 {
		s.events.Workspaces(ctx, out.workspaces, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserUpdate{
			UserUpdate: &v1.UserUpdate{User: pbconv.UserEvent(out.user)},
		}})
	}
	for _, f := range out.formers {
		workspaces.PublishRemoved(ctx, s.events, f)
	}
	slog.InfoContext(ctx, "account deleted", "user_id", out.user.ID, "workspaces", len(out.workspaces))
}
