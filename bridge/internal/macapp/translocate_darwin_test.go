//go:build darwin && cgo

package macapp

import (
	"os"
	"path/filepath"
	"testing"
)

// Remove takes away the app at the path Original returns, so for an app that
// is not translocated it must be the app itself.
func TestOriginalOfAnAppNotTranslocated(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(dir, Name)
	if err := os.MkdirAll(filepath.Join(app, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := Original(app); got != app {
		t.Errorf("Original(%s) = %q", app, got)
	}
	if got := Original(filepath.Join(dir, "missing.app")); got != "" {
		t.Errorf("Original of a missing app = %q, want \"\"", got)
	}
}
