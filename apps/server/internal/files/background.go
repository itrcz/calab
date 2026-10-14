package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"io"

	"github.com/gen2brain/webp"
	"github.com/google/uuid"
	"golang.org/x/image/draw"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Camera backgrounds of a workspace (ADR-0035, addendum 2026-09-29): the server makes the
// picture itself from the admin's upload — a centre crop to 16:9 as a BackgroundWidth ×
// BackgroundHeight WebP, with a BackgroundThumbWidth × BackgroundThumbHeight thumbnail (served
// by GET /api/files/{id}/thumbnail).
const (
	BackgroundWidth          = 1280
	BackgroundHeight         = 720
	BackgroundThumbWidth     = 320
	BackgroundThumbHeight    = 180
	MaxBackgroundSourceBytes = 10 << 20
	backgroundQuality        = 85
	backgroundThumbQuality   = 80
)

// CoverRect is the centred part of a w×h picture with the aspect aw:ah («cover»).
func CoverRect(w, h, aw, ah int) image.Rectangle {
	if w <= 0 || h <= 0 || aw <= 0 || ah <= 0 {
		return image.Rectangle{}
	}
	if int64(w)*int64(ah) > int64(h)*int64(aw) { // wider: crop the sides
		cw := max(1, int(int64(h)*int64(aw)/int64(ah)))
		x := (w - cw) / 2
		return image.Rect(x, 0, x+cw, h)
	}
	ch := max(1, int(int64(w)*int64(ah)/int64(aw)))
	y := (h - ch) / 2
	return image.Rect(0, y, w, y+ch)
}

// BackgroundImages decodes an image (first frame for GIF), crops its centre to 16:9 and encodes
// the BackgroundWidth×BackgroundHeight picture and its thumbnail as lossy WebP. A smaller image is
// scaled up: every background has the same size (the compositor's texture).
func BackgroundImages(ctx context.Context, open func() (io.ReadCloser, error)) (full, thumb []byte, err error) {
	err = withDecoded(ctx, open, func(src image.Image) error {
		crop := CoverRect(src.Bounds().Dx(), src.Bounds().Dy(), BackgroundWidth, BackgroundHeight).Add(src.Bounds().Min)
		dst := image.NewRGBA(image.Rect(0, 0, BackgroundWidth, BackgroundHeight))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, crop, draw.Src, nil)
		small := image.NewRGBA(image.Rect(0, 0, BackgroundThumbWidth, BackgroundThumbHeight))
		draw.CatmullRom.Scale(small, small.Bounds(), dst, dst.Bounds(), draw.Src, nil)
		var a, b bytes.Buffer
		if err := webp.Encode(&a, dst, webp.Options{Quality: backgroundQuality}); err != nil {
			return err
		}
		if err := webp.Encode(&b, small, webp.Options{Quality: backgroundThumbQuality}); err != nil {
			return err
		}
		full, thumb = a.Bytes(), b.Bytes()
		return nil
	})
	return full, thumb, err
}

// PreparedFile is a server-made file whose blobs are stored but whose row is not inserted yet:
// InsertPrepared in the caller's transaction, or Discard.
type PreparedFile struct {
	st          *stored
	workspaceID uuid.UUID
	uploader    uuid.UUID
}

// PrepareBackground makes the camera background of the image file src (a workspace file; the
// caller checked who may use it) and stores its blobs as a new file of that workspace. A file
// that is not a decodable image within MaxPixels is IsBadImage.
func (s *Service) PrepareBackground(ctx context.Context, src sqlc.File) (*PreparedFile, error) {
	if src.WorkspaceID == nil {
		return nil, errBadImage
	}
	open := func() (io.ReadCloser, error) {
		rc, _, err := s.store.Get(ctx, src.Key)
		return rc, err
	}
	full, thumb, err := BackgroundImages(ctx, open)
	if err != nil {
		if errors.Is(err, blob.ErrNotFound) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %w", errBadImage, err)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(full)
	w, h := int32(BackgroundWidth), int32(BackgroundHeight)
	st := &stored{id: id, key: blob.FileKey(*src.WorkspaceID, id), name: "background.webp", mime: "image/webp",
		size: int64(len(full)), sha256: hex.EncodeToString(sum[:]), width: &w, height: &h}
	if err := s.store.Put(ctx, st.key, bytes.NewReader(full), st.size, "image/webp"); err != nil {
		return nil, fmt.Errorf("store background: %w", err)
	}
	thumbKey := st.key + ".thumb"
	if err := s.store.Put(ctx, thumbKey, bytes.NewReader(thumb), int64(len(thumb)), "image/webp"); err != nil {
		s.discard(st)
		return nil, fmt.Errorf("store background thumbnail: %w", err)
	}
	st.thumbKey = &thumbKey
	return &PreparedFile{st: st, workspaceID: *src.WorkspaceID, uploader: src.UploaderID}, nil
}

// PrepareImage stores data, a picture the server made (mime, w×h), as a new file of the workspace
// wsID uploaded by uploader: InsertPrepared (or InsertPreparedUnchecked) in the caller's
// transaction, or Discard.
func (s *Service) PrepareImage(ctx context.Context, wsID, uploader uuid.UUID, name, mime string, data []byte, w, h int32) (*PreparedFile, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	st := &stored{id: id, key: blob.FileKey(wsID, id), name: name, mime: mime,
		size: int64(len(data)), sha256: hex.EncodeToString(sum[:]), width: &w, height: &h}
	if err := s.store.Put(ctx, st.key, bytes.NewReader(data), st.size, mime); err != nil {
		return nil, fmt.Errorf("store %s: %w", name, err)
	}
	return &PreparedFile{st: st, workspaceID: wsID, uploader: uploader}, nil
}

// InsertPreparedUnchecked inserts the file's row and counts its bytes into the workspace usage
// without the quota check: for one-shot data migrations that must not fail on a full workspace.
func (s *Service) InsertPreparedUnchecked(ctx context.Context, q *sqlc.Queries, p *PreparedFile) (sqlc.File, error) {
	if err := q.AddWorkspaceUsage(ctx, sqlc.AddWorkspaceUsageParams{ID: p.workspaceID, Size: p.st.size}); err != nil {
		return sqlc.File{}, err
	}
	return q.InsertFile(ctx, s.row(p.st, &p.workspaceID, p.uploader))
}

// InsertPrepared reserves the file's bytes in the workspace quota (413 / 507 like an upload) and
// inserts its row, inside the caller's transaction.
func (s *Service) InsertPrepared(ctx context.Context, q *sqlc.Queries, p *PreparedFile) (sqlc.File, error) {
	if err := s.ReserveWorkspace(ctx, q, p.workspaceID, p.st.size); err != nil {
		return sqlc.File{}, err
	}
	return q.InsertFile(ctx, s.row(p.st, &p.workspaceID, p.uploader))
}

// Discard removes the blobs of a prepared file that was not inserted.
func (s *Service) Discard(p *PreparedFile) {
	if p != nil {
		s.discard(p.st)
	}
}
