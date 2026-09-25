package autostart

import (
	"errors"
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
