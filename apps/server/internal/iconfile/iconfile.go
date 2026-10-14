// Package iconfile checks the picture of a workspace object (a web app icon, a room picture,
// ADR-0050, ADR-0092): who may make which uploaded file one.
package iconfile

import (
	"context"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/pbconv"
)

// MaxBytes caps a picture: clients crop it to a small square (AvatarPicker), so a bigger
// file is not one.
const MaxBytes = 5 << 20

// Own checks raw as the picture of an object of workspace wsID: an image the caller uploaded
// to that workspace (or the object's current picture, cur), at most MaxBytes, not a sticker's
// file. Such a picture becomes readable to a wider audience (files.CanRead), so someone else's
// file — e.g. an attachment of a restricted room — must not become one. "" = none (nil).
// Rejections are 422 on the field iconFileId.
func Own(ctx context.Context, q *sqlc.Queries, wsID, caller uuid.UUID, cur *uuid.UUID, raw string) (*uuid.UUID, error) {
	if raw == "" {
		return nil, nil
	}
	bad := httpx.Validation("iconFileId", "an image you uploaded to this workspace is required")
	id, err := uuid.Parse(raw)
	if err != nil {
		return nil, bad
	}
	if cur != nil && *cur == id {
		return &id, nil
	}
	f, err := q.GetFile(ctx, id)
	if db.IsNotFound(err) {
		return nil, bad
	}
	if err != nil {
		return nil, err
	}
	if f.WorkspaceID == nil || *f.WorkspaceID != wsID || f.UploaderID != caller || !pbconv.IsImage(f.Mime) || f.Size > MaxBytes {
		return nil, bad
	}
	if _, err := q.GetStickerFileWorkspace(ctx, id); err == nil {
		return nil, bad
	} else if !db.IsNotFound(err) {
		return nil, err
	}
	return &id, nil
}
