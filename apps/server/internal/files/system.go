package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Files the server itself attaches to a workspace message (a meeting recording's audio on its
// chat card, docs/09 #47). They count against the same quotas as uploads: the workspace's
// (its own and the plan's) and the server-wide cap; the per-file size limit
// (MAX_FILE_SIZE_MB) is for uploads by people and does not apply.

// ErrNoRoom is returned by StoreSystemFile when the file does not fit a quota.
var ErrNoRoom = errors.New("files: the workspace or server storage quota is exceeded")

// StoreSystemFile stores size bytes of r as a workspace file uploaded by uploader and returns
// its row (not attached yet: the caller attaches it in the same breath, before the 24 h orphan
// cleanup could see it). ErrNoRoom when it does not fit a quota.
func (s *Service) StoreSystemFile(ctx context.Context, wsID, uploader uuid.UUID, name, mimeType string, r io.Reader, size int64) (sqlc.File, error) {
	ws, err := s.db.Q.GetWorkspace(ctx, wsID)
	if err != nil {
		return sqlc.File{}, err
	}
	quota, planQuota, err := s.quota(ctx, s.db.Q, ws)
	if err != nil {
		return sqlc.File{}, err
	}
	if ws.StorageUsedBytes+size > quota.limit {
		return sqlc.File{}, ErrNoRoom // before writing hundreds of megabytes
	}
	id, err := uuid.NewV7()
	if err != nil {
		return sqlc.File{}, err
	}
	key := blob.FileKey(wsID, id)
	h := sha256.New()
	if err := s.store.Put(ctx, key, io.TeeReader(r, h), size, mimeType); err != nil {
		return sqlc.File{}, fmt.Errorf("store %s: %w", key, err)
	}
	var f sqlc.File
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := s.checkTotal(ctx, q, size); err != nil {
			return err
		}
		if _, err := q.ReserveQuota(ctx, sqlc.ReserveQuotaParams{ID: wsID, Size: size, PlanQuota: planQuota}); err != nil {
			return err
		}
		f, err = q.InsertFile(ctx, sqlc.InsertFileParams{
			ID: id, WorkspaceID: &wsID, UploaderID: uploader, Key: key, Name: SanitizeName(name), Mime: mimeType,
			Size: size, Sha256: hex.EncodeToString(h.Sum(nil)),
		})
		return err
	})
	if err != nil {
		_ = s.store.Delete(context.WithoutCancel(ctx), key)
		if db.IsNotFound(err) || errors.Is(err, errStorageFull) {
			return sqlc.File{}, ErrNoRoom
		}
		return sqlc.File{}, err
	}
	return f, nil
}

// DeleteFile removes a file: its row (and so its attachments), its quota and its blobs. A file
// that is already gone is no error.
func (s *Service) DeleteFile(ctx context.Context, id uuid.UUID) error {
	var gone *sqlc.File
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		f, err := q.GetFile(ctx, id)
		if db.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		n, err := q.DeleteFile(ctx, id)
		if err != nil || n == 0 {
			return err
		}
		if f.WorkspaceID != nil {
			if err := q.ReleaseQuota(ctx, sqlc.ReleaseQuotaParams{ID: *f.WorkspaceID, Size: f.Size}); err != nil {
				return err
			}
		}
		gone = &f
		return nil
	})
	if err != nil || gone == nil {
		return err
	}
	// Rows first, blobs after (as the orphan cleanup): a crash leaks bytes, never dangling rows.
	ctx = context.WithoutCancel(ctx)
	_ = s.store.Delete(ctx, gone.Key)
	blob.DeleteThumbs(ctx, s.store, gone.Key, gone.ThumbnailKey)
	return nil
}
