package browser

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// This file keeps the gap arithmetic honest without a browser. The two passes are
// the whole content of the "fixed script" strategy's decision, so they get their own
// fixtures instead of being exercised only through a fake CDP service.

// encodePNG renders an NRGBA image to bytes.
func encodePNG(t *testing.T, img *image.NRGBA) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

// deterministicNoise fills an image with per-pixel pseudo-random values.
//
// Per-pixel (rather than per-block) values are what make the template pass have one
// unambiguous answer: any horizontal shift changes every pixel, so a shifted window
// scores far worse than the true location.
func deterministicNoise(width, height int, seed uint32) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	state := seed
	next := func() uint8 {
		state = state*1664525 + 1013904223
		return uint8(60 + (state>>16)%196)
	}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: next(), G: next(), B: next(), A: 255})
		}
	}
	return img
}

func cloneNRGBA(src *image.NRGBA) *image.NRGBA {
	dst := image.NewNRGBA(src.Bounds())
	copy(dst.Pix, src.Pix)
	return dst
}

// notchFixture builds a full background, the same background with a shaded notch at
// notchX, and a slice canvas carrying the piece cut from the full background.
func notchFixture(t *testing.T, width, height, notchX, notchY, pieceW, pieceH int) (full, gap, slice []byte) {
	t.Helper()
	fullImg := deterministicNoise(width, height, 20261014)
	gapImg := cloneNRGBA(fullImg)
	sliceImg := image.NewNRGBA(image.Rect(0, 0, width, height))

	for y := notchY; y < notchY+pieceH; y++ {
		for x := notchX; x < notchX+pieceW; x++ {
			original := fullImg.NRGBAAt(x, y)
			// The notch is the same content, shaded. That is what makes the piece's
			// best match inside the notched background the notch itself.
			gapImg.SetNRGBA(x, y, color.NRGBA{
				R: original.R - 40, G: original.G - 40, B: original.B - 40, A: 255,
			})
			// The slice canvas carries only the piece, at its own resting position.
			sliceImg.SetNRGBA(8+(x-notchX), y, color.NRGBA{
				R: original.R, G: original.G, B: original.B, A: 255,
			})
		}
	}
	return encodePNG(t, fullImg), encodePNG(t, gapImg), encodePNG(t, sliceImg)
}

func TestGapOffsetByDiffFindsTheNotchBand(t *testing.T) {
	full, gap, _ := notchFixture(t, 260, 120, 140, 20, 30, 40)
	offset, err := GapOffsetByDiff(full, gap)
	if err != nil {
		t.Fatalf("GapOffsetByDiff error = %v, want nil", err)
	}
	if offset != 140 {
		t.Fatalf("GapOffsetByDiff = %d, want 140 (the first column of the notch band)", offset)
	}
}

func TestGapOffsetByDiffRejectsIdenticalImages(t *testing.T) {
	full, _, _ := notchFixture(t, 200, 80, 120, 20, 30, 40)
	if _, err := GapOffsetByDiff(full, full); !errors.Is(err, ErrNoGap) {
		t.Fatalf("GapOffsetByDiff(identical) error = %v, want ErrNoGap", err)
	}
}

func TestGapOffsetByDiffRejectsUndecodableBytes(t *testing.T) {
	_, gap, _ := notchFixture(t, 200, 80, 120, 20, 30, 40)
	if _, err := GapOffsetByDiff([]byte("not a png"), gap); err == nil {
		t.Fatal("GapOffsetByDiff(garbage) error = nil, want a decode failure")
	}
}

func TestGapOffsetByTemplateFindsThePiece(t *testing.T) {
	_, gap, slice := notchFixture(t, 260, 120, 140, 20, 30, 40)
	offset, err := GapOffsetByTemplate(gap, slice)
	if err != nil {
		t.Fatalf("GapOffsetByTemplate error = %v, want nil", err)
	}
	if offset != 140 {
		t.Fatalf("GapOffsetByTemplate = %d, want 140", offset)
	}
}

func TestGapOffsetByTemplateRejectsEmptySlice(t *testing.T) {
	_, gap, _ := notchFixture(t, 200, 80, 120, 20, 30, 40)
	empty := image.NewNRGBA(image.Rect(0, 0, 200, 80))
	if _, err := GapOffsetByTemplate(gap, encodePNG(t, empty)); !errors.Is(err, ErrNoGap) {
		t.Fatalf("GapOffsetByTemplate(empty) error = %v, want ErrNoGap", err)
	}
}

func TestCSSOffsetScalesIntrinsicPixelsIntoCSSPixels(t *testing.T) {
	// A 280px-wide canvas rendered at 140 CSS px: the offset must halve. The archived
	// solver never needed this because it forced deviceScaleFactor=1.
	offset, err := CSSOffset(140, 280, 140)
	if err != nil {
		t.Fatalf("CSSOffset error = %v, want nil", err)
	}
	if offset != 70 {
		t.Fatalf("CSSOffset = %d, want 70", offset)
	}
	if _, err := CSSOffset(10, 0, 100); err == nil {
		t.Fatal("CSSOffset(intrinsicWidth=0) error = nil, want a failure")
	}
	if _, err := CSSOffset(10, 100, 0); err == nil {
		t.Fatal("CSSOffset(cssWidth=0) error = nil, want a failure")
	}
}

func TestIntrinsicLeftReadsThePiecesRestingColumn(t *testing.T) {
	_, _, slice := notchFixture(t, 260, 120, 140, 20, 30, 40)
	left, err := intrinsicLeft(slice)
	if err != nil {
		t.Fatalf("intrinsicLeft error = %v, want nil", err)
	}
	if left != 8 {
		t.Fatalf("intrinsicLeft = %d, want 8 (the piece's resting column)", left)
	}
}
