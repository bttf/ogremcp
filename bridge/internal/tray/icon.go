package tray

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"math"
)

// Icon returns the tray icon as a PNG: a ring, filled with a dot while the
// bridge is logged in. It is black on transparent, which macOS draws as a
// template image in the menu bar's colour. size is the edge in pixels.
//
// Icon and ICO are copied from bttf/wow-guide@df80260,
// bridge/internal/tray/icon.go.
func Icon(active bool, size int) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	c := float64(size) / 2
	outer := c - 1
	inner := outer * 0.62
	dot := outer * 0.38
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			// Coverage by 4x4 supersampling, for smooth edges.
			hits := 0
			for sy := 0; sy < 4; sy++ {
				for sx := 0; sx < 4; sx++ {
					dx := float64(x) + (float64(sx)+0.5)/4 - c
					dy := float64(y) + (float64(sy)+0.5)/4 - c
					r := math.Hypot(dx, dy)
					if (r <= outer && r >= inner) || (active && r <= dot) {
						hits++
					}
				}
			}
			if hits > 0 {
				img.SetNRGBA(x, y, color.NRGBA{A: uint8(hits * 255 / 16)})
			}
		}
	}
	var b bytes.Buffer
	// Encoding an in-memory image to a buffer does not fail.
	_ = png.Encode(&b, img)
	return b.Bytes()
}

// ICO wraps a PNG of edge size (at most 256) in an .ico file, which the
// Windows tray needs. Windows Vista and later read PNG images in .ico files.
func ICO(pngData []byte, size int) []byte {
	var b bytes.Buffer
	edge := byte(size)
	if size >= 256 {
		edge = 0
	}
	le := binary.LittleEndian
	// ICONDIR: reserved, type 1 (icon), one image.
	binary.Write(&b, le, [3]uint16{0, 1, 1})
	// ICONDIRENTRY: width, height, colours, reserved, planes, bits per
	// pixel, size of the data, offset of the data.
	b.Write([]byte{edge, edge, 0, 0})
	binary.Write(&b, le, [2]uint16{1, 32})
	binary.Write(&b, le, [2]uint32{uint32(len(pngData)), 6 + 16})
	b.Write(pngData)
	return b.Bytes()
}
