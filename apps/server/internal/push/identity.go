package push

import (
	"context"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/google/uuid"
)

// Keep canonical identity lock ordering: workspace, user, membership, session.
// Policy changes and revocation cannot overtake the exact-session send-time gate.
func (s *Service) lockDeliverySession(ctx context.Context, q *sqlc.Queries, user, session uuid.UUID, job sqlc.PushDelivery) (sqlc.Session, error) {
	var workspace *uuid.UUID
	var err error
	if job.RoomID != nil {
		workspace, err = q.GetIdentityRoomParent(ctx, *job.RoomID)
		if err != nil {
			return sqlc.Session{}, err
		}
	}
	if workspace != nil {
		if _, err = q.LockIdentityWorkspaceShared(ctx, *workspace); err != nil {
			return sqlc.Session{}, err
		}
	}
	if _, err = q.LockIdentityUserShared(ctx, user); err != nil {
		return sqlc.Session{}, err
	}
	if workspace != nil {
		if _, err = q.LockIdentityMemberShared(ctx, sqlc.LockIdentityMemberSharedParams{WorkspaceID: *workspace, UserID: user}); err != nil {
			return sqlc.Session{}, err
		}
	}
	return q.LockPushDeliverySession(ctx, sqlc.LockPushDeliverySessionParams{ID: session, UserID: user})
}
