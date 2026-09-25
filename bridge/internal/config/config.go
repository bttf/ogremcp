// Package config is the bridge's settings file on this device
// (docs/architecture.md §6.1, §7). It holds each kit's game folder, as the
// locate chain found it or the user picked it, the refresh interval, and the
// debounce delay of the watcher. It holds no secret: the refresh token is in
// the OS keychain (package keychain).
//
// The file is JSON, ogmcp-bridge/config.json in the user's config directory:
//
//	{
//	  "refresh_interval": "5m",
//	  "debounce": "2s",
//	  "roots": { "wow": "/Applications/World of Warcraft" }
//	}
//
// Save replaces it whole through a temporary file, so a crash leaves the old
// file or the new one.
//
// Adapted from bttf/wow-guide@df80260: bridge/internal/config (the game
// folder setting) and bridge/internal/state/state.go (DefaultPath and Save).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// DefaultRefreshInterval is how often the bridge fetches the kits and
// resolves the globs again, unless the file sets refresh_interval (§7,
// proposed).
const DefaultRefreshInterval = 5 * time.Minute

// MinRefreshInterval is the shortest refresh_interval the file may set.
const MinRefreshInterval = time.Minute

// DefaultDebounce is how long a source instance's file must go without a
// write before the watcher reports the change, unless the file sets debounce
// (§7, proposed).
const DefaultDebounce = 2 * time.Second

// File is the settings file.
type File struct {
	// RefreshInterval is how often the bridge fetches the kits and resolves
	// the globs again. Zero means DefaultRefreshInterval.
	RefreshInterval Duration `json:"refresh_interval,omitempty"`
	// Debounce is how long a source instance's file must go without a write
	// before the watcher reports the change. Zero means DefaultDebounce.
	Debounce Duration `json:"debounce,omitempty"`
	// Roots maps each kit to its game folder.
	Roots map[string]string `json:"roots,omitempty"`
}

// Interval is the refresh interval.
func (f File) Interval() time.Duration {
	if f.RefreshInterval == 0 {
		return DefaultRefreshInterval
	}
	return time.Duration(f.RefreshInterval)
}

// DebounceDelay is the debounce delay.
func (f File) DebounceDelay() time.Duration {
	if f.Debounce == 0 {
		return DefaultDebounce
	}
	return time.Duration(f.Debounce)
}

// Duration is a time.Duration written as a string, such as "5m".
type Duration time.Duration

func (d Duration) MarshalText() ([]byte, error) {
	return []byte(time.Duration(d).String()), nil
}

func (d *Duration) UnmarshalText(text []byte) error {
	v, err := time.ParseDuration(string(text))
	if err != nil {
		return fmt.Errorf("%q is not a duration such as \"5m\"", text)
	}
	*d = Duration(v)
	return nil
}

// DefaultPath is the file in the user's config directory.
func DefaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("could not find the user config directory: %w", err)
	}
	return filepath.Join(dir, "ogmcp-bridge", "config.json"), nil
}

// Load reads the file at path. A missing file gives an empty File.
func Load(path string) (File, error) {
	var f File
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	if err := json.Unmarshal(data, &f); err != nil {
		return File{}, fmt.Errorf("%s is not valid: %w", path, err)
	}
	if f.RefreshInterval != 0 && time.Duration(f.RefreshInterval) < MinRefreshInterval {
		return File{}, fmt.Errorf("%s is not valid: refresh_interval must be at least %s", path, MinRefreshInterval)
	}
	if f.Debounce < 0 {
		return File{}, fmt.Errorf("%s is not valid: debounce may not be negative", path)
	}
	return f, nil
}

// Save writes f to path: to a temporary file beside it first, flushed to
// disk, and then renamed over it.
func Save(path string, f File) error {
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(append(data, '\n'))
	var serr error
	if werr == nil {
		serr = tmp.Sync()
	}
	cerr := tmp.Close()
	if werr != nil || serr != nil || cerr != nil {
		os.Remove(tmp.Name())
		return errors.Join(werr, serr, cerr)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}
