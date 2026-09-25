package tray

import (
	"cmp"
	"context"
	"errors"
	"fmt"
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
// together. The menu calls Login, ChooseFolder, ChangeServer, and
// ToggleAutostart.
type Controller struct {
	// Base is the server's base URL, Auth its login, and Version the
	// bridge's. Run replaces Base and Auth when the server changes
	// (SetServer), while no part of the bridge runs.
	Base    string
	Version string
	Auth    Auth
	// NewAuth returns the login of the server at base. The login of each
	// server is in a keychain entry of its own, so the old server's token
	// never goes to the new server.
	NewAuth func(base string) (Auth, error)
	// Settings is the settings file at SettingsPath (package config). Run
	// saves each game folder it finds there, and SetServer the server.
	Settings     config.File
	SettingsPath string
	Model        *Model
	Log          *slog.Logger
	// Open opens a URL in the browser.
	Open func(url string) error
	// PickFolder shows a folder picker titled title and returns the folder
	// the user picked, or "" when the user cancels.
	PickFolder func(ctx context.Context, title string) (string, error)
	// AskServer asks the user for a new server, current being the one in
	// use, and confirms the change. It returns the server_url to save, ""
	// for config.DefaultServerURL, and false when the user keeps the server.
	AskServer func(ctx context.Context, current string) (string, bool, error)
	// Autostart is the login item, or nil where there is none.
	Autostart autostart.Manager
	// AutostartBlocked, when Autostart is nil, is the menu title that says
	// what the user must do before start at login works, or "".
	AutostartBlocked string
	// SaveRetry is how often a login the keychain did not save is saved
	// again. Zero means DefaultSaveRetry.
	SaveRetry time.Duration

	// settingsMu guards Settings and its saves.
	settingsMu sync.Mutex

	mu sync.Mutex
	// run is the context of the bridge's parts for the current server, and
	// stopRun ends it. next is the server SetServer asked for, which Run
	// starts once they have stopped.
	run     context.Context
	stopRun context.CancelFunc
	next    *server
	// tasks counts the logins and the keychain save retries, which run
	// against the current server. Run waits for them before it changes the
	// server.
	tasks     sync.WaitGroup
	asking    bool
	loggingIn bool
	loginURL  string
	// saving is true while a retrySave runs, and stopSave stops it. saveGen
	// counts the retries started, so one that was replaced leaves saving be.
	saving   bool
	stopSave context.CancelFunc
	saveGen  int
	// asked holds the kits whose folder picker the locate chain has shown.
	// It shows it once per kit by itself; ChooseFolder allows it again.
	asked map[string]bool
	// resume starts the uploads again and fetches the kits, after a login.
	// wake fetches the kits. Run sets both.
	resume func()
	wake   func()
}

// server is a server and its login.
type server struct {
	base string
	auth Auth
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
// each settled change. When the server changes (SetServer), it stops all of
// that, the uploads in flight and a running login included, and starts it
// again against the new server. It returns once everything it started has
// stopped.
func (c *Controller) Run(ctx context.Context) {
	c.readAutostart()
	for ctx.Err() == nil {
		run, stop := context.WithCancel(ctx)
		c.mu.Lock()
		next := c.next
		c.next = nil
		if next != nil {
			c.Base, c.Auth = next.base, next.auth
			clear(c.asked)
			// Under mu, so that no login starts before the menu is reset.
			c.Model.NewServer()
		}
		c.run, c.stopRun = run, stop
		c.mu.Unlock()
		if next != nil {
			c.Log.Info("the server changed", "server", next.base)
		}
		c.runServer(run)
		// Under mu, so that a login either started before, and is waited
		// for, or sees run ended and does not start.
		c.mu.Lock()
		stop()
		c.resume, c.wake = nil, nil
		c.mu.Unlock()
		c.tasks.Wait()
	}
}

// runServer runs the bridge against the current server until ctx ends, and
// returns once everything it started has stopped. An upload in flight ends
// with ctx.
func (c *Controller) runServer(ctx context.Context) {
	c.settingsMu.Lock()
	settings := c.Settings
	c.settingsMu.Unlock()
	p := parts{env: locate.DefaultEnv()}
	p.uploader = upload.New(c.Base, c.Auth, c.Version, settings.UploadCap(), c.Log)
	p.watcher = watch.New(settings.DebounceDelay(), settings.Interval(), c.Log, p.uploader.Add)
	p.updater = adapter.New(adapter.NewClient(c.Base, c.Auth), process.System{})
	poller := kits.NewPoller(kits.New(c.Base, c.Auth), settings.Interval(), func(list []kits.Kit, err error) {
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
	case errors.Is(err, auth.ErrNotRead):
		// Whether the bridge holds a login is unknown. The menu offers a
		// login, which writes a new one.
		c.Model.LoginEnded()
		c.showErrors("fetch", map[string]string{"keychain": "Could not read the login: " + err.Error()})
		return
	case errors.Is(err, auth.ErrNotSaved):
		// A refresh whose new refresh token the keychain did not save.
		c.mu.Lock()
		busy := c.saving || c.loggingIn
		c.mu.Unlock()
		if !busy {
			c.Model.SaveFailing()
			c.startSaveRetry(ctx)
		}
		return
	case err != nil:
		// Offline, perhaps: the bridge holds a login it could not check.
		c.Model.LoginKnown()
		c.showErrors("fetch", map[string]string{"kits": "Could not fetch the kits: " + err.Error()})
		return
	}
	c.Model.LoginWorks()
	names := map[string]string{}
	for _, k := range list {
		names[k.Kit] = cmp.Or(k.Name, k.Kit)
	}
	c.Model.SetKitNames(names)
	errs := map[string]string{}
	var located []watch.Kit
	var targets []adapter.Target
	need := false
	for _, k := range list {
		if k.Err != nil {
			errs["kit|"+k.Kit] = names[k.Kit] + ": " + k.Err.Error()
			continue
		}
		root, err := locate.Root(ctx, k.Manifest.Root, c.savedRoot(k.Kit), p.env, kitPrompter{c: c, kit: k.Kit})
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			errs["locate|"+k.Kit] = names[k.Kit] + ": " + err.Error()
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

// savedRoot is the game folder of kit in the settings file, or "".
func (c *Controller) savedRoot(kit string) string {
	c.settingsMu.Lock()
	defer c.settingsMu.Unlock()
	return c.Settings.Roots[kit]
}

// remember saves the game folder of kit to the settings file.
func (c *Controller) remember(kit, root string) {
	c.settingsMu.Lock()
	defer c.settingsMu.Unlock()
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

// uploads is the uploader's status (*upload.Uploader).
type uploads interface {
	Changed() <-chan struct{}
	Status() upload.Status
}

// followUploads shows the uploader's status: the last upload, a login the
// server ended, and each instance's error.
func (c *Controller) followUploads(ctx context.Context, u uploads) {
	var last time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-u.Changed():
		}
		st := u.Status()
		c.Model.SetLastUpload(st.LastUpload)
		if st.LastUpload.After(last) {
			// The server took an upload made with the login.
			last = st.LastUpload
			c.Model.LoginWorks()
		}
		// LoginRequired stays set until Resume, so it can be older than the
		// latest login. The login has ended only when the auth client holds
		// none. While a login's keychain save is retried, AccessToken answers
		// ErrNotSaved, so the menu keeps saying so.
		if st.LoginRequired && c.Model.State().Login != LoginNeeded {
			if _, err := c.Auth.AccessToken(ctx); errors.Is(err, auth.ErrLoginRequired) {
				c.Model.LoginEnded()
			}
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

// Login starts a device login (§8.1) to the current server, or opens its
// page again while one runs. The menu calls it. The login ends with ctx, or
// when the server changes.
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
	if c.run != nil {
		if c.run.Err() != nil {
			// The server is changing; the menu offers a login again once
			// the new one answers.
			c.mu.Unlock()
			return
		}
		ctx = c.run
	}
	s := server{base: c.Base, auth: c.Auth}
	c.loggingIn, c.loginURL = true, ""
	c.tasks.Add(1)
	c.mu.Unlock()
	c.Model.SetLogin(LoginWaiting)
	// A new login's failure is shown even when it repeats the last one's.
	c.showErrors("login", nil)
	go func() {
		defer c.tasks.Done()
		defer Recover(c.Log)
		c.login(ctx, s)
	}()
}

// login runs one device login to s. It opens the login page in the browser
// once the server gives a code; the menu shows the code.
func (c *Controller) login(ctx context.Context, s server) {
	c.Log.Info("logging in", "server", s.base)
	err := s.auth.Login(ctx, func(code auth.Code) {
		url := cmp.Or(code.VerificationURIComplete, code.VerificationURI)
		c.mu.Lock()
		c.loginURL = url
		c.mu.Unlock()
		c.Model.LoginCode(code.UserCode, code.VerificationURI)
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
		// memory until a save succeeds, and each call tries the save first,
		// so the uploads and the fetches wait on the save, not on a login.
		c.Log.Error("logged in, but the keychain did not save the login; trying again", "error", err.Error())
		c.Model.SetLogin(LoginUnsaved)
		c.startSaveRetry(ctx)
		c.resumeAll()
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
	c.resumeAll()
}

// resumeAll starts the uploads that wait for a login, and fetches the kits.
func (c *Controller) resumeAll() {
	c.mu.Lock()
	resume := c.resume
	c.mu.Unlock()
	if resume != nil {
		resume()
	}
}

// startSaveRetry starts retrySave in place of any that runs: the tokens to
// save are the auth client's latest.
func (c *Controller) startSaveRetry(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	c.mu.Lock()
	if c.stopSave != nil {
		c.stopSave()
	}
	c.saving, c.stopSave = true, cancel
	c.saveGen++
	gen := c.saveGen
	c.tasks.Add(1)
	c.mu.Unlock()
	go func() {
		defer c.tasks.Done()
		defer Recover(c.Log)
		defer cancel()
		c.retrySave(ctx)
		c.mu.Lock()
		if c.saveGen == gen {
			c.saving, c.stopSave = false, nil
		}
		c.mu.Unlock()
	}()
}

// retrySave tries the keychain save again every SaveRetry, until it
// succeeds, the server ends the login, or ctx ends. AccessToken saves the
// unsaved refresh token before anything else, and hands out no token until
// the save succeeds. A login that runs keeps its menu state.
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
		if ctx.Err() != nil {
			// Replaced by a newer retry, or quitting.
			return
		}
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
		c.Model.LoginWorks()
		c.resumeAll()
		return
	}
}

// ChangeServer asks the user for a new server (AskServer) and changes to it
// (SetServer). The menu calls it. It shows one question at a time. The
// server it shows as current is the one a pending change goes to.
func (c *Controller) ChangeServer(ctx context.Context) {
	c.mu.Lock()
	if c.asking || c.AskServer == nil {
		c.mu.Unlock()
		return
	}
	c.asking = true
	current := c.Base
	if c.next != nil {
		current = c.next.base
	}
	c.mu.Unlock()
	c.showErrors("server", nil)
	go func() {
		defer Recover(c.Log)
		defer func() {
			c.mu.Lock()
			c.asking = false
			c.mu.Unlock()
		}()
		value, ok, err := c.AskServer(ctx, current)
		if err == nil && ok {
			err = c.SetServer(value)
		}
		if err != nil && ctx.Err() == nil {
			c.showErrors("server", map[string]string{"server": "Could not change the server: " + err.Error()})
		}
	}()
}

// SetServer makes value the server: a base URL that auth.ParseBaseURL
// accepts, or "" for config.DefaultServerURL. It saves value as server_url in
// the settings file, and Run then stops the bridge and starts it again
// against the new server, with the login the bridge holds for that server
// (NewAuth), or none. The old server's login stays in its keychain entry, for
// a change back.
func (c *Controller) SetServer(value string) error {
	base, err := config.File{ServerURL: value}.Server("")
	if err != nil {
		return err
	}
	a, err := c.NewAuth(base)
	if err != nil {
		return err
	}
	c.settingsMu.Lock()
	saved := c.Settings
	saved.ServerURL = value
	if c.SettingsPath != "" {
		err = config.Save(c.SettingsPath, saved)
	}
	if err == nil {
		c.Settings.ServerURL = value
	}
	c.settingsMu.Unlock()
	if err != nil {
		return fmt.Errorf("could not save the settings file: %w", err)
	}
	c.Log.Info("changing the server", "server", base)
	c.mu.Lock()
	c.next = &server{base: base, auth: a}
	if c.stopRun != nil {
		c.stopRun()
	}
	c.mu.Unlock()
	return nil
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
	on, current, err := c.Autostart.Enabled()
	if err != nil {
		c.Log.Warn("could not read start at login", "error", err.Error())
	}
	if on && !current {
		// The app moved since start at login was turned on, and the login
		// item starts it from its old place.
		if err := c.Autostart.Set(true); err != nil {
			c.Log.Warn("start at login starts the app from its old place; could not change it", "error", err.Error())
			on = false
		} else {
			c.Log.Info("start at login now starts the app from its new place")
		}
	}
	c.Model.SetAutostart(on, err == nil)
}
