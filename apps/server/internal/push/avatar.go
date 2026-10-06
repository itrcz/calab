package push

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/jpeg"
	"io"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/files"
	"golang.org/x/image/draw"
)

const maxAvatarBytes = 1536

// Avatars reuses private upload thumbnails. It never fetches user-controlled URLs.
// A busy/cold/failed cache is optional presentation, not a reason to delay a call.
type Avatars struct {
	store blob.Store
	mu    sync.Mutex
	cache map[string]string
}

// NewAvatars creates a bounded, best-effort cache backed by the existing private store.
func NewAvatars(store blob.Store) *Avatars {
	return &Avatars{store: store, cache: make(map[string]string)}
}

func (a *Avatars) picture(ctx context.Context, f sqlc.File) string {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Millisecond)
	defer cancel()
	return a.pictureWithinBudget(ctx, f)
}

// Separate the caller's latency budget from deterministic image/cache behavior.
func (a *Avatars) pictureWithinBudget(ctx context.Context, f sqlc.File) string {
	if a == nil || a.store == nil || f.ThumbnailKey == nil || !a.mu.TryLock() {
		return ""
	}
	defer a.mu.Unlock()
	key := f.ID.String() + ":" + f.Sha256
	if value, ok := a.cache[key]; ok {
		return value
	}
	r, meta, err := a.store.Get(ctx, *f.ThumbnailKey)
	if err != nil {
		return ""
	}
	defer func() { _ = r.Close() }()
	if meta.Size <= 0 || meta.Size > 512<<10 {
		return ""
	}
	raw, err := io.ReadAll(io.LimitReader(r, (512<<10)+1))
	if err != nil || len(raw) > 512<<10 || ctx.Err() != nil {
		return ""
	}
	cfg, err := files.ImageConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 512 || cfg.Height > 512 {
		return ""
	}
	var encoded string
	err = files.WithDecoded(ctx, func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(raw)), nil }, func(src image.Image) error {
		w, h := files.FitSize(src.Bounds().Dx(), src.Bounds().Dy(), 64)
		dst := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
		for _, quality := range []int{65, 40, 20} {
			var out bytes.Buffer
			if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: quality}); err != nil {
				return err
			}
			if out.Len() <= maxAvatarBytes {
				encoded = base64.StdEncoding.EncodeToString(out.Bytes())
				break
			}
		}
		return nil
	})
	if err != nil || encoded == "" || ctx.Err() != nil {
		return ""
	}
	if len(a.cache) >= 128 {
		for old := range a.cache {
			delete(a.cache, old)
			break
		}
	}
	a.cache[key] = encoded
	return encoded
}

func (s *Service) avatar(ctx context.Context, q *sqlc.Queries, author sqlc.User) string {
	if s.Avatars == nil || author.AvatarFileID == nil {
		return ""
	}
	f, err := q.GetFile(ctx, *author.AvatarFileID)
	// Only the current user-scoped avatar, never an arbitrary message attachment.
	if err != nil || f.WorkspaceID != nil {
		return ""
	}
	return s.Avatars.picture(ctx, f)
}
