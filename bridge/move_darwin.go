//go:build darwin && cgo

package main

import (
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/ncruces/zenity"
	"golang.org/x/sys/unix"

	"github.com/bttf/ogremcp/bridge/internal/adapter"
	"github.com/bttf/ogremcp/bridge/internal/autostart"
	"github.com/bttf/ogremcp/bridge/internal/macapp"
)

// offerMove offers to move the app to ~/Applications when it runs from
// anywhere else, such as the disk image or Downloads (§7 Installer). It asks
// at every start from outside ~/Applications, because the bridge updates
// itself only where it may replace the app. When the user accepts, it copies
// the app there, replacing the copy there, removes the app the user opened
// when it can, points start at login at the new place, and starts the app
// from there. When the copy there is newer, it offers to open that copy
// instead. It returns true when the app starts from ~/Applications, and the
// caller quits.
// A binary that is not in an app bundle, such as a dev build run from a
// terminal, is never moved.
func offerMove(logger *slog.Logger, stderrPath string) bool {
	exe, err := executable()
	if err != nil {
		return false
	}
	app, ok := macapp.Bundle(exe)
	if !ok {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		logger.Warn("could not find the home folder; the app stays where it is", "error", err.Error())
		return false
	}
	dir := macapp.Dir(home)
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		dir = resolved
	}
	// The app the user opened: app itself, or the app that macOS runs a
	// translocated copy of. "" when the bridge cannot tell: then it copies
	// the running app and removes nothing.
	original := macapp.Original(app)
	where := original
	if where == "" {
		where = app
	}
	if macapp.Installed(where, dir) {
		return false
	}

	dst := filepath.Join(dir, macapp.Name)
	_, err = os.Stat(dst)
	replaces := err == nil
	if replaces {
		have, running := bundleVersion(dst), bundleVersion(app)
		if newer(have, running) {
			return offerInstalled(logger, dst, have, running)
		}
	}
	move, err := ask("Move Ogre MCP to ~/Applications?", moveText(replaces), "Move")
	if err != nil {
		logger.Warn("could not ask to move the app to ~/Applications", "error", err.Error())
	}
	if !move {
		logger.Info("the app stays where it is", "app", where)
		return false
	}
	installed, err := macapp.Install(app, dir)
	if err != nil {
		logger.Error("could not move the app to ~/Applications", "app", where, "error", err.Error())
		alert("Ogre MCP could not move itself to ~/Applications: " + err.Error() + "\n\nIt keeps running from where it is.")
		return false
	}
	logger.Info("the app is in ~/Applications", "app", installed, "from", where)
	// The app on a disk image, which is read-only, stays.
	if original != "" && !readOnly(original) {
		if err := macapp.Remove(original, installed); err != nil {
			logger.Info("left the app where it was opened", "app", original, "reason", err.Error())
		}
	}

	// The new process rewrites a login item that points elsewhere, too
	// (Controller.Run), but only once it has started.
	moved := []string{filepath.Join(installed, "Contents", "MacOS", filepath.Base(exe))}
	if m, err := autostart.New(moved, stderrPath); err != nil {
		logger.Warn("could not point start at login at the new place", "error", err.Error())
	} else if on, current, err := m.Enabled(); err != nil {
		logger.Warn("could not read start at login", "error", err.Error())
	} else if on && !current {
		if err := m.Set(true); err != nil {
			logger.Warn("could not point start at login at the new place", "error", err.Error())
		} else {
			logger.Info("start at login now starts the app from its new place")
		}
	}

	if err := macapp.Relaunch(installed); err != nil {
		logger.Error("could not start the moved app", "app", installed, "error", err.Error())
		alert("Ogre MCP moved to " + installed + ". Open it from there.")
	}
	return true
}

// readOnly reports whether path is on a read-only volume, such as a disk
// image.
func readOnly(path string) bool {
	var st unix.Statfs_t
	return unix.Statfs(path, &st) == nil && st.Flags&unix.MNT_RDONLY != 0
}

// offerInstalled offers to open the app at installed, which is newer than
// the running app, and replaces nothing. It returns true when that app
// starts, and the caller quits.
func offerInstalled(logger *slog.Logger, installed, have, running string) bool {
	open, err := ask("Open the newer Ogre MCP?",
		"~/Applications holds Ogre MCP "+have+", which is newer than this copy ("+running+"). This copy does not replace it.", "Open")
	if err != nil {
		logger.Warn("could not ask to open the app in ~/Applications", "error", err.Error())
	}
	if !open {
		logger.Info("the app runs from where it is; ~/Applications holds a newer one", "installed", have, "running", running)
		return false
	}
	if err := macapp.Relaunch(installed); err != nil {
		logger.Error("could not start the app in ~/Applications", "app", installed, "error", err.Error())
		return false
	}
	logger.Info("starting the newer app in ~/Applications", "app", installed, "version", have)
	return true
}

// moveText explains the move. replaces says that an app is there already and
// the move replaces it.
func moveText(replaces bool) string {
	text := "Ogre MCP is installed in the Applications folder of your home folder, where it can update itself. It starts again from there after the move."
	if replaces {
		text += "\n\nThe copy of Ogre MCP that is there now is replaced."
	}
	return text
}

// ask asks a question titled title, with ok on the button that accepts, and
// returns whether the user accepted.
func ask(title, text, ok string) (bool, error) {
	err := zenity.Question(text, zenity.Title(title), zenity.OKLabel(ok), zenity.CancelLabel("Not Now"))
	if errors.Is(err, zenity.ErrCanceled) {
		return false, nil
	}
	return err == nil, err
}

// bundleVersion is the CFBundleShortVersionString of the app at app, or ""
// when it cannot be read.
func bundleVersion(app string) string {
	out, err := exec.Command("/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-",
		filepath.Join(app, "Contents", "Info.plist")).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// newer reports whether version a is newer than version b. It is false when
// either is not of the form X.Y.Z, so an app of unknown version is replaced.
func newer(a, b string) bool {
	x, errA := adapter.ParseVersion(a)
	y, errB := adapter.ParseVersion(b)
	return errA == nil && errB == nil && x.Compare(y) > 0
}
