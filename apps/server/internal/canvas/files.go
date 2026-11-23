package canvas

import (
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
	"github.com/calaba/calaba/server/internal/perm"
)

// errNotPicture refuses an upload to a canvas that is not a picture the board draws.
var errNotPicture = httpx.Validation("file", "must be a PNG, JPEG, GIF or WebP picture")

// upload stores a picture pasted or dropped on a canvas (POST /api/canvas/items/{id}/files,
// ADR-0127 addendum 2026-11-23): CANVAS_WRITE on a live canvas, the workspace's quota and upload
// limits (files.UploadWith), a picture only. The file belongs to the canvas (canvas_item_files):
// whoever has CANVAS_VIEW on it reads it (files.CanRead).
func (s *Service) upload(w http.ResponseWriter, r *http.Request) error {
	if s.Files == nil {
		return httpx.NotFound("route")
	}
	a, err := s.pathItem(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if a.item.Kind != kindCanvas {
		return httpx.Conflict("only a canvas holds pictures")
	}
	if err := writable(ctx, s.db.Q, a.item.WorkspaceID); err != nil {
		return err
	}
	if a.item.TrashedAt != nil {
		return errTrashed
	}
	if !a.bits.Has(perm.CanvasWrite) {
		return errNoWrite
	}
	f, err := s.Files.UploadWith(w, r, a.item.WorkspaceID, func(q *sqlc.Queries, f sqlc.File) error {
		if !pbconv.IsImage(f.Mime) {
			return errNotPicture
		}
		// Re-read under the row lock: the canvas may have gone to the trash during the upload.
		cur, err := q.GetCanvasItemForUpdate(ctx, a.item.ID)
		if db.IsNotFound(err) {
			return errNoItem
		}
		if err != nil {
			return err
		}
		if cur.TrashedAt != nil {
			return errTrashed
		}
		return q.AddCanvasItemFile(ctx, sqlc.AddCanvasItemFileParams{ItemID: cur.ID, FileID: f.ID})
	})
	if err != nil {
		return err
	}
	httpx.Write(w, http.StatusCreated, &v1.UploadFileResponse{File: pbconv.File(f)})
	return nil
}
