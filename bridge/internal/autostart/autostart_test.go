package autostart

import (
	"errors"
	"path/filepath"
	"runtime"
	"testing"
)

// Adapted from bttf/wow-guide@df80260, bridge/internal/autostart/autostart_test.go.
func TestTranslocated(t *testing.T) {
	moved := "/private/var/folders/ab/xyz/T/AppTranslocation/0A1B2C3D/d/Open Gamer MCP.app/Contents/MacOS/ogmcp-bridge"
	if !Translocated(moved) {
		t.Error("translocated path not recognised")
	}
	if Translocated("/Users/player/Applications/Open Gamer MCP.app/Contents/MacOS/ogmcp-bridge") {
		t.Error("an app in Applications counts as translocated")
	}
	if runtime.GOOS == "darwin" {
		if m, err := New([]string{moved}, ""); m != nil || !errors.Is(err, ErrTranslocated) {
			t.Errorf("New for a translocated app = %v, %v", m, err)
		}
	}
}

// The per-user install folder on Windows is under the user's profile, whose
// name can hold a space.
func TestRunValue(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{`C:\Apps\ogmcp-bridge.exe`}, `C:\Apps\ogmcp-bridge.exe`},
		{[]string{`C:\Users\Ann Lee\AppData\Local\ogmcp-bridge.exe`}, `"C:\Users\Ann Lee\AppData\Local\ogmcp-bridge.exe"`},
	}
	for _, c := range cases {
		if got := RunValue(c.args); got != c.want {
			t.Errorf("RunValue(%q) = %s, want %s", c.args, got, c.want)
		}
	}
}

// A login item written by the app at another place is not current, so the
// tray writes it again for the app's new place.
func TestLaunchAgentCurrent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "LaunchAgents", Label+".plist")
	old := LaunchAgent{Path: path, Label: Label, Args: []string{"/Users/a/Downloads/Open Gamer MCP.app/Contents/MacOS/ogmcp-bridge"}}
	moved := LaunchAgent{Path: path, Label: Label, Args: []string{"/Users/a/Applications/Open Gamer MCP.app/Contents/MacOS/ogmcp-bridge"}}
	if on, current, err := moved.Enabled(); on || current || err != nil {
		t.Fatalf("before: %v %v %v", on, current, err)
	}
	if err := old.Set(true); err != nil {
		t.Fatal(err)
	}
	if on, current, err := moved.Enabled(); !on || current || err != nil {
		t.Errorf("written for the old place: %v %v %v", on, current, err)
	}
	if err := moved.Set(true); err != nil {
		t.Fatal(err)
	}
	if on, current, err := moved.Enabled(); !on || !current || err != nil {
		t.Errorf("written again: %v %v %v", on, current, err)
	}
}
