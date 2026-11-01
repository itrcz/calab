package dms

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
)

// ErrUserUnavailable means a block between two people in either direction (ADR-0154). The same
// text for both sides, so the blocked person cannot tell a block from other refusals.
var ErrUserUnavailable = httpx.Coded(http.StatusForbidden, v1.ErrorCode_ERROR_CODE_USER_UNAVAILABLE, "this user cannot be messaged")

// CheckPersonDM refuses contact between two people (a new DM, a DM message or forward, a
// one-to-one call) when either blocked the other (ADR-0154).
func CheckPersonDM(ctx context.Context, q *sqlc.Queries, a, b uuid.UUID) error {
	blocked, err := q.IsBlockedEitherWay(ctx, sqlc.IsBlockedEitherWayParams{A: a, B: b})
	if err != nil {
		return err
	}
	if blocked {
		return ErrUserUnavailable
	}
	return nil
}

// BlockRoutes registers /api/me/blocked-users; wrap must apply auth + perm resolver.
func (h *Handlers) BlockRoutes(mux httpx.Router, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /api/me/blocked-users", wrap(httpx.HandlerFunc(h.listBlocked)))
	mux.Handle("POST /api/me/blocked-users/{id}", wrap(httpx.HandlerFunc(h.block)))
	mux.Handle("DELETE /api/me/blocked-users/{id}", wrap(httpx.HandlerFunc(h.unblock)))
}

func (h *Handlers) listBlocked(w http.ResponseWriter, r *http.Request) error {
	ids, err := h.db.Q.ListBlockedUsers(r.Context(), uid(r))
	if err != nil {
		return err
	}
	out := &v1.ListBlockedUsersResponse{UserIds: make([]string, len(ids))}
	for i, id := range ids {
		out.UserIds[i] = id.String()
	}
	httpx.Write(w, http.StatusOK, out)
	return nil
}

// block: POST /api/me/blocked-users/{id}. A person the caller shares a workspace or a DM with
// (404 otherwise, as POST /api/dms does not reveal other users); bots are blocked through
// /api/me/blocked-bots (ADR-0031).
func (h *Handlers) block(w http.ResponseWriter, r *http.Request) error {
	target, err := httpx.PathUUID(r, "id", "user")
	if err != nil {
		return err
	}
	me := uid(r)
	if target == me {
		return httpx.Validation("id", "cannot block yourself")
	}
	u, err := h.db.Q.GetUser(r.Context(), target)
	if db.IsNotFound(err) {
		return httpx.NotFound("user")
	}
	if err != nil {
		return err
	}
	if u.IsBot {
		return httpx.Validation("id", "bots are blocked through /api/me/blocked-bots")
	}
	if known, err := h.knows(r.Context(), me, target); err != nil {
		return err
	} else if !known {
		return httpx.NotFound("user")
	}
	if err := db.GuardExec(r.Context(), h.db, func(guarded *sqlc.Queries) error {
		return guarded.BlockUser(r.Context(), sqlc.BlockUserParams{UserID: me, BlockedUserID: target})
	}); err != nil {
		return err
	}
	slog.InfoContext(r.Context(), "user blocked", "user", me, "blocked", target)
	h.publishBlock(r.Context(), me, target, true)
	httpx.NoContent(w)
	return nil
}

func (h *Handlers) unblock(w http.ResponseWriter, r *http.Request) error {
	target, err := httpx.PathUUID(r, "id", "user")
	if err != nil {
		return err
	}
	me := uid(r)
	if err := db.GuardExec(r.Context(), h.db, func(guarded *sqlc.Queries) error {
		return guarded.UnblockUser(r.Context(), sqlc.UnblockUserParams{UserID: me, BlockedUserID: target})
	}); err != nil {
		return err
	}
	h.publishBlock(r.Context(), me, target, false)
	httpx.NoContent(w)
	return nil
}

// knows: the two share a workspace now or have a DM.
func (h *Handlers) knows(ctx context.Context, me, other uuid.UUID) (bool, error) {
	shared, err := h.db.Q.ShareWorkspace(ctx, sqlc.ShareWorkspaceParams{UserID: me, OtherID: other})
	if err != nil || shared {
		return shared, err
	}
	key := Key(me, other)
	_, err = h.db.Q.GetDMByKey(ctx, &key)
	if db.IsNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// publishBlock: USER_BLOCKS_UPDATE to the blocker's own sessions only (never to the target).
func (h *Handlers) publishBlock(ctx context.Context, me, target uuid.UUID, blocked bool) {
	h.events.User(context.WithoutCancel(ctx), me, &v1.DispatchEvent{Event: &v1.DispatchEvent_UserBlocksUpdate{
		UserBlocksUpdate: &v1.UserBlocksUpdate{UserId: target.String(), Blocked: blocked},
	}})
}
