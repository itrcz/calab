package plans

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// maxAddonMB bounds the add-ons counted on top of a plan (100 TiB, like maxStorageMB).
const maxAddonMB = maxStorageMB

// StorageWithAddons is the plan's storage limit in bytes raised by the active storage add-ons
// (addonMB, ADR-0094 §6); ok=false when the plan's storage is unlimited (add-ons change
// nothing then).
func (l Limits) StorageWithAddons(addonMB int64) (int64, bool) {
	if l.StorageMB == 0 {
		return 0, false
	}
	mb := int64(l.StorageMB) + min(max(addonMB, 0), maxAddonMB) //nolint:gosec // bounded by maxStorageMB
	return mb << 20, true
}

// EffectiveStorageBytes is the plan's storage limit of workspace wsID plus its active storage
// add-ons, in bytes (ok=false: unlimited). The workspace's own storage_quota_bytes caps it on
// top: the effective quota is min(storage_quota_bytes, this) (ADR-0024, ADR-0094 §6). q may be a
// transaction's queries.
func (s *Service) EffectiveStorageBytes(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) (int64, bool, error) {
	l, err := s.Effective(ctx, wsID)
	if err != nil {
		return 0, false, err
	}
	if l.StorageMB == 0 {
		return 0, false, nil
	}
	addon, err := q.SumActiveStorageAddonsMB(ctx, wsID)
	if err != nil {
		return 0, false, err
	}
	b, ok := l.StorageWithAddons(addon)
	return b, ok, nil
}
