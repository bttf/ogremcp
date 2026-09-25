package tray

import (
	"fmt"
	"log/slog"
	"os"
	"runtime/debug"
)

// Recover, deferred at the top of a goroutine, writes a panic to the log and
// ends the process with status 1. Without it the panic would go to standard
// error, which a tray app started at login does not keep. The -trimpath
// build keeps the builder's home directory out of the stack.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/tray/recover.go,
// without its path scrubbing (package safelog): the log stays on this device.
func Recover(log *slog.Logger) {
	r := recover()
	if r == nil {
		return
	}
	log.Error("crashed", "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
	os.Exit(1)
}
