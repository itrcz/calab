// Package moderation enforces workspace suspension and bans (backlog item 32).
//
// Suspension (by a superadmin, see plans.Admin) makes a workspace read-only. Instead of a
// check in every handler, Guard refuses the write routes listed in blocked — one table that
// says what a suspension stops — before the handler runs. Room-scoped routes reuse the
// request's permission resolver, so the handler's own access check costs no extra query.
// Public routes (room links) call CheckSuspended themselves.
//
// Bans are checked by CheckBan on every way into a workspace (invitation, open join, email
// invitation, registration with an invitation, room link).
package moderation

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/perm"
)

// ErrSuspended means the workspace is suspended (the reason is in Workspace.suspension, for the
// owner / admins only — not in the error).
var ErrSuspended = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "the workspace is suspended")

// ErrBanned means the user (or their address) is banned from the workspace.
var ErrBanned = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_BANNED, "you are banned from this workspace")

// scope says what the {id} / {code} path value of a blocked route names.
type scope int

const (
	scopeRoom scope = iota + 1
	scopeMessage
	scopeWorkspace
	scopeInvite
)

// blocked: the routes a suspension refuses (method + pattern as registered).
var blocked = map[string]scope{
	// messages, reactions
	"POST /api/rooms/{id}/messages":               scopeRoom,
	"PATCH /api/messages/{id}":                    scopeMessage,
	"PUT /api/messages/{id}/reactions/{emoji}":    scopeMessage,
	"DELETE /api/messages/{id}/reactions/{emoji}": scopeMessage,
	"POST /api/workspaces/{id}/files":             scopeWorkspace,
	// sticker packs (ADR-0030); the pack / sticker routes check the suspension themselves
	"POST /api/workspaces/{id}/sticker-packs": scopeWorkspace,
	// soundboard (ADR-0036); PATCH / DELETE check the suspension themselves
	"POST /api/workspaces/{id}/sounds": scopeWorkspace,
	// achievement catalog (ADR-0061 amendment 1): a new picture is a new file; PATCH / DELETE
	// check the suspension themselves
	"POST /api/workspaces/{id}/achievements": scopeWorkspace,
	// voice, streams, cameras, recording
	"POST /api/rooms/{id}/join":                        scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/move":         scopeRoom,
	"POST /api/rooms/{id}/stream/request":              scopeRoom,
	"POST /api/rooms/{id}/camera/request":              scopeRoom,
	"POST /api/rooms/{id}/sounds/play":                 scopeRoom,
	"POST /api/rooms/{id}/voice/{userId}/allow-camera": scopeRoom,
	"POST /api/rooms/{id}/recording/start":             scopeRoom,
	"POST /api/rooms/{id}/calls":                       scopeRoom, // telephony (ADR-0046)
	"POST /api/workspaces/{id}/sip/test":               scopeWorkspace,
	"POST /api/rooms/{id}/recordings/{rid}/recheck":    scopeRoom,
	"POST /api/rooms/{id}/recordings/{rid}/reupload":   scopeRoom,
	// invitations and joining
	"POST /api/rooms/{id}/invites":            scopeRoom,
	"POST /api/workspaces/{id}/invites":       scopeWorkspace,
	"POST /api/workspaces/{id}/invites/email": scopeWorkspace,
	"POST /api/workspaces/{id}/members":       scopeWorkspace,
	"POST /api/workspaces/{id}/join":          scopeWorkspace,
	// a temporary room comes with a room link (ADR-0044)
	"POST /api/workspaces/{id}/rooms/temp": scopeWorkspace,
	"POST /api/invites/{code}/join":        scopeInvite,
	// bots (ADR-0031): a bot joining the workspace is an invitation too
	"POST /api/workspaces/{id}/bots":     scopeWorkspace,
	"POST /api/workspaces/{id}/bots/add": scopeWorkspace,
}

// Blocked reports whether a suspension refuses the route pattern (tests, docs).
func Blocked(pattern string) bool { _, ok := blocked[pattern]; return ok }

// Guard refuses the blocked routes of suspended workspaces with 403 WORKSPACE_SUSPENDED. It must
// run inside auth and the per-request permission resolver (the private route wrapper). Unknown
// ids and inaccessible rooms pass through: the handler answers them as before (404), so the
// guard reveals nothing. caller returns the authenticated user of a request context.
func Guard(q *sqlc.Queries, caller func(context.Context) uuid.UUID) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sc, ok := blocked[r.Pattern]
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			suspended, err := isSuspended(r, q, caller, sc)
			if err == nil && suspended {
				err = ErrSuspended
			}
			if err != nil {
				httpx.WriteError(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isSuspended(r *http.Request, q *sqlc.Queries, caller func(context.Context) uuid.UUID, sc scope) (bool, error) {
	ctx := r.Context()
	if sc == scopeInvite {
		return q.InviteWorkspaceSuspended(ctx, r.PathValue("code"))
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		return false, nil // the handler rejects the id
	}
	switch sc {
	case scopeRoom:
		acc, err := perm.FromContext(ctx).Room(ctx, id, caller(ctx))
		if errors.Is(err, perm.ErrNoRoom) {
			return false, nil
		}
		return acc.Suspended, err
	case scopeMessage:
		return q.MessageWorkspaceSuspended(ctx, id)
	default:
		return q.WorkspaceSuspended(ctx, id)
	}
}

// CheckSuspended returns ErrSuspended when the workspace is suspended.
func CheckSuspended(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) error {
	s, err := q.WorkspaceSuspended(ctx, wsID)
	if err != nil {
		return err
	}
	if s {
		return ErrSuspended
	}
	return nil
}

// CheckBan returns ErrBanned when userID — or email, if not nil — is banned from the workspace.
func CheckBan(ctx context.Context, q *sqlc.Queries, wsID, userID uuid.UUID, email *string) error {
	banned, err := q.IsBanned(ctx, sqlc.IsBannedParams{WorkspaceID: wsID, UserID: userID, Email: email})
	if err != nil {
		return err
	}
	if banned {
		return ErrBanned
	}
	return nil
}
