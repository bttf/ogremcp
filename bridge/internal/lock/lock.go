// Package lock keeps a second bridge process of the same OS user from
// running (docs/architecture.md §7). Every bridge process of a user shares
// one keychain entry per server. When one refreshes the login, the refresh
// token the other holds is replaced, and the server revokes the whole grant
// when that one is sent (§8.1). So the tray app and each bridge command hold
// the lock while they run.
//
// The lock is on a file in the user's config directory. The OS releases it
// when the process ends, so a crash leaves no stale lock. The file stays on
// disk; only the lock on it matters.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/state (lock.go,
// lock_unix.go, lock_windows.go, lock_other.go). The prototype locked its
// state file; this locks a file of its own.
package lock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ErrLocked means another process holds the lock.
var ErrLocked = errors.New("another Open Gamer MCP bridge is running for this user")

// Lock is held while a bridge runs.
type Lock struct {
	f *os.File
}

// DefaultPath is the lock file in the user's config directory, beside the
// settings file (package config).
func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("could not find the user config directory: %w", err)
	}
	return filepath.Join(dir, "ogmcp-bridge", "bridge.lock"), nil
}

// Acquire takes the lock on the file at path without waiting. It returns
// ErrLocked when another process, or another Lock in this process, holds it.
func Acquire(path string) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release gives the lock up.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	uerr := unlockFile(l.f)
	cerr := l.f.Close()
	l.f = nil
	return errors.Join(uerr, cerr)
}
