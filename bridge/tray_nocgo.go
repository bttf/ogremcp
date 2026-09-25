//go:build darwin && !cgo

package main

import (
	"fmt"
	"os"
)

// runTray needs cgo on macOS: the menu bar icon is drawn through AppKit. This
// file keeps the package building with cgo off, as for a cross-compile.
// .goreleaser.yaml builds the app with cgo on.
//
// Adapted from bttf/wow-guide@df80260, bridge/cmd/tray/stub.go.
func runTray() int {
	fmt.Fprintln(os.Stderr, "bridge: this build has no tray app; on macOS, build it with CGO_ENABLED=1")
	return 2
}
