// Package autostart starts the tray app when the user logs in
// (docs/architecture.md §7): a LaunchAgent on macOS, a value under the Run key
// of HKEY_CURRENT_USER on Windows.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/autostart, with the
// names changed to Open Gamer MCP's.
package autostart

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Label names the LaunchAgent. It is the app's CFBundleIdentifier
// (macos/Info.plist).
const Label = "software.redpine.ogmcp"

// RunValueName is the name of the value under the Run key.
const RunValueName = "OpenGamerMCP"

// ErrUnsupported is returned by New on a system without a login item here.
var ErrUnsupported = errors.New("start at login is not supported on this system")

// ErrTranslocated is returned by New on macOS for an app that runs from a
// random read-only copy (App Translocation): an app opened from Downloads or
// a disk image without being moved. A login item would point at a path that
// is gone after the next restart.
var ErrTranslocated = errors.New("the app runs from a temporary copy; move it to Applications to start at login")

// Translocated reports whether path is inside a translocated app.
func Translocated(path string) bool {
	return strings.Contains(path, "/AppTranslocation/")
}

// Manager turns starting at login on and off.
type Manager interface {
	Enabled() (bool, error)
	Set(on bool) error
}

// LaunchAgentPlist is the property list of a LaunchAgent that runs args at
// login. The agent runs once per login in the user's graphical session and
// is not restarted when it quits. The tray app writes its own log; launchd
// sends standard error to stderrPath, unless it is "", so that a crash the
// app cannot log still leaves its reason.
func LaunchAgentPlist(label string, args []string, stderrPath string) []byte {
	var b bytes.Buffer
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>`)
	escape(&b, label)
	b.WriteString("</string>\n\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, a := range args {
		b.WriteString("\t\t<string>")
		escape(&b, a)
		b.WriteString("</string>\n")
	}
	b.WriteString(`	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
`)
	if stderrPath != "" {
		b.WriteString("\t<key>StandardErrorPath</key>\n\t<string>")
		escape(&b, stderrPath)
		b.WriteString("</string>\n")
	}
	b.WriteString("</dict>\n</plist>\n")
	return b.Bytes()
}

func escape(b *bytes.Buffer, s string) {
	// EscapeText writes to a bytes.Buffer without error.
	_ = xml.EscapeText(b, []byte(s))
}

// RunValue is the command line the Run key holds for args, quoted the way
// Windows programs split their command line.
func RunValue(args []string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = quoteArg(a)
	}
	return strings.Join(quoted, " ")
}

// quoteArg quotes one argument by the rules of CommandLineToArgvW: quotes
// around it when it holds a space, a tab, or a quote, or is empty; a
// backslash doubled when a quote follows it.
func quoteArg(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\"") {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '\\':
			slashes++
		case '"':
			b.WriteString(strings.Repeat(`\`, 2*slashes+1))
			b.WriteByte('"')
			slashes = 0
			continue
		default:
			b.WriteString(strings.Repeat(`\`, slashes))
			b.WriteByte(c)
			slashes = 0
			continue
		}
	}
	b.WriteString(strings.Repeat(`\`, 2*slashes))
	b.WriteByte('"')
	return b.String()
}

// LaunchAgent is a login item that is a property list file in
// ~/Library/LaunchAgents. launchd reads the folder at login; the file does
// not start anything now, and removing it does not stop the running app.
type LaunchAgent struct {
	Path  string
	Label string
	Args  []string
	// Stderr is where launchd writes the app's standard error, or "".
	Stderr string
}

// Enabled reports whether the property list file exists.
func (l LaunchAgent) Enabled() (bool, error) {
	_, err := os.Stat(l.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// Set writes or removes the property list file.
func (l LaunchAgent) Set(on bool) error {
	if !on {
		if err := os.Remove(l.Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(l.Path), 0o755); err != nil {
		return err
	}
	tmp := l.Path + ".tmp"
	if err := os.WriteFile(tmp, LaunchAgentPlist(l.Label, l.Args, l.Stderr), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, l.Path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// Registry is the Run key of the current user: string values by name.
type Registry interface {
	// GetString returns the value and whether it exists.
	GetString(name string) (string, bool, error)
	SetString(name, value string) error
	// Delete removes the value. A missing value is not an error.
	Delete(name string) error
}

// RunKey is a login item that is a value under the Run key.
type RunKey struct {
	Key   Registry
	Name  string
	Value string
}

// Enabled reports whether the value exists.
func (r RunKey) Enabled() (bool, error) {
	_, ok, err := r.Key.GetString(r.Name)
	return ok, err
}

// Set writes or removes the value.
func (r RunKey) Set(on bool) error {
	if on {
		return r.Key.SetString(r.Name, r.Value)
	}
	return r.Key.Delete(r.Name)
}

// launchAgentPath is where the agent of label lives for the user at home.
func launchAgentPath(home, label string) string {
	return filepath.Join(home, "Library", "LaunchAgents", label+".plist")
}
