// Package tray is the logic of the tray app (docs/architecture.md §7): what
// its menu shows, the bridge it runs, and the menu's actions. It draws
// nothing: package main puts the View on screen with a tray library, so this
// package builds and tests on any system.
//
// # Errors
//
// §7: show each distinct error message once per instance, not on every
// upload. Each source of errors holds its current message: a source instance's
// uploads, the kit list, a kit's manifest or game folder, an adapter folder,
// the login. A message is shown, on the menu's error line and in the log,
// when it is new for its source. The same message again is not shown again.
// A source whose error clears drops it, so a later error there is new, as
// package upload logs an instance's error once, when it changes. The menu
// shows the newest error still current.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/tray: the Model, View,
// and Render of menu.go, the menu's actions and start at login of
// controller.go, icon.go, and recover.go. The prototype paired with its own
// code flow and watched only while WoW ran. This logs in with the device flow
// (§8.1), watches whether or not the game runs (package watch), and installs
// adapters (package adapter).
package tray

import (
	"cmp"
	"maps"
	"slices"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/bttf/ogmcp/bridge/internal/adapter"
)

// Login is the state of the bridge's login.
type Login int

const (
	// LoginChecking: the first fetch of the kits has not answered yet.
	LoginChecking Login = iota
	// LoginNeeded: the bridge holds no login, or the server ended it.
	LoginNeeded
	// LoginWaiting: a device login runs. The user approves its code in the
	// browser.
	LoginWaiting
	// LoginUnsaved: logged in, but the keychain has not saved the new
	// refresh token yet. The bridge tries the save again.
	LoginUnsaved
	// LoginDone: logged in.
	LoginDone
)

// State is everything the menu depends on.
type State struct {
	Login Login
	// UserCode is the code of a running login, once the server gave it, and
	// LoginPage the page where the user enters it, the web UI's /device.
	UserCode  string
	LoginPage string
	// LastUpload is when the server last took an upload, or zero.
	LastUpload time.Time
	// Error is the newest error still current, and ErrorAt when it was
	// shown.
	Error   string
	ErrorAt time.Time
	// Adapters are the adapter folders of the latest syncs.
	Adapters []adapter.Status
	// KitNames maps each kit's ID to its display name, such as "World of
	// Warcraft" (GET /api/v1/kits). A kit without one goes by its ID.
	KitNames map[string]string
	// NeedFolder means a kit's game folder was not found, and its manifest
	// lets the user pick it.
	NeedFolder bool
	// Autostart is true when the app starts at login; AutostartAvailable is
	// false on a system without a login item or after an error reading it.
	Autostart          bool
	AutostartAvailable bool
	// AutostartBlocked, when set, replaces the title of the start at login
	// item, which is then disabled: it says what the user must do first.
	AutostartBlocked string
}

// View is the text and state of each menu item.
type View struct {
	// Status is the first line of the menu, and Tooltip the icon's tooltip.
	Status  string
	Tooltip string
	// Note is a line under the status, hidden when "".
	Note string
	// Error is the error line, hidden when "".
	Error string
	// Adapters are the adapter lines, at most MaxAdapterLines.
	Adapters []string
	// Active selects the icon of a logged-in bridge.
	Active bool

	// Login is the title of the login item, hidden when "".
	Login        string
	LoginEnabled bool

	// ChooseFolder shows the item that opens the folder picker.
	ChooseFolder bool

	Autostart        bool
	AutostartTitle   string
	AutostartEnabled bool
}

// Menu item titles that do not change.
const (
	TitleChooseFolder = "Choose the game folder…"
	TitleServer       = "Server…"
	TitleAutostart    = "Start at login"
	TitleQuit         = "Quit Open Gamer MCP"
	// TitleMoveApp replaces TitleAutostart for an app that macOS runs from a
	// temporary copy (autostart.ErrTranslocated).
	TitleMoveApp = "Move Open Gamer MCP to Applications to start at login"
)

// MaxAdapterLines is the most adapter lines a View has.
const MaxAdapterLines = 4

// maxErrorRunes is the most characters of an error message the menu shows.
// The log has all of it.
const maxErrorRunes = 120

// Render computes the View of s at the time now.
func Render(s State, now time.Time) View {
	v := View{
		Active:           s.Login == LoginDone,
		Adapters:         adapterLines(s.Adapters, s.KitNames),
		ChooseFolder:     s.NeedFolder,
		Autostart:        s.Autostart,
		AutostartTitle:   TitleAutostart,
		AutostartEnabled: s.AutostartAvailable,
	}
	if s.AutostartBlocked != "" {
		v.AutostartTitle, v.AutostartEnabled = s.AutostartBlocked, false
	}
	switch s.Login {
	case LoginChecking:
		v.Status = "Starting…"
	case LoginNeeded:
		v.Status = "Not logged in"
		v.Login, v.LoginEnabled = "Log in…", true
	case LoginWaiting:
		v.Status = "Logging in…"
		// The page is known once the code is. The browser opens it by
		// itself; the item opens it again, and the note names it, for when
		// the browser does not open.
		v.Login, v.LoginEnabled = "Open the login page", s.UserCode != ""
		switch {
		case s.UserCode == "":
			v.Note = "Asking the server for a login code…"
		case s.LoginPage == "":
			v.Note = "Enter code " + s.UserCode + " in your browser"
		default:
			v.Note = "Enter code " + s.UserCode + " at " + s.LoginPage
		}
	case LoginUnsaved, LoginDone:
		v.Status = "Last upload: none yet"
		if !s.LastUpload.IsZero() {
			v.Status = "Last upload: " + clock(s.LastUpload, now)
		}
		if s.Login == LoginUnsaved {
			v.Note = "Logged in, but the keychain did not save the login. Retrying; until then, quitting logs you out."
		}
	}
	if s.Error != "" {
		v.Error = "Error at " + clock(s.ErrorAt, now) + ": " + shorten(s.Error, maxErrorRunes)
	}
	v.Tooltip = "Open Gamer MCP: " + v.Status
	return v
}

// adapterLines are the menu's lines about the adapters: per kit, each state
// the user should know of, or that the adapter is up to date. names are the
// kits' display names.
func adapterLines(list []adapter.Status, names map[string]string) []string {
	byKit := map[string][]adapter.Status{}
	for _, st := range list {
		byKit[st.Kit] = append(byKit[st.Kit], st)
	}
	var lines []string
	for _, kit := range slices.Sorted(maps.Keys(byKit)) {
		name := kitName(names, kit)
		var kitLines []string
		installed := ""
		for _, st := range byKit[kit] {
			var line string
			switch st.State {
			case adapter.StateWaiting:
				line = "Close " + name + " to finish updating the addon"
			case adapter.StateRestart:
				line = "Restart " + name + " to load the addon"
			case adapter.StateLinked:
				line = name + " addon: updates skipped, its folder is a link"
			case adapter.StateNotFolder:
				line = name + " addon: not installed, a file is in its place"
			case adapter.StateFailed:
				line = name + " addon: update failed"
			default:
				installed = cmp.Or(installed, st.Installed)
				continue
			}
			if !slices.Contains(kitLines, line) {
				kitLines = append(kitLines, line)
			}
		}
		if len(kitLines) == 0 {
			line := name + " addon: up to date"
			if installed != "" {
				line += " (" + installed + ")"
			}
			kitLines = []string{line}
		}
		lines = append(lines, kitLines...)
	}
	return lines[:min(len(lines), MaxAdapterLines)]
}

// kitName is the display name of kit, or its ID when it has none.
func kitName(names map[string]string, kit string) string {
	return cmp.Or(names[kit], kit)
}

// clock is t as a time of day, with the date when it is not the day of now.
func clock(t, now time.Time) string {
	t, now = t.Local(), now.Local()
	ty, tm, td := t.Date()
	ny, nm, nd := now.Date()
	if ty == ny && tm == nm && td == nd {
		return t.Format("15:04")
	}
	return t.Format("Jan 2, 15:04")
}

// shorten cuts s to at most n characters, ending with "…" when it cuts.
func shorten(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// Model holds the State and tells a listener about each change. It is safe
// for concurrent use: the bridge and the menu change it from different
// goroutines.
type Model struct {
	// Now is the clock of the errors' times. nil means time.Now.
	Now func() time.Time

	mu       sync.Mutex
	s        State
	errs     map[string]map[string]shown // by group, then source
	listener func()
}

// shown is the current error of one source, and when it was shown.
type shown struct {
	msg string
	at  time.Time
}

// Listen sets the function called after each change. It is called with no
// lock held, from the goroutine that made the change; it reads View.
func (m *Model) Listen(f func()) {
	m.mu.Lock()
	m.listener = f
	m.mu.Unlock()
}

// State returns a copy of the current State.
func (m *Model) State() State {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.s
}

// View returns the current View at the time now.
func (m *Model) View(now time.Time) View {
	return Render(m.State(), now)
}

// update applies f to the State and tells the listener. It returns the
// errors f showed.
func (m *Model) update(f func(*State) []string) []string {
	m.mu.Lock()
	shown := f(&m.s)
	listener := m.listener
	m.mu.Unlock()
	if listener != nil {
		listener()
	}
	return shown
}

func (m *Model) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// SetErrors replaces the errors of group, a set of sources the caller
// reports together: errs maps each source with an error to its message. It
// returns the messages shown now, those new for their source (§7).
func (m *Model) SetErrors(group string, errs map[string]string) []string {
	return m.update(func(s *State) []string {
		return m.setErrors(s, group, errs)
	})
}

// setErrors is SetErrors with mu held.
func (m *Model) setErrors(s *State, group string, errs map[string]string) []string {
	if m.errs == nil {
		m.errs = map[string]map[string]shown{}
	}
	old, next := m.errs[group], map[string]shown{}
	var out []string
	now := m.now()
	for _, source := range slices.Sorted(maps.Keys(errs)) {
		msg := errs[source]
		if e, ok := old[source]; ok && e.msg == msg {
			next[source] = e
			continue
		}
		next[source] = shown{msg: msg, at: now}
		out = append(out, msg)
	}
	m.errs[group] = next
	// The newest error still current. Of errors shown at once, the first by
	// group and source.
	s.Error, s.ErrorAt = "", time.Time{}
	for _, g := range slices.Sorted(maps.Keys(m.errs)) {
		for _, source := range slices.Sorted(maps.Keys(m.errs[g])) {
			if e := m.errs[g][source]; s.Error == "" || e.at.After(s.ErrorAt) {
				s.Error, s.ErrorAt = e.msg, e.at
			}
		}
	}
	return out
}

// SetLogin sets the login state and forgets a login's code.
func (m *Model) SetLogin(l Login) {
	m.update(func(s *State) []string {
		s.Login, s.UserCode, s.LoginPage = l, "", ""
		return nil
	})
}

// setUnlessWaiting sets the login state unless a login runs, which sets its
// own when it ends.
func (m *Model) setUnlessWaiting(l Login) {
	m.update(func(s *State) []string {
		if s.Login != LoginWaiting {
			s.Login, s.UserCode, s.LoginPage = l, "", ""
		}
		return nil
	})
}

// LoginCode records the code of the running login and the page where the
// user enters it.
func (m *Model) LoginCode(code, page string) {
	m.update(func(s *State) []string {
		if s.Login == LoginWaiting {
			s.UserCode, s.LoginPage = code, page
		}
		return nil
	})
}

// LoginEnded records that the bridge holds no login, or that the server
// ended it.
func (m *Model) LoginEnded() { m.setUnlessWaiting(LoginNeeded) }

// SaveFailing records that the keychain did not save the bridge's login.
func (m *Model) SaveFailing() { m.setUnlessWaiting(LoginUnsaved) }

// LoginWorks records that the bridge holds a login that works: the server
// answered a call made with it, or the keychain saved it. It ends any other
// state but a running login's, such as the "Not logged in" of a keychain
// that could not be read.
func (m *Model) LoginWorks() { m.setUnlessWaiting(LoginDone) }

// LoginKnown records that the server answered with the bridge's login, or
// that the bridge holds one it could not check, as when offline.
func (m *Model) LoginKnown() {
	m.update(func(s *State) []string {
		if s.Login == LoginChecking {
			s.Login = LoginDone
		}
		return nil
	})
}

// NewServer forgets what belongs to the old server when the server changes:
// the login, the last upload, the errors, the kits, and their adapters. Start
// at login stays.
func (m *Model) NewServer() {
	m.update(func(s *State) []string {
		*s = State{Autostart: s.Autostart, AutostartAvailable: s.AutostartAvailable, AutostartBlocked: s.AutostartBlocked}
		m.errs = nil
		return nil
	})
}

// SetKitNames records the kits' display names.
func (m *Model) SetKitNames(names map[string]string) {
	m.update(func(s *State) []string {
		s.KitNames = names
		return m.setErrors(s, "adapter", adapterErrors(s.Adapters, s.KitNames))
	})
}

// SetLastUpload records when the server last took an upload.
func (m *Model) SetLastUpload(t time.Time) {
	m.update(func(s *State) []string {
		s.LastUpload = t
		return nil
	})
}

// SetAdapters replaces the adapter folders with those of a sync, and shows
// their errors. It returns the errors shown now.
func (m *Model) SetAdapters(list []adapter.Status) []string {
	return m.update(func(s *State) []string {
		s.Adapters = slices.Clone(list)
		return m.setErrors(s, "adapter", adapterErrors(s.Adapters, s.KitNames))
	})
}

// MergeAdapters replaces the adapter folders in list, as when a staged
// update was applied, and keeps the others. It returns the errors shown now.
func (m *Model) MergeAdapters(list []adapter.Status) []string {
	return m.update(func(s *State) []string {
		merged := slices.Clone(s.Adapters)
		for _, st := range list {
			i := slices.IndexFunc(merged, func(a adapter.Status) bool { return a.Kit == st.Kit && a.Path == st.Path })
			if i < 0 {
				merged = append(merged, st)
			} else {
				merged[i] = st
			}
		}
		s.Adapters = merged
		return m.setErrors(s, "adapter", adapterErrors(s.Adapters, s.KitNames))
	})
}

// adapterErrors are the errors of the adapter folders whose sync failed.
func adapterErrors(list []adapter.Status, names map[string]string) map[string]string {
	errs := map[string]string{}
	for _, st := range list {
		if st.State == adapter.StateFailed && st.Err != nil {
			errs[st.Kit+"|"+st.Path] = kitName(names, st.Kit) + " addon: " + st.Err.Error()
		}
	}
	return errs
}

// SetNeedFolder records whether a kit's game folder is missing and may be
// picked.
func (m *Model) SetNeedFolder(need bool) {
	m.update(func(s *State) []string {
		s.NeedFolder = need
		return nil
	})
}

// SetAutostart records whether the app starts at login.
func (m *Model) SetAutostart(on, available bool) {
	m.update(func(s *State) []string {
		s.Autostart, s.AutostartAvailable = on, available
		return nil
	})
}

// SetAutostartBlocked records why start at login cannot be turned on.
func (m *Model) SetAutostartBlocked(title string) {
	m.update(func(s *State) []string {
		s.AutostartBlocked = title
		return nil
	})
}
