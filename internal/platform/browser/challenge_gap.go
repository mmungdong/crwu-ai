package browser

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
)

// This file locates a Geetest v3 slider gap from the challenge canvases.
//
// It exists so that "try to recover a visible challenge" does not depend on the
// archive's throwaway helper environment. The reference implementation
// (`gap_detect.py`, session archive event 367) used numpy + PIL and hard-coded an
// interpreter path; neither is a dependency this repository ships. The algorithm is
// the same two passes, reimplemented against the standard library so the capability
// is really inside the binary that ships:
//
//  1. full-background vs. background: the pixels that differ *are* the notch;
//  2. background vs. slice: template-match the piece inside the background.
//
// Everything here is pure: no I/O, no CDP, no page access. That is what makes the
// arithmetic testable against fixture images without a browser.

// ErrNoGap means the images decoded but no plausible notch was found.
var ErrNoGap = errors.New("没有在图像里定位到缺口")

// Threshold on the per-pixel channel difference used by the diff pass. Chosen to
// ignore JPEG-ish background noise while still catching the notch's edge. It is a
// technical constant of this algorithm, not a business threshold.
const gapPixelThreshold = 42

// Column-level rules for the diff pass.
const (
	// The notch never touches the left border; the left 6% is the piece's rest
	// position and is ignored.
	gapLeftIgnoreFraction = 0.06
	// A column counts as "in the gap" only if this many of its pixels differ.
	gapMinColumnHits = 5
	// ...and only if it differs this much relative to the strongest column.
	gapRelativeThreshold = 0.25
	// A run this long is a notch band rather than a stray column.
	gapMinBandWidth = 3
)

// decodePNG decodes bytes into a straight-alpha NRGBA image.
//
// Straight alpha matters for the template pass: the slice canvas encodes "this pixel
// belongs to the piece" in its alpha channel, and premultiplied reads would smear
// that mask with the piece's own colour.
func decodePNG(data []byte) (*image.NRGBA, error) {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("解码 PNG 失败：%w", err)
	}
	bounds := img.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return nil, errors.New("图像尺寸为空")
	}
	dst := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(dst, dst.Bounds(), img, bounds.Min, draw.Src)
	return dst, nil
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// GapOffsetByDiff finds the notch by comparing the full background with the
// background that has the notch in it.
//
// Both images must come from the same widget, so they share a size; when they do not
// the smaller extent is used rather than failing, because a one-pixel rounding
// difference is not a reason to give up on the challenge.
func GapOffsetByDiff(fullPNG, gapPNG []byte) (int, error) {
	full, err := decodePNG(fullPNG)
	if err != nil {
		return 0, err
	}
	gap, err := decodePNG(gapPNG)
	if err != nil {
		return 0, err
	}
	return gapOffsetByDiff(full, gap)
}

func gapOffsetByDiff(full, gap *image.NRGBA) (int, error) {
	width := minInt(full.Bounds().Dx(), gap.Bounds().Dx())
	height := minInt(full.Bounds().Dy(), gap.Bounds().Dy())
	if width <= 0 || height <= 0 {
		return 0, errors.New("两张画布没有可比对的像素")
	}

	columns := make([]int, width)
	peak := 0
	for x := 0; x < width; x++ {
		hits := 0
		for y := 0; y < height; y++ {
			f := full.NRGBAAt(x, y)
			g := gap.NRGBAAt(x, y)
			delta := absInt(int(f.R)-int(g.R)) + absInt(int(f.G)-int(g.G)) + absInt(int(f.B)-int(g.B))
			if delta > gapPixelThreshold {
				hits++
			}
		}
		columns[x] = hits
		if hits > peak {
			peak = hits
		}
	}
	if peak < gapMinColumnHits {
		return 0, ErrNoGap
	}

	threshold := int(math.Max(gapMinColumnHits-2, float64(peak)*gapRelativeThreshold))
	start := int(math.Floor(float64(width) * gapLeftIgnoreFraction))
	if start >= width {
		start = 0
	}

	// Prefer the first contiguous band: a stray column on the right (a price tag
	// drawn over the image, say) must not win over the real notch on the left.
	bandStart := -1
	bandLength := 0
	fallback := -1
	for x := start; x < width; x++ {
		if columns[x] > threshold {
			if fallback < 0 {
				fallback = x
			}
			if bandStart < 0 {
				bandStart = x
			}
			bandLength++
			if bandLength >= gapMinBandWidth {
				return bandStart, nil
			}
			continue
		}
		bandStart = -1
		bandLength = 0
	}
	if fallback >= 0 {
		return fallback, nil
	}
	return 0, ErrNoGap
}

// Template rules for the slice-matching pass.
const (
	// Alpha above this marks a pixel as part of the piece.
	sliceAlphaThreshold = 200
	// Fewer opaque pixels than this is not a piece.
	sliceMinOpaquePixels = 50
	// The piece never sits at the very left of the background.
	templateLeftIgnoreFraction = 0.08
)

// GapOffsetByTemplate finds the notch by locating the slice piece inside the
// background. It is the fallback for deployments that never render the
// full-background canvas.
func GapOffsetByTemplate(bgPNG, slicePNG []byte) (int, error) {
	bg, err := decodePNG(bgPNG)
	if err != nil {
		return 0, err
	}
	slice, err := decodePNG(slicePNG)
	if err != nil {
		return 0, err
	}
	return gapOffsetByTemplate(bg, slice)
}

func gapOffsetByTemplate(bg, slice *image.NRGBA) (int, error) {
	width := minInt(bg.Bounds().Dx(), slice.Bounds().Dx())
	height := minInt(bg.Bounds().Dy(), slice.Bounds().Dy())
	if width <= 0 || height <= 0 {
		return 0, errors.New("背景与滑块没有可比对的像素")
	}

	// Bounding box of the piece inside the slice canvas.
	minX, minY := width, height
	maxX, maxY := -1, -1
	opaque := 0
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			if slice.NRGBAAt(x, y).A <= sliceAlphaThreshold {
				continue
			}
			opaque++
			if x < minX {
				minX = x
			}
			if x > maxX {
				maxX = x
			}
			if y < minY {
				minY = y
			}
			if y > maxY {
				maxY = y
			}
		}
	}
	if opaque < sliceMinOpaquePixels || maxX < minX || maxY < minY {
		return 0, ErrNoGap
	}
	pieceWidth := maxX - minX + 1
	pieceHeight := maxY - minY + 1

	start := int(math.Floor(float64(width) * templateLeftIgnoreFraction))
	if start < 0 {
		start = 0
	}
	last := width - pieceWidth
	if last < start {
		return 0, ErrNoGap
	}

	bestScore := math.Inf(1)
	bestX := -1
	for x := start; x <= last; x++ {
		if minY+pieceHeight > height {
			break
		}
		total := 0
		for dy := 0; dy < pieceHeight; dy++ {
			for dx := 0; dx < pieceWidth; dx++ {
				b := bg.NRGBAAt(x+dx, minY+dy)
				p := slice.NRGBAAt(minX+dx, minY+dy)
				total += absInt(int(b.R)-int(p.R)) + absInt(int(b.G)-int(p.G)) + absInt(int(b.B)-int(p.B))
			}
		}
		score := float64(total) / float64(pieceWidth*pieceHeight)
		if score < bestScore {
			bestScore = score
			bestX = x
		}
	}
	if bestX < 0 {
		return 0, ErrNoGap
	}
	return bestX, nil
}

// CSSOffset converts an offset measured in the canvas's intrinsic pixels into the
// CSS pixels that Input.dispatchMouseEvent expects.
//
// This is the correction the archived solver never needed by luck: it ran with
// `Emulation.setDeviceMetricsOverride{deviceScaleFactor:1}`, so intrinsic and CSS
// pixels coincided. A caller that inherits the employee's real window cannot assume
// that, and getting it wrong drags the slider to the wrong place.
func CSSOffset(intrinsicOffset, intrinsicWidth int, cssWidth float64) (int, error) {
	if intrinsicWidth <= 0 || cssWidth <= 0 {
		return 0, errors.New("画布尺寸不可用：无法把本征像素换算成 CSS 像素")
	}
	return int(math.Round(float64(intrinsicOffset) * (cssWidth / float64(intrinsicWidth)))), nil
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
