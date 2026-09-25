package tray

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/adapter"
)

func TestRenderStatus(t *testing.T) {
	now := time.Date(2026, 9, 24, 18, 30, 0, 0, time.Local)
	cases := []struct {
		name string
		s    State
		// status, note, login item, and whether it is enabled
		want string
	}{
		{"starting", State{Login: LoginChecking}, "Starting… |  |  off"},
		{"logged out", State{Login: LoginNeeded}, "Not logged in |  | Log in… on"},
		{"code pending", State{Login: LoginWaiting}, "Logging in… | Asking the server for a login code… | Open the login page off"},
		{"code shown", State{Login: LoginWaiting, UserCode: "BCDF-GHJK", LoginPage: "https://ogmcp.example/device"},
			"Logging in… | Enter code BCDF-GHJK at https://ogmcp.example/device | Open the login page on"},
		{"no upload", State{Login: LoginDone}, "Last upload: none yet |  |  off"},
		{"upload today", State{Login: LoginDone, LastUpload: now.Add(-time.Hour)}, "Last upload: 17:30 |  |  off"},
		{"upload yesterday", State{Login: LoginDone, LastUpload: now.Add(-24 * time.Hour)}, "Last upload: Sep 23, 18:30 |  |  off"},
		{"unsaved", State{Login: LoginUnsaved}, "Last upload: none yet | Logged in, but the keychain did not save the login. Retrying; until then, quitting logs you out. |  off"},
	}
	for _, c := range cases {
		v := Render(c.s, now)
		got := v.Status + " | " + v.Note + " | " + v.Login + " " + onOff(v.LoginEnabled)
		if got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
		if v.Tooltip != "Open Gamer MCP: "+v.Status {
			t.Errorf("%s: tooltip %q", c.name, v.Tooltip)
		}
		if v.Active != (c.s.Login == LoginDone) {
			t.Errorf("%s: active %v", c.name, v.Active)
		}
	}

	v := Render(State{Login: LoginDone, Error: strings.Repeat("x", 200), ErrorAt: now}, now)
	if want := "Error at 18:30: " + strings.Repeat("x", maxErrorRunes-1) + "…"; v.Error != want {
		t.Errorf("error line %q", v.Error)
	}
}

func TestRenderAdapters(t *testing.T) {
	st := func(kit, path string, s adapter.State) adapter.Status {
		return adapter.Status{Kit: kit, Path: path, State: s, Installed: "0.2.0"}
	}
	names := map[string]string{"wow": "World of Warcraft"}
	cases := []struct {
		list []adapter.Status
		want []string
	}{
		{[]adapter.Status{st("wow", "era", adapter.StateCurrent), st("wow", "retail", adapter.StateInstalled)},
			[]string{"World of Warcraft addon: up to date (0.2.0)"}},
		{[]adapter.Status{st("wow", "era", adapter.StateWaiting), st("wow", "retail", adapter.StateCurrent)},
			[]string{"Close World of Warcraft to finish updating the addon"}},
		{[]adapter.Status{st("wow", "era", adapter.StateRestart), st("wow", "retail", adapter.StateRestart)},
			[]string{"Restart World of Warcraft to load the addon"}},
		{[]adapter.Status{st("wow", "era", adapter.StateLinked), st("wow", "retail", adapter.StateWaiting)},
			[]string{"World of Warcraft addon: updates skipped, its folder is a link", "Close World of Warcraft to finish updating the addon"}},
	}
	for _, c := range cases {
		if got := Render(State{Adapters: c.list, KitNames: names}, time.Now()).Adapters; !slices.Equal(got, c.want) {
			t.Errorf("adapters %v:\n got %q\nwant %q", c.list, got, c.want)
		}
	}
	// A server that sends no name: the kit's ID.
	if got := Render(State{Adapters: cases[1].list}, time.Now()).Adapters; !slices.Equal(got, []string{"Close wow to finish updating the addon"}) {
		t.Errorf("without a name: %q", got)
	}
}

func TestRenderAutostartBlocked(t *testing.T) {
	v := Render(State{AutostartAvailable: true}, time.Now())
	if v.AutostartTitle != TitleAutostart || !v.AutostartEnabled {
		t.Errorf("available: %q %v", v.AutostartTitle, v.AutostartEnabled)
	}
	// A translocated app says why it cannot start at login.
	v = Render(State{AutostartBlocked: TitleMoveApp}, time.Now())
	if v.AutostartTitle != TitleMoveApp || v.AutostartEnabled {
		t.Errorf("blocked: %q %v", v.AutostartTitle, v.AutostartEnabled)
	}
}

// §7: each distinct error message is shown once per instance, not on every
// upload.
func TestErrorShownOncePerInstance(t *testing.T) {
	now := time.Date(2026, 9, 24, 10, 0, 0, 0, time.Local)
	m := &Model{Now: func() time.Time { return now }}
	step := func(errs map[string]string, wantShown []string, wantError string) {
		t.Helper()
		shown := m.SetErrors("upload", errs)
		if !slices.Equal(shown, wantShown) {
			t.Errorf("shown %q, want %q", shown, wantShown)
		}
		s := m.State()
		if got := s.Error + " @" + s.ErrorAt.Format("15:04"); got != wantError {
			t.Errorf("latest %q, want %q", got, wantError)
		}
		now = now.Add(time.Minute)
	}

	step(map[string]string{"a": "The server could not read the file."}, []string{"The server could not read the file."}, "The server could not read the file. @10:00")
	// Each retry reports it again: not shown again, and its time stays.
	step(map[string]string{"a": "The server could not read the file."}, nil, "The server could not read the file. @10:00")
	step(map[string]string{"a": "The server could not read the file."}, nil, "The server could not read the file. @10:00")
	// Another instance with the same message is shown.
	step(map[string]string{"a": "The server could not read the file.", "b": "The server could not read the file."},
		[]string{"The server could not read the file."}, "The server could not read the file. @10:03")
	// A different message for an instance is shown.
	step(map[string]string{"a": "Could not reach the server. The bridge will try again.", "b": "The server could not read the file."},
		[]string{"Could not reach the server. The bridge will try again."}, "Could not reach the server. The bridge will try again. @10:04")
	// Once an instance's error clears, the menu shows the newest one left.
	step(map[string]string{"b": "The server could not read the file."}, nil, "The server could not read the file. @10:03")
	step(nil, nil, " @00:00")

	// Groups are separate: the login's error does not clear the uploads'.
	m.SetErrors("upload", map[string]string{"a": "x"})
	m.SetErrors("login", map[string]string{"login": "Login failed: denied"})
	m.SetErrors("login", nil)
	if s := m.State(); s.Error != "x" {
		t.Errorf("after the login group cleared: %q", s.Error)
	}

	// An adapter folder whose sync failed is an error of its own.
	fail := adapter.Status{Kit: "wow", Path: "era", State: adapter.StateFailed, Err: errors.New("disk full")}
	if shown := m.SetAdapters([]adapter.Status{fail}); !slices.Equal(shown, []string{"wow addon: disk full"}) {
		t.Errorf("adapter error shown %q", shown)
	}
	if shown := m.MergeAdapters([]adapter.Status{fail}); shown != nil {
		t.Errorf("adapter error shown again %q", shown)
	}
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}
