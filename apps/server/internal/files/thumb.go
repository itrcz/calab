package files

import (
	"bytes"
	"context"
	"errors"
	"image"
	_ "image/gif" // register decoders
	_ "image/jpeg"
	_ "image/png"
	"io"

	"github.com/gen2brain/webp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register decoder
)

// Thumbnail limits: the longer side is scaled to ThumbMaxSide (made at upload) or
// ThumbLargeSide (lazily, for 2× displays); images above MaxPixels are not decoded at all
// (decompression bombs, memory budget: a 24 MP RGBA image is ~96 MiB).
const (
	ThumbMaxSide      = 512
	ThumbLargeSide    = 1024
	MaxPixels         = 24_000_000
	thumbQuality      = 80
	thumbLargeQuality = 85
)

// ErrTooManyPixels means the image is too large to thumbnail.
var ErrTooManyPixels = errors.New("files: image too large to thumbnail")

// One decode at a time bounds peak memory; thumbnails are small and fast otherwise.
var thumbSlot = make(chan struct{}, 1)

// ImageConfig reads only the header (cheap) and returns dimensions.
func ImageConfig(r io.Reader) (image.Config, error) {
	cfg, _, err := image.DecodeConfig(r)
	return cfg, err
}

// Thumbnail decodes an image (first frame for GIF), scales it so that the longer side is at
// most ThumbMaxSide (never upscales) and encodes it as lossy WebP.
func Thumbnail(ctx context.Context, open func() (io.ReadCloser, error)) ([]byte, error) {
	return thumbnail(ctx, open, ThumbMaxSide, thumbQuality)
}

// LargeThumbnail is Thumbnail for ThumbLargeSide at a higher quality. An image smaller than
// that keeps its own size (re-encoded as WebP, never upscaled).
func LargeThumbnail(ctx context.Context, open func() (io.ReadCloser, error)) ([]byte, error) {
	return thumbnail(ctx, open, ThumbLargeSide, thumbLargeQuality)
}

func thumbnail(ctx context.Context, open func() (io.ReadCloser, error), side, quality int) ([]byte, error) {
	var out []byte
	err := withDecoded(ctx, open, func(src image.Image) error {
		w, h := FitSize(src.Bounds().Dx(), src.Bounds().Dy(), side)
		dst := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
		var buf bytes.Buffer
		if err := webp.Encode(&buf, dst, webp.Options{Quality: quality}); err != nil {
			return err
		}
		out = buf.Bytes()
		return nil
	})
	return out, err
}

// WithDecoded is withDecoded for server-made pictures of other packages (achievements,
// ADR-0061): they share the decode slot and its memory budget.
func WithDecoded(ctx context.Context, open func() (io.ReadCloser, error), fn func(image.Image) error) error {
	return withDecoded(ctx, open, fn)
}

// withDecoded checks the header (at most MaxPixels), then decodes the image in the single decode
// slot and runs fn with it (still in the slot: the scaled copies count in the memory budget).
func withDecoded(ctx context.Context, open func() (io.ReadCloser, error), fn func(image.Image) error) error {
	rc, err := open()
	if err != nil {
		return err
	}
	cfg, _, err := image.DecodeConfig(rc)
	_ = rc.Close()
	if err != nil {
		return err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > MaxPixels {
		return ErrTooManyPixels
	}
	select {
	case thumbSlot <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-thumbSlot }()

	rc, err = open()
	if err != nil {
		return err
	}
	src, _, err := image.Decode(rc)
	_ = rc.Close()
	if err != nil {
		return err
	}
	return fn(src)
}

// ThumbSize fits w×h into ThumbMaxSide×ThumbMaxSide keeping the aspect ratio.
func ThumbSize(w, h int) (int, int) { return FitSize(w, h, ThumbMaxSide) }

// FitSize fits w×h into side×side keeping the aspect ratio; it never upscales.
func FitSize(w, h, side int) (int, int) {
	if w <= side && h <= side {
		return w, h
	}
	if w >= h {
		return side, max(1, h*side/w)
	}
	return max(1, w*side/h), side
}

// ThumbWidth parses the ?w= of GET /api/files/{id}/thumbnail: absent means ThumbMaxSide
// (older clients), otherwise exactly ThumbMaxSide or ThumbLargeSide.
func ThumbWidth(q string) (int, bool) {
	switch q {
	case "", "512":
		return ThumbMaxSide, true
	case "1024":
		return ThumbLargeSide, true
	}
	return 0, false
}
