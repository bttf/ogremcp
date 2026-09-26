package tray

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/bttf/ogremcp/bridge/internal/adapter"
	"github.com/bttf/ogremcp/bridge/internal/selfupdate"
)

// fakeUpdater offers release 1.2.4, and Install answers installErr.
type fakeUpdater struct {
	installErr error
	relaunched bool
}

func (f *fakeUpdater) Latest(context.Context) (*selfupdate.Release, error) {
	return &selfupdate.Release{Tag: "bridge-v1.2.4", Version: adapter.Version{Major: 1, Minor: 2, Patch: 4}}, nil
}
func (f *fakeUpdater) Install(context.Context, *selfupdate.Release) error { return f.installErr }
func (f *fakeUpdater) Relaunch() error                                    { f.relaunched = true; return nil }
func (f *fakeUpdater) Cleanup(context.Context) error                      { return nil }

// A newer release is installed, started, and the tray quits. In a read-only
// folder the update is skipped, and the menu says so.
func TestRunUpdates(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	up := &fakeUpdater{}
	quit := false
	c := &Controller{Version: "1.2.3", Model: &Model{}, Log: log, Updater: up, Quit: func() { quit = true }}
	c.RunUpdates(context.Background())
	if !up.relaunched || !quit {
		t.Errorf("relaunched %v, quit %v; want both", up.relaunched, quit)
	}
	if got := c.Model.View(time.Now()).Update; got != "Updating Ogre MCP to 1.2.4…" {
		t.Errorf("update line %q", got)
	}

	up = &fakeUpdater{installErr: selfupdate.ErrReadOnly}
	c = &Controller{Version: "1.2.3", Model: &Model{}, Log: log, Updater: up}
	ctx, cancel := context.WithCancel(context.Background())
	c.Model.Listen(func() {
		if c.Model.State().Update == UpdateSkipped {
			cancel()
		}
	})
	c.RunUpdates(ctx)
	if up.relaunched {
		t.Error("relaunched after a skipped update")
	}
	if got := c.Model.View(time.Now()).Update; got != "Update to 1.2.4 skipped: the app's folder is read-only" {
		t.Errorf("update line %q", got)
	}
}
