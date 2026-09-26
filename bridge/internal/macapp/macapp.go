// Package macapp installs the macOS app per user (docs/architecture.md §7):
// Ogre MCP.app lives in ~/Applications, where the bridge can replace it on
// update without admin rights. Opened from anywhere else, such as the disk
// image or Downloads, the tray app offers to move it there.
//
// The move is a copy, a swap, and then the removal of the app the user
// opened, so that a failure at any step leaves a working app behind.
package macapp

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// Name is the app's name in ~/Applications, the name scripts/macos-app.sh
// gives it. The installed app keeps this name whatever the copy the user
// opened is called, so that an older copy is replaced and not kept beside it.
const Name = "Ogre MCP.app"

// Dir is the folder the app is installed in: Applications in the user's home
// folder at home.
func Dir(home string) string {
	return filepath.Join(home, "Applications")
}

// Bundle returns the .app that holds exe, the path of the running program, or
// false when exe is not the executable of an app bundle, as for a binary run
// from a terminal.
func Bundle(exe string) (string, bool) {
	macOS := filepath.Dir(exe)
	contents := filepath.Dir(macOS)
	app := filepath.Dir(contents)
	if filepath.Base(macOS) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(app) != ".app" {
		return "", false
	}
	return app, true
}

// Installed reports whether app is inside dir, directly or in a folder of
// it. It compares folders as files, not path text: on a case-insensitive disk,
// or through a symbolic link, one folder has more than one path.
func Installed(app, dir string) bool {
	want, err := os.Stat(dir)
	if err != nil {
		return false
	}
	path, err := filepath.EvalSymlinks(app)
	if err != nil {
		return false
	}
	for {
		parent := filepath.Dir(path)
		if parent == path {
			return false
		}
		path = parent
		if info, err := os.Stat(path); err == nil && os.SameFile(info, want) {
			return true
		}
	}
}

// same reports whether a and b are one file. It returns an error when either
// cannot be read, so that a caller about to remove one of them does not.
func same(a, b string) (bool, error) {
	ai, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false, err
	}
	return os.SameFile(ai, bi), nil
}

// Install copies app into dir, which it creates if needed, as Name, and
// returns the installed app's path. An app already there is replaced. The
// copy is staged in a hidden folder in dir and then renamed into place, so
// the older app stays whole until the new one is complete.
//
// The copy leaves out extended attributes, and with them the quarantine flag:
// macOS has already checked this app, which is running, and a quarantined app
// that was not moved in Finder runs from a temporary copy (App Translocation)
// each time it starts.
func Install(app, dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, Name)
	// The older app is removed below, so app must not be that app.
	if _, err := os.Stat(dst); err == nil {
		if one, err := same(app, dst); err != nil {
			return "", err
		} else if one {
			return "", fmt.Errorf("%s is the installed app", app)
		}
	}
	tmp, err := os.MkdirTemp(dir, ".ogremcp-install-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	staged := filepath.Join(tmp, Name)
	if err := copyTree(app, staged); err != nil {
		return "", fmt.Errorf("copy %s: %w", app, err)
	}
	old := filepath.Join(tmp, "old")
	moved := true
	if err := os.Rename(dst, old); errors.Is(err, fs.ErrNotExist) {
		moved = false
	} else if err != nil {
		return "", err
	}
	if err := os.Rename(staged, dst); err != nil {
		if moved {
			_ = os.Rename(old, dst)
		}
		return "", err
	}
	return dst, nil
}

// Remove removes app, the copy the user opened, once Install has put the app
// at installed. It never removes installed, whatever path names it, and fails
// when it cannot tell. It renames app out of sight first, so that app is
// either gone or left whole: a disk image is read-only, and a folder the user
// may not change refuses the rename.
func Remove(app, installed string) error {
	if one, err := same(app, installed); err != nil {
		return err
	} else if one {
		return fmt.Errorf("%s is the installed app", app)
	}
	tmp, err := os.MkdirTemp(filepath.Dir(app), ".ogremcp-remove-")
	if err != nil {
		return err
	}
	if err := os.Rename(app, filepath.Join(tmp, filepath.Base(app))); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.RemoveAll(tmp)
}

// copyTree copies the folder src to dst, which must not exist: folders,
// regular files with their permission bits, and symbolic links as links.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch mode := info.Mode(); {
		case mode.IsDir():
			return os.Mkdir(target, mode.Perm()|0o700)
		case mode.IsRegular():
			return copyFile(path, target, mode.Perm())
		case mode&fs.ModeSymlink != 0:
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		default:
			return fmt.Errorf("%s is not a file, a folder, or a link", path)
		}
	})
}

func copyFile(src, dst string, perm fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
