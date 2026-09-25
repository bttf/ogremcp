// Package logfile is the tray app's log: a file that is rotated by size, on
// this machine only. Nothing in it is sent anywhere. A tray app has no
// terminal, and a Windows release build has no console window (-H
// windowsgui), so the log goes here.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/logfile, with the
// folder and file names changed to Open Gamer MCP's.
package logfile

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
)

// Defaults of the tray app: about 4 MB of log at most.
const (
	DefaultMaxBytes = 1 << 20
	DefaultKeep     = 3
)

// DefaultPath is where the tray app keeps its log:
//
//	macOS    ~/Library/Logs/ogmcp-bridge/bridge.log
//	Windows  %LocalAppData%\ogmcp-bridge\logs\bridge.log
//	other    <user config dir>/ogmcp-bridge/logs/bridge.log
func DefaultPath() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("finding the home directory: %w", err)
		}
		return filepath.Join(home, "Library", "Logs", "ogmcp-bridge", "bridge.log"), nil
	case "windows":
		// UserCacheDir is %LocalAppData% on Windows.
		dir, err := os.UserCacheDir()
		if err != nil {
			return "", fmt.Errorf("finding the local app data directory: %w", err)
		}
		return filepath.Join(dir, "ogmcp-bridge", "logs", "bridge.log"), nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("finding the user config directory: %w", err)
	}
	return filepath.Join(dir, "ogmcp-bridge", "logs", "bridge.log"), nil
}

// File is a log file that is rotated before a write would take it past
// MaxBytes: bridge.log becomes bridge.log.1, bridge.log.1 becomes bridge.log.2, and
// so on up to Keep old files. It is safe for concurrent use.
type File struct {
	path     string
	maxBytes int64
	keep     int

	mu   sync.Mutex
	f    *os.File
	size int64
}

// Open opens or creates the log at path, readable by the OS user alone, and
// appends to it.
func Open(path string, maxBytes int64, keep int) (*File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	l := &File{path: path, maxBytes: maxBytes, keep: keep}
	if err := l.open(); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *File) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.f, l.size = f, info.Size()
	return nil
}

// Write appends p, rotating first when p would not fit. A single write larger
// than MaxBytes goes into a file of its own.
func (l *File) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return 0, os.ErrClosed
	}
	if l.size > 0 && l.size+int64(len(p)) > l.maxBytes {
		if err := l.rotate(); err != nil {
			// Keep logging to the file there is rather than losing lines.
			if l.f == nil {
				return 0, err
			}
		}
	}
	n, err := l.f.Write(p)
	l.size += int64(n)
	return n, err
}

func (l *File) rotate() error {
	l.f.Close()
	l.f = nil
	for i := l.keep - 1; i >= 1; i-- {
		os.Rename(l.path+"."+strconv.Itoa(i), l.path+"."+strconv.Itoa(i+1))
	}
	var renameErr error
	if l.keep > 0 {
		renameErr = os.Rename(l.path, l.path+".1")
	} else {
		renameErr = os.Remove(l.path)
	}
	if err := l.open(); err != nil {
		return err
	}
	if renameErr != nil {
		return renameErr
	}
	return nil
}

// Close closes the file. Writes after it fail.
func (l *File) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}
