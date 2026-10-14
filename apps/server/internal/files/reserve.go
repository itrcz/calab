package files

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Store is the blob store of the service (for packages that store workspace files
// themselves, e.g. stickers).
func (s *Service) Store() blob.Store { return s.store }

// ReserveWorkspace checks the server-wide storage cap and reserves size bytes of the
// workspace's effective quota (its own and the plan's storage limit) inside the caller's
// transaction, like an upload does: 413 FILE_QUOTA_EXCEEDED (reason PLAN_LIMIT when the plan
// binds) or 507 STORAGE_FULL.
func (s *Service) ReserveWorkspace(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID, size int64) error {
	ws, err := q.GetWorkspace(ctx, wsID)
	if err != nil {
		return err
	}
	quota, planQuota, err := s.quota(ctx, q, ws)
	if err != nil {
		return err
	}
	if err := s.checkTotal(ctx, q, size); err != nil {
		return err
	}
	if _, err := q.ReserveQuota(ctx, sqlc.ReserveQuotaParams{ID: wsID, Size: size, PlanQuota: planQuota}); err != nil {
		if db.IsNotFound(err) {
			return quota.err(ws.StorageUsedBytes)
		}
		return err
	}
	return nil
}

// IsQuotaError reports a ReserveWorkspace refusal for lack of space.
func IsQuotaError(err error) bool {
	return errors.Is(err, errQuota) || errors.Is(err, errStorageFull)
}
