// Package config is the bridge's settings file on this device
// (docs/architecture.md §6.1, §7, §13.3). It holds the server, each kit's
// game folder, as the locate chain found it or the user picked it, the
// refresh interval, the debounce delay of the watcher, the upload cap, and
// how often the bridge checks for a release of itself. It holds no secret: the refresh token is in the OS keychain (package
// keychain).
//
// The file is JSON, ogremcp-bridge/config.json in the user's config directory:
//
//	{
//	  "server_url": "https://ogremcp.example.com",
//	  "refresh_interval": "5m",
//	  "debounce": "2s",
//	  "max_upload_bytes": 5242880,
//	  "update_interval": "6h",
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

	"github.com/bttf/ogremcp/bridge/internal/auth"
)

// DefaultServerURL is the server when neither OGREMCP_BASE_URL nor server_url
// names one: the hosted service (§19.1 D4).
const DefaultServerURL = "https://ogremcp.redpine.software"

// EnvServerURL is the environment variable that overrides server_url, for
// development.
const EnvServerURL = "OGREMCP_BASE_URL"

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

// DefaultMaxUploadBytes is the most uncompressed bytes the bridge uploads of
// one source instance, unless the file sets max_upload_bytes. It matches the
// server's cap (§8.3), 5 MB.
const DefaultMaxUploadBytes = 5 << 20

// DefaultUpdateInterval is how often the tray app checks for a newer release
// of the bridge, unless the file sets update_interval (§7).
const DefaultUpdateInterval = 6 * time.Hour

// MinUpdateInterval is the shortest update_interval the file may set. GitHub
// allows 60 calls an hour from one IP address without a token.
const MinUpdateInterval = time.Hour

// File is the settings file.
type File struct {
	// ServerURL is the base URL of a self-hosted server (§13.3), or "" for
	// DefaultServerURL. Server checks it.
	ServerURL string `json:"server_url,omitempty"`
	// RefreshInterval is how often the bridge fetches the kits and resolves
	// the globs again. Zero means DefaultRefreshInterval.
	RefreshInterval Duration `json:"refresh_interval,omitempty"`
	// Debounce is how long a source instance's file must go without a write
	// before the watcher reports the change. Zero means DefaultDebounce.
	Debounce Duration `json:"debounce,omitempty"`
	// MaxUploadBytes is the most uncompressed bytes the bridge uploads of one
	// source instance. Zero means DefaultMaxUploadBytes.
	MaxUploadBytes int64 `json:"max_upload_bytes,omitempty"`
	// UpdateInterval is how often the tray app checks for a newer release of
	// the bridge. Zero means DefaultUpdateInterval.
	UpdateInterval Duration `json:"update_interval,omitempty"`
	// Roots maps each kit to its game folder.
	Roots map[string]string `json:"roots,omitempty"`
}

// Server returns the server's base URL, as auth.ParseBaseURL returns it: env,
// the value of EnvServerURL, when it is not "", or else ServerURL, or else
// DefaultServerURL. A URL that auth.ParseBaseURL refuses is an error, never a
// reason to fall back to the next one.
func (f File) Server(env string) (string, error) {
	switch {
	case env != "":
		base, err := auth.ParseBaseURL(env)
		if err != nil {
			return "", fmt.Errorf("%s: %w", EnvServerURL, err)
		}
		return base, nil
	case f.ServerURL != "":
		base, err := auth.ParseBaseURL(f.ServerURL)
		if err != nil {
			return "", fmt.Errorf("server_url in the settings file: %w", err)
		}
		return base, nil
	}
	return DefaultServerURL, nil
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

// UploadCap is the upload cap, in uncompressed bytes.
func (f File) UploadCap() int64 {
	if f.MaxUploadBytes == 0 {
		return DefaultMaxUploadBytes
	}
	return f.MaxUploadBytes
}

// UpdateEvery is how often the tray app checks for a newer release.
func (f File) UpdateEvery() time.Duration {
	if f.UpdateInterval == 0 {
		return DefaultUpdateInterval
	}
	return time.Duration(f.UpdateInterval)
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
	return filepath.Join(dir, "ogremcp-bridge", "config.json"), nil
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
	if f.MaxUploadBytes < 0 {
		return File{}, fmt.Errorf("%s is not valid: max_upload_bytes may not be negative", path)
	}
	if f.UpdateInterval != 0 && time.Duration(f.UpdateInterval) < MinUpdateInterval {
		return File{}, fmt.Errorf("%s is not valid: update_interval must be at least %s", path, MinUpdateInterval)
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
