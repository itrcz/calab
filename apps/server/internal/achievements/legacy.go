package achievements

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
)

// legacyKeyPrefix is the blob key space of the former host catalog's pictures
// ("achievements/<uuid>.webp", ADR-0061 before amendment 1).
const legacyKeyPrefix = "achievements/"

// legacyRetry is the pause after a failed pass of RunLegacyMigration.
const legacyRetry = time.Minute

// RunLegacyMigration runs MigrateLegacy at startup until it succeeds once (or ctx is done).
func (s *Service) RunLegacyMigration(ctx context.Context) {
	for {
		err := s.MigrateLegacy(ctx)
		if err == nil || ctx.Err() != nil {
			return
		}
		slog.ErrorContext(ctx, "achievements: legacy picture migration", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(legacyRetry):
		}
	}
}

// MigrateLegacy finishes migration 00063 (ADR-0061, amendment 1): every catalog entry copied from
// the former host catalog gets its picture as a new file of its workspace, made from the old blob
// (achievements.legacy_image_key); then the old blobs no entry waits for are deleted. One entry
// per transaction, its state in the database: a restart at any point repeats nothing that was
// committed and redoes nothing twice (an uncommitted copy's blob is removed, or at worst leaked).
// Several instances may run it at once (SKIP LOCKED). A no-op once done.
func (s *Service) MigrateLegacy(ctx context.Context) error {
	ctx = db.WithoutAdmission(ctx) // a server task, not a request
	copied := map[uuid.UUID]bool{}
	for {
		wsID, done, err := s.migrateLegacyOne(ctx)
		if err != nil {
			return err
		}
		if done {
			break
		}
		copied[wsID] = true
	}
	for wsID := range copied {
		s.events.Workspace(ctx, wsID, &v1.DispatchEvent{Event: &v1.DispatchEvent_WorkspaceAchievementsUpdate{
			WorkspaceAchievementsUpdate: &v1.WorkspaceAchievementsUpdate{WorkspaceId: wsID.String()},
		}})
	}
	return s.deleteLegacyBlobs(ctx)
}

// migrateLegacyOne copies the picture of one waiting entry; done = none is left (or the rest is
// locked by another instance).
func (s *Service) migrateLegacyOne(ctx context.Context) (uuid.UUID, bool, error) {
	var (
		wsID uuid.UUID
		done bool
		prep *files.PreparedFile
	)
	err := s.db.Tx(ctx, func(q *sqlc.Queries) error {
		a, err := q.NextLegacyAchievement(ctx)
		if db.IsNotFound(err) {
			done = true
			return nil
		}
		if err != nil {
			return err
		}
		wsID = a.WorkspaceID
		key := *a.LegacyImageKey
		data, err := s.readLegacy(ctx, key)
		if errors.Is(err, blob.ErrNotFound) {
			slog.WarnContext(ctx, "achievements: legacy picture missing, the entry stays without one", "id", a.ID, "key", key)
			return q.SetLegacyAchievementFile(ctx, sqlc.SetLegacyAchievementFileParams{ID: a.ID})
		}
		if err != nil {
			return err
		}
		ws, err := q.GetWorkspace(ctx, a.WorkspaceID)
		if err != nil {
			return err
		}
		w, h := a.Width, a.Height
		if w <= 0 || h <= 0 {
			w, h = ImageSide, ImageSide
		}
		// The workspace owner stands in as the uploader: the file is server-made.
		if prep, err = s.files.PrepareImage(ctx, a.WorkspaceID, ws.OwnerID, "achievement.webp", "image/webp", data, w, h); err != nil {
			return err
		}
		f, err := s.files.InsertPreparedUnchecked(ctx, q, prep)
		if err != nil {
			return err
		}
		return q.SetLegacyAchievementFile(ctx, sqlc.SetLegacyAchievementFileParams{ID: a.ID, FileID: &f.ID})
	})
	if err != nil {
		s.files.Discard(prep)
		return uuid.Nil, false, err
	}
	return wsID, done, nil
}

func (s *Service) readLegacy(ctx context.Context, key string) ([]byte, error) {
	if !strings.HasPrefix(key, legacyKeyPrefix) {
		return nil, fmt.Errorf("legacy achievement key %q outside %s", key, legacyKeyPrefix)
	}
	rc, _, err := s.store.Get(ctx, key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	data, err := io.ReadAll(io.LimitReader(rc, MaxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxImageBytes {
		return nil, fmt.Errorf("legacy achievement picture %q over %d bytes", key, MaxImageBytes)
	}
	return data, nil
}

// deleteLegacyBlobs removes the former host pictures no entry waits for: the blob first, then its
// row (a restart in between deletes the blob again, which is a no-op).
func (s *Service) deleteLegacyBlobs(ctx context.Context) error {
	keys, err := s.db.Q.ListLegacyAchievementBlobs(ctx)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if strings.HasPrefix(key, legacyKeyPrefix) {
			if err := s.store.Delete(ctx, key); err != nil && !errors.Is(err, blob.ErrNotFound) {
				return fmt.Errorf("delete legacy achievement picture %q: %w", key, err)
			}
		}
		if err := s.db.Q.DeleteLegacyAchievementBlob(ctx, key); err != nil {
			return err
		}
	}
	if len(keys) > 0 {
		slog.InfoContext(ctx, "achievements: legacy pictures deleted", "count", len(keys))
	}
	return nil
}
