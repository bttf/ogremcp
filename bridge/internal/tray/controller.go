package tray

import (
	"cmp"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/adapter"
	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/autostart"
	"github.com/bttf/ogmcp/bridge/internal/config"
	"github.com/bttf/ogmcp/bridge/internal/kits"
	"github.com/bttf/ogmcp/bridge/internal/locate"
	"github.com/bttf/ogmcp/bridge/internal/manifest"
	"github.com/bttf/ogmcp/bridge/internal/process"
	"github.com/bttf/ogmcp/bridge/internal/upload"
	"github.com/bttf/ogmcp/bridge/internal/watch"
)

// DefaultSaveRetry is how often the tray tries again to save a login that
// the keychain did not save.
const DefaultSaveRetry = 30 * time.Second

// Auth is the bridge's login and its access to the bridge API. It is an
// *auth.Client.
type Auth interface {
	Login(ctx context.Context, show func(auth.Code)) error
	AccessToken(ctx context.Context) (string, error)
	Do(req *http.Request) (*http.Response, error)
	DoUpload(req *http.Request) (*http.Response, error)
}

// Controller runs the bridge for the tray app and reports through Model. Run
// does what the dev commands `bridge run` and `bridge adapter -watch` do
// together. The menu calls Login, ChooseFolder, and ToggleAutostart.
type Controller struct {
	// Base is the server's base URL, and Version the bridge's.
	Base    string
	Version string
	Auth    Auth
	// Settings is the settings file at SettingsPath (package config). Run
	// saves each game folder it finds there.
	Settings     config.File
	SettingsPath string
	Model        *Model
	Log          *slog.Logger
	// Open opens a URL in the browser.
	Open func(url string) error
	// PickFolder shows a folder picker titled title and returns the folder
	// the user picked, or "" when the user cancels.
	PickFolder func(ctx context.Context, title string) (string, error)
	// Autostart is the login item, or nil where there is none.
	Autostart autostart.Manager
	// AutostartBlocked, when Autostart is nil, is the menu title that says
	// what the user must do before start at login works, or "".
	AutostartBlocked string
	// SaveRetry is how often a login the keychain did not save is saved
	// again. Zero means DefaultSaveRetry.
	SaveRetry time.Duration

	mu        sync.Mutex
	loggingIn bool
	loginURL  string
	// saving is true while retrySave runs.
	saving bool
	// asked holds the kits whose folder picker the locate chain has shown.
	// It shows it once per kit by itself; ChooseFolder allows it again.
	asked map[string]bool
	// resume starts the uploads again and fetches the kits, after a login.
	// wake fetches the kits. Run sets both.
	resume func()
	wake   func()
}

// parts are the bridge's components that the kit fetches drive.
type parts struct {
	uploader *upload.Uploader
	watcher  *watch.Watcher
	updater  *adapter.Updater
	env      locate.Env
}

// Run runs the bridge until ctx ends (§7): it fetches the kits at start,
// after each login, and every refresh interval, locates each game folder,
// installs or updates each adapter, watches the kits' sources, and uploads
// each settled change. It returns once everything it started has stopped.
func (c *Controller) Run(ctx context.Context) {
	c.readAutostart()
	p := parts{env: locate.DefaultEnv()}
	p.uploader = upload.New(c.Base, c.Auth, c.Version, c.Settings.UploadCap(), c.Log)
	p.watcher = watch.New(c.Settings.DebounceDelay(), c.Settings.Interval(), c.Log, p.uploader.Add)
	p.updater = adapter.New(adapter.NewClient(c.Base, c.Auth), process.System{})
	poller := kits.NewPoller(kits.New(c.Base, c.Auth), c.Settings.Interval(), func(list []kits.Kit, err error) {
		c.onFetch(ctx, p, list, err)
	})
	c.mu.Lock()
	c.resume = func() {
		p.uploader.Resume()
		poller.Wake()
	}
	c.wake = poller.Wake
	c.mu.Unlock()

	var wg sync.WaitGroup
	start := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer Recover(c.Log)
			f()
		}()
	}
	start(func() {
		if err := p.watcher.Run(ctx); err != nil {
			c.showErrors("watch", map[string]string{"watch": "Could not watch the game folders: " + err.Error()})
		}
	})
	start(func() { p.uploader.Run(ctx) })
	start(func() {
		p.updater.Run(ctx, adapter.DefaultStagedInterval, func(list []adapter.Status) {
			c.logShown(c.Model.MergeAdapters(list))
		})
	})
	start(func() { c.followUploads(ctx, p.uploader) })
	start(func() { poller.Run(ctx) })
	wg.Wait()
}

// onFetch handles a fetch of the kits, on the poller's goroutine.
func (c *Controller) onFetch(ctx context.Context, p parts, list []kits.Kit, err error) {
	switch {
	case errors.Is(err, auth.ErrLoginRequired):
		// No request reached the server. The status line says so, and the
		// menu offers a login, after which Run's resume fetches again.
		c.Model.LoginEnded()
		c.showErrors("fetch", nil)
		return
	case errors.Is(err, auth.ErrNotSaved):
		c.saveFailed(ctx)
		return
	case err != nil:
		// Offline, perhaps: the bridge holds a login it could not check.
		c.Model.LoginKnown()
		c.showErrors("fetch", map[string]string{"kits": "Could not fetch the kits: " + err.Error()})
		return
	}
	c.Model.LoginKnown()
	errs := map[string]string{}
	var located []watch.Kit
	var targets []adapter.Target
	need := false
	for _, k := range list {
		if k.Err != nil {
			errs["kit|"+k.Kit] = k.Kit + ": " + k.Err.Error()
			continue
		}
		root, err := locate.Root(ctx, k.Manifest.Root, c.Settings.Roots[k.Kit], p.env, kitPrompter{c: c, kit: k.Kit})
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			errs["locate|"+k.Kit] = k.Kit + ": " + err.Error()
			p.uploader.CountError(upload.LocateFailed)
			need = need || canPick(k.Manifest.Root)
			continue
		}
		c.remember(k.Kit, root)
		located = append(located, watch.Kit{Kit: k.Kit, Root: root, Sources: k.Manifest.Sources})
		targets = append(targets, adapter.Target{Kit: k, Root: root})
	}
	p.watcher.SetKits(located)
	c.Model.SetNeedFolder(need)
	c.showErrors("fetch", errs)
	c.logShown(c.Model.SetAdapters(p.updater.Sync(ctx, targets)))
}

// canPick reports whether a root's locate chain has a folder picker.
func canPick(r manifest.Root) bool {
	return slices.ContainsFunc(r.Locate, func(e manifest.LocateEntry) bool { return e.Prompt != "" })
}

// remember saves the game folder of kit to the settings file.
func (c *Controller) remember(kit, root string) {
	if c.Settings.Roots[kit] == root {
		return
	}
	if c.Settings.Roots == nil {
		c.Settings.Roots = map[string]string{}
	}
	c.Settings.Roots[kit] = root
	if c.SettingsPath == "" {
		return
	}
	if err := config.Save(c.SettingsPath, c.Settings); err != nil {
		c.Log.Warn("could not remember the game folder", "kit", kit, "error", err.Error())
	}
}

// followUploads shows the uploader's status: the last upload, a login the
// server ended, and each instance's error.
func (c *Controller) followUploads(ctx context.Context, u *upload.Uploader) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-u.Changed():
		}
		st := u.Status()
		c.Model.SetLastUpload(st.LastUpload)
		if st.LoginRequired {
			c.Model.LoginEnded()
		}
		errs := map[string]string{}
		for _, in := range st.Instances {
			if in.Err != "" {
				errs[in.Kit+"|"+in.SourceID+"|"+in.Instance] = in.Err
			}
		}
		// Package upload logs each instance's error itself, once.
		c.Model.SetErrors("upload", errs)
	}
}

// showErrors replaces the errors of group and logs those shown now.
func (c *Controller) showErrors(group string, errs map[string]string) {
	c.logShown(c.Model.SetErrors(group, errs))
}

func (c *Controller) logShown(msgs []string) {
	for _, msg := range msgs {
		c.Log.Warn(msg)
	}
}

// kitPrompter is the folder picker of one kit's locate chain. It shows the
// picker once per kit, until ChooseFolder allows it again, so a user who
// cancels is not asked at every fetch.
type kitPrompter struct {
	c   *Controller
	kit string
}

func (p kitPrompter) PickFolder(ctx context.Context, title string) (string, error) {
	c := p.c
	c.mu.Lock()
	if c.asked == nil {
		c.asked = map[string]bool{}
	}
	asked := c.asked[p.kit]
	c.asked[p.kit] = true
	c.mu.Unlock()
	if asked || c.PickFolder == nil {
		return "", nil
	}
	c.Log.Info("asking for the game folder", "kit", p.kit)
	return c.PickFolder(ctx, title)
}

// ChooseFolder shows the folder picker again for each kit whose game folder
// was not found, by fetching the kits now. The menu calls it.
func (c *Controller) ChooseFolder() {
	c.mu.Lock()
	clear(c.asked)
	wake := c.wake
	c.mu.Unlock()
	if wake != nil {
		wake()
	}
}

// Login starts a device login (§8.1), or opens its page again while one
// runs. The menu calls it.
func (c *Controller) Login(ctx context.Context) {
	c.mu.Lock()
	if c.loggingIn {
		url := c.loginURL
		c.mu.Unlock()
		if url != "" {
			c.open(url)
		}
		return
	}
	c.loggingIn, c.loginURL = true, ""
	c.mu.Unlock()
	c.Model.SetLogin(LoginWaiting)
	// A new login's failure is shown even when it repeats the last one's.
	c.showErrors("login", nil)
	go func() {
		defer Recover(c.Log)
		c.login(ctx)
	}()
}

// login runs one device login. It opens the login page in the browser once
// the server gives a code; the menu shows the code.
func (c *Controller) login(ctx context.Context) {
	c.Log.Info("logging in", "server", c.Base)
	err := c.Auth.Login(ctx, func(code auth.Code) {
		url := cmp.Or(code.VerificationURIComplete, code.VerificationURI)
		c.mu.Lock()
		c.loginURL = url
		c.mu.Unlock()
		c.Model.LoginCode(code.UserCode)
		c.open(url)
	})
	c.mu.Lock()
	c.loggingIn, c.loginURL = false, ""
	c.mu.Unlock()
	switch {
	case err == nil:
		c.Log.Info("logged in")
		c.loggedIn()
	case errors.Is(err, auth.ErrNotSaved):
		// The server approved the login. Package auth keeps its tokens in
		// memory until a save succeeds.
		c.Log.Error("logged in, but the keychain did not save the login; trying again", "error", err.Error())
		c.saveFailed(ctx)
	case ctx.Err() != nil:
	default:
		c.Model.SetLogin(LoginNeeded)
		c.showErrors("login", map[string]string{"login": "Login failed: " + err.Error()})
	}
}

// loggedIn records a login whose refresh token is in the keychain, and
// starts the uploads and a fetch of the kits.
func (c *Controller) loggedIn() {
	c.Model.SetLogin(LoginDone)
	c.showErrors("login", nil)
	c.mu.Lock()
	resume := c.resume
	c.mu.Unlock()
	if resume != nil {
		resume()
	}
}

// saveFailed shows that the keychain did not save the login, and starts
// retrySave unless it runs.
func (c *Controller) saveFailed(ctx context.Context) {
	c.mu.Lock()
	if c.saving {
		c.mu.Unlock()
		return
	}
	c.saving = true
	c.mu.Unlock()
	c.Model.SetLogin(LoginUnsaved)
	go func() {
		defer Recover(c.Log)
		c.retrySave(ctx)
		c.mu.Lock()
		c.saving = false
		c.mu.Unlock()
	}()
}

// retrySave tries the keychain save again every SaveRetry, until it
// succeeds, the server ends the login, or ctx ends. AccessToken saves the
// unsaved refresh token before anything else, and hands out no token until
// the save succeeds.
func (c *Controller) retrySave(ctx context.Context) {
	every := cmp.Or(c.SaveRetry, DefaultSaveRetry)
	for {
		t := time.NewTimer(every)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		_, err := c.Auth.AccessToken(ctx)
		switch {
		case errors.Is(err, auth.ErrNotSaved):
			continue
		case errors.Is(err, auth.ErrLoginRequired):
			c.Model.LoginEnded()
			return
		case err != nil:
			// The save came first. A refresh after it failed, as when
			// offline; the next call tries it again.
			c.Log.Warn("could not refresh the login", "error", err.Error())
		}
		c.Log.Info("the keychain saved the login")
		c.loggedIn()
		return
	}
}

func (c *Controller) open(url string) {
	if c.Open == nil {
		return
	}
	if err := c.Open(url); err != nil {
		c.Log.Warn("could not open the browser", "error", err.Error())
	}
}

// ToggleAutostart turns starting at login on or off. The menu calls it.
func (c *Controller) ToggleAutostart() {
	if c.Autostart == nil {
		return
	}
	on := !c.Model.State().Autostart
	if err := c.Autostart.Set(on); err != nil {
		c.Log.Error("could not change start at login", "on", on, "error", err.Error())
		c.readAutostart()
		return
	}
	c.Log.Info("start at login changed", "on", on)
	c.Model.SetAutostart(on, true)
}

func (c *Controller) readAutostart() {
	if c.Autostart == nil {
		c.Model.SetAutostart(false, false)
		c.Model.SetAutostartBlocked(c.AutostartBlocked)
		return
	}
	on, err := c.Autostart.Enabled()
	if err != nil {
		c.Log.Warn("could not read start at login", "error", err.Error())
	}
	c.Model.SetAutostart(on, err == nil)
}
