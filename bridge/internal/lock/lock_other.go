//go:build !(darwin || linux || freebsd || netbsd || openbsd || dragonfly || windows)

package lock

import "os"

// lockFile does nothing on systems the bridge is not released for.
func lockFile(*os.File) error { return nil }

func unlockFile(*os.File) error { return nil }
