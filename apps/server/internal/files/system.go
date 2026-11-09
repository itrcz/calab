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
	"github.com/calaba/calaba/server/internal/httpx"
)

// Open streams a stored file (its blob) with its size.
func (s *Service) Open(ctx context.Context, f sqlc.File) (io.ReadCloser, int64, error) {
	rc, _, err := s.store.Get(ctx, f.Key)
	if errors.Is(err, blob.ErrNotFound) {
		return nil, 0, httpx.NotFound("file")
	}
	if err != nil {
		return nil, 0, err
	}
	return rc, f.Size, nil
}

// MaxUploadBytes is MAX_FILE_SIZE_MB in bytes: what a person may put into a workspace at once
// unless the workspace overrides it (ADR-0155).
func (s *Service) MaxUploadBytes() int64 { return s.maxBytes }

// CopyInto stores a copy of f (a file the caller may read) as a new file of workspace ws
// uploaded by uploader, named name ("" = f's name): a new id, its own blob and quota (the Disk
// deletes its files rows with its items, so two owners never share one row). Not attached yet,
// as StoreSystemFile. 413 above the uploader's file size limit in the workspace (ADR-0155;
// ADR-0164: the hard cap for its administrators) or the quota. ctx carries the perm resolver.
func (s *Service) CopyInto(ctx context.Context, ws, uploader uuid.UUID, f sqlc.File, name string) (sqlc.File, error) {
	w, err := s.db.Q.GetWorkspace(ctx, ws)
	if err != nil {
		return sqlc.File{}, err
	}
	limit, err := s.maxFileFor(ctx, w, uploader)
	if err != nil {
		return sqlc.File{}, err
	}
	if limit > 0 && f.Size > limit {
		return sqlc.File{}, tooLarge(limit)
	}
	rc, _, err := s.Open(ctx, f)
	if err != nil {
		return sqlc.File{}, err
	}
	defer func() { _ = rc.Close() }()
	if name == "" {
		name = f.Name
	}
	c, err := s.StoreSystemFile(ctx, ws, uploader, name, f.Mime, rc, f.Size)
	if errors.Is(err, ErrNoRoom) {
		return c, errQuota
	}
	return c, err
}

// QuotaExceeded is the 413 FILE_QUOTA_EXCEEDED of a StoreSystemFile that did not fit (ErrNoRoom).
func QuotaExceeded() error { return errQuota }

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
			ID: id, WorkspaceID: &wsID, UploaderID: &uploader, Key: key, Name: SanitizeName(name), Mime: mimeType,
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
