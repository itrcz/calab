package achievements

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/gen2brain/webp"
)

// pic is a w×h PNG: transparent (or opaque white with opaque) with a red rectangle at r.
func pic(t *testing.T, w, h int, r image.Rectangle, opaque bool) []byte {
	t.Helper()
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			c := color.NRGBA{}
			if opaque {
				c = color.NRGBA{255, 255, 255, 255}
			}
			if image.Pt(x, y).In(r) {
				c = color.NRGBA{200, 20, 20, 255}
			}
			m.SetNRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, m); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestPrepareAchievement(t *testing.T) {
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 200, 200)), nil); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		data  []byte
		alpha bool // ErrNeedsAlpha
		bad   bool // *ImageError
		want  image.Rectangle
	}{
		{name: "opaque png", data: pic(t, 256, 256, image.Rect(10, 10, 100, 100), true), alpha: true},
		{name: "jpeg", data: jpg.Bytes(), bad: true},
		{name: "too small", data: pic(t, 100, 300, image.Rect(10, 10, 50, 50), false), bad: true},
		{name: "too large side", data: pic(t, 2049, 128, image.Rect(10, 10, 50, 50), false), bad: true},
		{name: "fully transparent", data: pic(t, 200, 200, image.Rectangle{}, false), bad: true},
		{name: "too many bytes", data: make([]byte, MaxImageBytes+1), bad: true},
		{name: "not an image", data: []byte("hello"), bad: true},
		// A 100x50 object in a corner is cropped and scaled up into the square: 512/(100+2*4)
		// per pixel, centred.
		{name: "bbox crop and upscale", data: pic(t, 400, 300, image.Rect(300, 250, 400, 300), false), want: FitRect(100, 50)},
		// A big square object of a 2000 px picture is scaled down.
		{name: "downscale", data: pic(t, 2000, 2000, image.Rect(0, 0, 2000, 2000).Inset(100), false), want: FitRect(1800, 1800)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := PrepareAchievement(context.Background(), tc.data)
			var ie *ImageError
			switch {
			case tc.alpha:
				if !errors.Is(err, ErrNeedsAlpha) {
					t.Fatalf("err = %v, want ErrNeedsAlpha", err)
				}
				return
			case tc.bad:
				if !errors.As(err, &ie) {
					t.Fatalf("err = %v, want *ImageError", err)
				}
				return
			case err != nil:
				t.Fatal(err)
			}
			if len(out) == 0 || len(out) > 200<<10 {
				t.Fatalf("output size %d", len(out))
			}
			img, err := webp.Decode(bytes.NewReader(out))
			if err != nil {
				t.Fatal(err)
			}
			if b := img.Bounds(); b.Dx() != ImageSide || b.Dy() != ImageSide {
				t.Fatalf("size %v", b)
			}
			box, transparent := visibleBounds(img)
			if !transparent {
				t.Fatal("alpha lost")
			}
			// Lossy edges: the visible box is the expected one within a couple of pixels.
			if d := box.Min.Sub(tc.want.Min); abs(d.X) > 3 || abs(d.Y) > 3 {
				t.Fatalf("box %v, want %v", box, tc.want)
			}
			if d := box.Max.Sub(tc.want.Max); abs(d.X) > 3 || abs(d.Y) > 3 {
				t.Fatalf("box %v, want %v", box, tc.want)
			}
			// The centre of the object keeps its colour (no darkening by premultiplied alpha).
			c := color.NRGBAModel.Convert(img.At(ImageSide/2, ImageSide/2)).(color.NRGBA)
			if c.A != 255 || c.R < 170 || c.G > 60 {
				t.Fatalf("centre colour %v", c)
			}
		})
	}
}

func TestFitRect(t *testing.T) {
	r := FitRect(100, 100) // margin 4 px of 108: the object is 474 px
	if r.Dx() != 474 || r.Dy() != 474 || r.Min.X != 19 || r.Min.Y != 19 {
		t.Fatalf("square %v", r)
	}
	r = FitRect(200, 100)
	if r.Dx() != 474 || r.Dy() != 237 || r.Min.Y != (ImageSide-237)/2 {
		t.Fatalf("wide %v", r)
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
