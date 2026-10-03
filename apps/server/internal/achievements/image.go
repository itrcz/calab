package achievements

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/png" // register the decoder
	"io"

	"github.com/gen2brain/webp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // register the decoder

	"github.com/calaba/calaba/server/internal/files"
)

// The picture of an achievement (ADR-0061 §2): the superadmin uploads a PNG or WebP with a
// transparent background; the server crops it to the visible part with a small margin and makes
// an ImageSide × ImageSide WebP with alpha, the object centred.
const (
	ImageSide     = 512
	MaxImageBytes = 4 << 20
	MinSourceSide = 128
	MaxSourceSide = 2048
	imageQuality  = 85
	// alphaThreshold: pixels at most this opaque are background (stray near-invisible noise of
	// exported PNGs does not widen the crop).
	alphaThreshold = 8
	marginPercent  = 4
)

// ErrNeedsAlpha means the image has no transparent pixel (no alpha channel or a fully opaque one).
var ErrNeedsAlpha = errors.New("the image must have a transparent background (an alpha channel)")

// ImageError is an upload the pipeline refuses (format, size, empty picture): a 422.
type ImageError struct{ Msg string }

func (e *ImageError) Error() string { return e.Msg }

// PrepareAchievement validates an uploaded picture and returns the final WebP (ImageSide square,
// alpha kept). Errors: ErrNeedsAlpha, *ImageError, or a context error.
func PrepareAchievement(ctx context.Context, data []byte) ([]byte, error) {
	if len(data) > MaxImageBytes {
		return nil, &ImageError{Msg: "image must be at most 4 MB"}
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "webp") {
		return nil, &ImageError{Msg: "image must be a PNG or WebP"}
	}
	if cfg.Width < MinSourceSide || cfg.Height < MinSourceSide || cfg.Width > MaxSourceSide || cfg.Height > MaxSourceSide {
		return nil, &ImageError{Msg: fmt.Sprintf("each side of the image must be %d..%d px", MinSourceSide, MaxSourceSide)}
	}
	var out []byte
	open := func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(data)), nil }
	err = files.WithDecoded(ctx, open, func(src image.Image) error {
		if o, ok := src.(interface{ Opaque() bool }); ok && o.Opaque() {
			return ErrNeedsAlpha
		}
		box, transparent := visibleBounds(src)
		if !transparent {
			return ErrNeedsAlpha
		}
		if box.Empty() {
			return &ImageError{Msg: "the image is fully transparent"}
		}
		dst := image.NewRGBA(image.Rect(0, 0, ImageSide, ImageSide))
		draw.CatmullRom.Scale(dst, FitRect(box.Dx(), box.Dy()), src, box, draw.Src, nil)
		var buf bytes.Buffer
		// The encoder takes RGBA pixels as non-premultiplied: convert, or the edges darken.
		if err := webp.Encode(&buf, unpremultiply(dst), webp.Options{Quality: imageQuality}); err != nil {
			return err
		}
		out = buf.Bytes()
		return nil
	})
	if err != nil {
		var ie *ImageError
		if errors.Is(err, ErrNeedsAlpha) || errors.As(err, &ie) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, &ImageError{Msg: "image cannot be decoded"}
	}
	return out, nil
}

// FitRect is where a w×h crop lands in the ImageSide square: the crop plus marginPercent of its
// longer side on every side is fitted into the square (scaled up or down), centred.
func FitRect(w, h int) image.Rectangle {
	side := max(w, h)
	margin := (side*marginPercent + 99) / 100
	full := side + 2*margin
	dw := max(1, (w*ImageSide+full/2)/full)
	dh := max(1, (h*ImageSide+full/2)/full)
	x, y := (ImageSide-dw)/2, (ImageSide-dh)/2
	return image.Rect(x, y, x+dw, y+dh)
}

// visibleBounds returns the bounding box of the pixels more opaque than alphaThreshold and
// whether any pixel is not fully opaque.
func visibleBounds(src image.Image) (image.Rectangle, bool) {
	b := src.Bounds()
	minX, minY, maxX, maxY := b.Max.X, b.Max.Y, b.Min.X-1, b.Min.Y-1
	transparent := false
	alpha := alphaReader(src)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			a := alpha(x, y)
			if a < 0xff {
				transparent = true
			}
			if a <= alphaThreshold {
				continue
			}
			minX, maxX = min(minX, x), max(maxX, x)
			minY, maxY = min(minY, y), max(maxY, y)
		}
	}
	if maxX < minX {
		return image.Rectangle{}, transparent
	}
	return image.Rect(minX, minY, maxX+1, maxY+1), transparent
}

// alphaReader returns the 8-bit alpha of a pixel, with fast paths for the decoders' types.
func alphaReader(src image.Image) func(x, y int) uint8 {
	switch m := src.(type) {
	case *image.NRGBA:
		return func(x, y int) uint8 { return m.Pix[m.PixOffset(x, y)+3] }
	case *image.RGBA:
		return func(x, y int) uint8 { return m.Pix[m.PixOffset(x, y)+3] }
	case *image.NYCbCrA:
		return func(x, y int) uint8 { return m.A[m.AOffset(x, y)] }
	}
	return func(x, y int) uint8 {
		_, _, _, a := src.At(x, y).RGBA()
		return uint8(a >> 8) //nolint:gosec // 16-bit alpha to 8 bits
	}
}

// unpremultiply converts premultiplied RGBA pixels to NRGBA.
func unpremultiply(m *image.RGBA) *image.NRGBA {
	out := image.NewNRGBA(m.Bounds())
	for i := 0; i+3 < len(m.Pix); i += 4 {
		a := m.Pix[i+3]
		out.Pix[i+3] = a
		if a == 0 {
			continue
		}
		for c := range 3 {
			out.Pix[i+c] = uint8((uint32(m.Pix[i+c])*0xff + uint32(a)/2) / uint32(a)) //nolint:gosec // <= 255: premultiplied
		}
	}
	return out
}
