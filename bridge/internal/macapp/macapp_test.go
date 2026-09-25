// The app is macOS only, and these tests use Unix paths and permissions.

//go:build !windows

package macapp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBundleAndIn(t *testing.T) {
	apps := "/Users/a/Applications"
	exe := apps + "/Ogre MCP.app/Contents/MacOS/ogremcp-bridge"
	if app, ok := Bundle(exe); !ok || app != apps+"/Ogre MCP.app" {
		t.Errorf("Bundle(%s) = %s, %v", exe, app, ok)
	}
	if _, ok := Bundle("/Users/a/dev/ogremcp/bridge/bridge"); ok {
		t.Error("a binary outside an app counts as an app")
	}
	cases := map[string]bool{
		apps + "/Ogre MCP.app":           true,
		apps + "/Games/Ogre MCP.app":     true,
		"/Applications/Ogre MCP.app":     false,
		"/Volumes/Ogre MCP/Ogre MCP.app": false,
		"/Users/a/Applications2/X.app":   false,
		apps:                             false,
	}
	for app, want := range cases {
		if got := In(app, apps); got != want {
			t.Errorf("In(%s) = %v, want %v", app, got, want)
		}
	}
}

// Install replaces an older app whole, and Remove takes away the app the
// user opened.
func TestInstallReplacesAndRemoves(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "Downloads", "Ogre MCP 2.app")
	write(t, filepath.Join(src, "Contents", "MacOS", "ogremcp-bridge"), "new", 0o755)
	write(t, filepath.Join(src, "Contents", "Info.plist"), "plist", 0o644)
	if err := os.Symlink("MacOS/ogremcp-bridge", filepath.Join(src, "Contents", "link")); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "Applications")
	write(t, filepath.Join(dir, Name, "Contents", "MacOS", "ogremcp-bridge"), "old", 0o755)
	write(t, filepath.Join(dir, Name, "Contents", "Resources", "gone"), "old", 0o644)

	dst, err := Install(src, dir)
	if err != nil {
		t.Fatal(err)
	}
	if dst != filepath.Join(dir, Name) {
		t.Errorf("Install = %s", dst)
	}
	exe := filepath.Join(dst, "Contents", "MacOS", "ogremcp-bridge")
	if data, err := os.ReadFile(exe); err != nil || string(data) != "new" {
		t.Errorf("installed binary = %q, %v", data, err)
	}
	if info, err := os.Stat(exe); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Errorf("installed binary is not executable: %v, %v", info, err)
	}
	if link, err := os.Readlink(filepath.Join(dst, "Contents", "link")); err != nil || link != "MacOS/ogremcp-bridge" {
		t.Errorf("link = %q, %v", link, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "Contents", "Resources")); !os.IsNotExist(err) {
		t.Errorf("a file of the older app is left: %v", err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("%s holds %d entries, want only the app", dir, len(entries))
	}

	if err := Remove(src); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Dir(src)); len(entries) != 0 {
		t.Errorf("Downloads holds %d entries after Remove, want none", len(entries))
	}
}

// On a folder that refuses changes, such as a disk image, Remove leaves the
// app whole.
func TestRemoveLeavesAppOnFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores folder permissions")
	}
	parent := filepath.Join(t.TempDir(), "Volume")
	app := filepath.Join(parent, Name)
	exe := filepath.Join(app, "Contents", "MacOS", "ogremcp-bridge")
	write(t, exe, "app", 0o755)
	if err := os.Chmod(parent, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(parent, 0o755) })
	if err := Remove(app); err == nil {
		t.Error("Remove in a read-only folder succeeded")
	}
	if _, err := os.Stat(exe); err != nil {
		t.Errorf("the app is not whole: %v", err)
	}
}

func write(t *testing.T, path, data string, perm os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), perm); err != nil {
		t.Fatal(err)
	}
}
