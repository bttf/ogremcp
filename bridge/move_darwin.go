//go:build darwin && cgo

package main

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/ncruces/zenity"
	"golang.org/x/sys/unix"

	"github.com/bttf/ogremcp/bridge/internal/autostart"
	"github.com/bttf/ogremcp/bridge/internal/macapp"
)

// offerMove offers to move the app to ~/Applications when it runs from
// anywhere else, such as the disk image or Downloads (§7 Installer). It asks
// at every start from outside ~/Applications, because the bridge updates
// itself only where it may replace the app. When the user accepts, it copies
// the app there, replacing an older copy, removes the app the user opened
// when it can, points start at login at the new place, and starts the app
// from there. It returns true when the new app starts, and the caller quits.
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
	if macapp.In(where, dir) {
		return false
	}

	_, err = os.Stat(filepath.Join(dir, macapp.Name))
	move, err := askMove(err == nil)
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
		if err := macapp.Remove(original); err != nil {
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

// askMove asks whether to move the app to ~/Applications. replaces says that
// an app is there already and the move replaces it.
func askMove(replaces bool) (bool, error) {
	text := "Ogre MCP is installed in the Applications folder of your home folder, where it can update itself. It starts again from there after the move."
	if replaces {
		text += "\n\nThe copy of Ogre MCP that is there now is replaced."
	}
	err := zenity.Question(text,
		zenity.Title("Move Ogre MCP to ~/Applications?"),
		zenity.OKLabel("Move"), zenity.CancelLabel("Not Now"))
	if errors.Is(err, zenity.ErrCanceled) {
		return false, nil
	}
	return err == nil, err
}
