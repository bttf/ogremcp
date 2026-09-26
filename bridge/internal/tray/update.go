package tray

import (
	"context"
	"errors"
	"time"

	"github.com/bttf/ogremcp/bridge/internal/selfupdate"
)

// Updater finds and installs the bridge's newest release (§7). It is a
// *selfupdate.Updater.
type Updater interface {
	Latest(ctx context.Context) (*selfupdate.Release, error)
	Install(ctx context.Context, r *selfupdate.Release) error
	Relaunch() error
	Cleanup(ctx context.Context) error
}

// RunUpdates updates the bridge itself until ctx ends (§7). It removes what
// an earlier update left, then checks for a newer release at start and every
// update interval (config.File.UpdateEvery). It installs a newer release
// without asking, starts it, and quits the tray app (Quit). The menu's update
// line shows each step. Without an Updater it does nothing.
func (c *Controller) RunUpdates(ctx context.Context) {
	if c.Updater == nil {
		return
	}
	if err := c.Updater.Cleanup(ctx); err != nil && ctx.Err() == nil {
		c.Log.Warn("could not remove the files an earlier update left", "error", err.Error())
	}
	c.settingsMu.Lock()
	every := c.Settings.UpdateEvery()
	c.settingsMu.Unlock()
	for !c.update(ctx) {
		t := time.NewTimer(every)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// update checks for a newer release once, and installs and starts it. It
// returns true once the release is installed: the checks end.
func (c *Controller) update(ctx context.Context) bool {
	r, err := c.Updater.Latest(ctx)
	if err != nil {
		// Offline, perhaps. The next check tries again; the menu stays quiet.
		if ctx.Err() == nil {
			c.Log.Warn("could not check for a bridge release", "error", err.Error())
		}
		return false
	}
	if r == nil {
		return false
	}
	v := r.Version.String()
	c.Log.Info("updating the bridge", "from", c.Version, "to", v)
	c.Model.SetUpdate(UpdateInstalling, v)
	err = c.Updater.Install(ctx, r)
	switch {
	case ctx.Err() != nil:
		c.Model.SetUpdate(UpdateNone, "")
		return false
	case errors.Is(err, selfupdate.ErrReadOnly):
		c.Log.Info("the bridge update is skipped", "version", v, "reason", err.Error())
		c.Model.SetUpdate(UpdateSkipped, v)
		c.showErrors("update", nil)
		return false
	case err != nil:
		c.Model.SetUpdate(UpdateNone, "")
		c.showErrors("update", map[string]string{"update": "Could not update Ogre MCP to " + v + ": " + err.Error()})
		return false
	}
	c.showErrors("update", nil)
	if err := c.Updater.Relaunch(); err != nil {
		c.Log.Error("the bridge update is installed, but could not start", "version", v, "error", err.Error())
		c.Model.SetUpdate(UpdateRestart, v)
		return true
	}
	c.Log.Info("the bridge update started; quitting", "version", v)
	if c.Quit != nil {
		c.Quit()
	}
	return true
}
