package achievements

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/moderation"
)

const maxPosition = 1_000_000

// sourceFile checks the upload a picture is made from: a PNG or WebP the caller uploaded to this
// workspace, at most MaxImageBytes, not a sticker's file (the badge rule: someone else's file —
// e.g. an attachment of a restricted room — must not be copied into a picture every member reads).
func sourceFile(ctx context.Context, q *sqlc.Queries, wsID, caller uuid.UUID, raw string) (sqlc.File, error) {
	bad := httpx.Validation("fileId", "a PNG or WebP image you uploaded to this workspace, at most 4 MB")
	id, err := uuid.Parse(raw)
	if err != nil {
		return sqlc.File{}, bad
	}
	f, err := q.GetFile(ctx, id)
	if db.IsNotFound(err) {
		return f, bad
	}
	if err != nil {
		return f, err
	}
	switch {
	case f.WorkspaceID == nil || *f.WorkspaceID != wsID || f.UploaderID != caller:
		return f, bad
	case f.Mime != "image/png" && f.Mime != "image/webp":
		return f, bad
	case f.Size > MaxImageBytes:
		return f, bad
	}
	if _, err := q.GetStickerFileWorkspace(ctx, id); err == nil {
		return f, bad
	} else if !db.IsNotFound(err) {
		return f, err
	}
	return f, nil
}

// prepare makes the picture of the upload raw and stores it as a new file of the workspace (not
// inserted yet: InsertPrepared in the caller's transaction, or Discard). Decoding is slow: before
// any transaction.
func (s *Service) prepare(r *http.Request, wsID uuid.UUID, raw string) (*files.PreparedFile, int, error) {
	ctx := r.Context()
	caller := auth.MustFromContext(ctx).UserID
	src, err := sourceFile(ctx, s.db.Q, wsID, caller, raw)
	if err != nil {
		return nil, 0, err
	}
	rc, _, err := s.store.Get(ctx, src.Key)
	if errors.Is(err, blob.ErrNotFound) {
		return nil, 0, httpx.Validation("fileId", "the file is gone")
	}
	if err != nil {
		return nil, 0, err
	}
	data, err := io.ReadAll(io.LimitReader(rc, MaxImageBytes+1))
	_ = rc.Close()
	if err != nil {
		return nil, 0, err
	}
	img, err := PrepareAchievement(ctx, data)
	if err != nil {
		return nil, 0, imageError(err)
	}
	prep, err := s.files.PrepareImage(ctx, wsID, caller, "achievement.webp", "image/webp", img, ImageSide, ImageSide)
	if err != nil {
		return nil, 0, err
	}
	return prep, len(img), nil
}

// imageError maps a pipeline error to the API.
func imageError(err error) error {
	var ie *ImageError
	switch {
	case errors.Is(err, ErrNeedsAlpha):
		return httpx.Validation("fileId", err.Error()).WithDetails(ReasonNeedsAlpha, 0, 0)
	case errors.As(err, &ie):
		return httpx.Validation("fileId", ie.Msg)
	}
	return err
}

func tooMany(n int32) error {
	return httpx.Conflict("a workspace has at most "+strconv.Itoa(MaxPerWorkspace)+" achievements").
		WithDetails(ReasonLimit, uint64(max(n, 0)), MaxPerWorkspace)
}

// create: POST /api/workspaces/{id}/achievements (MANAGE_WORKSPACE).
func (s *Service) create(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	wsID, bits, role, err := access(r)
	if err != nil {
		return err
	}
	if err := canManageCatalog(bits, role); err != nil {
		return err
	}
	var req v1.CreateAchievementRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	title, err := text("title", req.GetTitle(), 1, maxTitle)
	if err != nil {
		return err
	}
	desc, err := text("description", req.GetDescription(), 0, maxDescription)
	if err != nil {
		return err
	}
	// A cheap early refusal: no decoding when the catalog is full (checked again under the lock).
	if n, err := s.db.Q.CountWorkspaceAchievements(ctx, wsID); err != nil {
		return err
	} else if n >= MaxPerWorkspace {
		return tooMany(n)
	}
	prep, size, err := s.prepare(r, wsID, req.GetFileId())
	if err != nil {
		return err
	}
	actor := auth.MustFromContext(ctx).UserID
	var a sqlc.Achievement
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockWorkspaceAchievements(ctx, wsID); err != nil {
			return err
		}
		n, err := q.CountWorkspaceAchievements(ctx, wsID)
		if err != nil {
			return err
		}
		if n >= MaxPerWorkspace {
			return tooMany(n)
		}
		f, err := s.files.InsertPrepared(ctx, q, prep)
		if err != nil {
			return err
		}
		a, err = q.InsertAchievement(ctx, sqlc.InsertAchievementParams{
			WorkspaceID: wsID, Title: title, Description: desc, FileID: &f.ID,
			ImageSize: int32(size), Width: ImageSide, Height: ImageSide, CreatedBy: &actor, //nolint:gosec // ≤ 4 MB
		})
		return err
	})
	if err != nil {
		s.files.Discard(prep)
		return err
	}
	// The upload it was made from stays unattached and goes with the orphan cleanup.
	slog.InfoContext(ctx, "achievement created", "workspace", wsID, "id", a.ID, "by", actor)
	s.catalogChanged(r, wsID)
	httpx.Write(w, http.StatusCreated, Proto(a, 0, false))
	return nil
}

// loadManaged resolves PATCH / DELETE /api/achievements/{id}: the entry and its workspace, where
// the caller needs MANAGE_WORKSPACE (404 to non-members, 403 without the right) and the workspace
// must not be suspended (read-only, docs/04).
func loadManaged(r *http.Request, q *sqlc.Queries) (sqlc.Achievement, error) {
	id, err := httpx.PathUUID(r, "id", "achievement")
	if err != nil {
		return sqlc.Achievement{}, err
	}
	a, err := q.GetAchievement(r.Context(), id)
	if db.IsNotFound(err) {
		return a, httpx.NotFound("achievement")
	}
	if err != nil {
		return a, err
	}
	bits, role, err := workspaceAccess(r, a.WorkspaceID, "achievement")
	if err != nil {
		return a, err
	}
	if err := canManageCatalog(bits, role); err != nil {
		return a, err
	}
	return a, moderation.CheckSuspended(r.Context(), q, a.WorkspaceID)
}

// update: PATCH /api/achievements/{id} (MANAGE_WORKSPACE; every field optional).
func (s *Service) update(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	cur, err := loadManaged(r, s.db.Q)
	if err != nil {
		return err
	}
	var req v1.UpdateAchievementRequest
	if err := httpx.Decode(w, r, &req); err != nil {
		return err
	}
	var title, desc *string
	if req.Title != nil {
		t, err := text("title", req.GetTitle(), 1, maxTitle)
		if err != nil {
			return err
		}
		title = &t
	}
	if req.Description != nil {
		d, err := text("description", req.GetDescription(), 0, maxDescription)
		if err != nil {
			return err
		}
		desc = &d
	}
	if req.Position != nil && (req.GetPosition() < 0 || req.GetPosition() > maxPosition) {
		return httpx.Validation("position", "position must be 0..1000000")
	}
	var prep *files.PreparedFile
	size := 0
	if req.FileId != nil {
		if s.Plans != nil {
			if err := s.Plans.CheckActive(ctx, cur.WorkspaceID, "uploading files"); err != nil { // plans.RestrictedUpload
				return err
			}
		}
		if prep, size, err = s.prepare(r, cur.WorkspaceID, req.GetFileId()); err != nil {
			return err
		}
	}
	var a sqlc.Achievement
	var granted int64
	var inUse bool
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		c, err := q.LockAchievement(ctx, cur.ID)
		if db.IsNotFound(err) {
			return httpx.NotFound("achievement")
		}
		if err != nil {
			return err
		}
		p := sqlc.UpdateAchievementParams{ID: c.ID, Title: c.Title, Description: c.Description, FileID: c.FileID,
			ImageSize: c.ImageSize, Width: c.Width, Height: c.Height, Position: c.Position, ArchivedAt: c.ArchivedAt,
			LegacyImageKey: c.LegacyImageKey}
		if title != nil {
			p.Title = *title
		}
		if desc != nil {
			p.Description = *desc
		}
		if req.Position != nil {
			p.Position = req.GetPosition()
		}
		if req.Archived != nil {
			switch {
			case !req.GetArchived():
				p.ArchivedAt = nil
			case c.ArchivedAt == nil:
				now := time.Now()
				p.ArchivedAt = &now
			}
		}
		if prep != nil {
			f, err := s.files.InsertPrepared(ctx, q, prep)
			if err != nil {
				return err
			}
			// The previous picture is now unreferenced and goes with the orphan cleanup; a
			// former host picture still waiting for its copy is not needed any more.
			p.FileID, p.LegacyImageKey = &f.ID, nil
			p.ImageSize, p.Width, p.Height = int32(size), ImageSide, ImageSide //nolint:gosec // ≤ 4 MB
		}
		if a, err = q.UpdateAchievement(ctx, p); err != nil {
			return err
		}
		st, err := q.AchievementGrantStats(ctx, c.ID)
		granted, inUse = st.Granted, st.InUse
		return err
	})
	if err != nil {
		s.files.Discard(prep)
		return err
	}
	slog.InfoContext(ctx, "achievement updated", "workspace", a.WorkspaceID, "id", a.ID,
		"by", auth.MustFromContext(ctx).UserID, "image", prep != nil, "archived", a.ArchivedAt != nil)
	s.catalogChanged(r, a.WorkspaceID)
	httpx.Write(w, http.StatusOK, Proto(a, granted, inUse))
	return nil
}

// remove: DELETE /api/achievements/{id} (MANAGE_WORKSPACE) — only one that was never granted.
// Its picture goes with the orphan cleanup.
func (s *Service) remove(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	cur, err := loadManaged(r, s.db.Q)
	if err != nil {
		return err
	}
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if _, err := q.LockAchievement(ctx, cur.ID); db.IsNotFound(err) {
			return httpx.NotFound("achievement")
		} else if err != nil {
			return err
		}
		n, err := q.DeleteAchievement(ctx, cur.ID)
		if err != nil {
			return err
		}
		if n == 0 {
			return httpx.Conflict("the achievement was granted: archive it instead").WithDetails(ReasonInUse, 0, 0)
		}
		return nil
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "achievement deleted", "workspace", cur.WorkspaceID, "id", cur.ID, "by", auth.MustFromContext(ctx).UserID)
	s.catalogChanged(r, cur.WorkspaceID)
	httpx.NoContent(w)
	return nil
}
