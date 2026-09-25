package tray

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/adapter"
	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/kits"
	"github.com/bttf/ogmcp/bridge/internal/upload"
	"github.com/bttf/ogmcp/bridge/internal/watch"
)

// fakeAuth approves each login. The keychain saves only once saveOK is set;
// until then each call tries the save again first, as auth.Client does.
type fakeAuth struct {
	mu     sync.Mutex
	saveOK bool
}

func (f *fakeAuth) setSaveOK() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saveOK = true
}

func (f *fakeAuth) save() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.saveOK {
		return fmt.Errorf("%w: %w", auth.ErrNotSaved, errors.New("the keychain is locked"))
	}
	return nil
}

func (f *fakeAuth) Login(ctx context.Context, show func(auth.Code)) error {
	show(auth.Code{
		UserCode:                "BCDF-GHJK",
		VerificationURI:         "https://ogmcp.example/device",
		VerificationURIComplete: "https://ogmcp.example/device?user_code=BCDF-GHJK",
		ExpiresIn:               10 * time.Minute,
	})
	return f.save()
}

func (f *fakeAuth) AccessToken(context.Context) (string, error) {
	if err := f.save(); err != nil {
		return "", err
	}
	return "at-1", nil
}

func (f *fakeAuth) Do(*http.Request) (*http.Response, error)       { return nil, errors.New("unused") }
func (f *fakeAuth) DoUpload(*http.Request) (*http.Response, error) { return nil, errors.New("unused") }

// fakeUploads is an uploader with a fixed status. Its Changed is unbuffered,
// so a second send waits until followUploads has handled the first.
type fakeUploads struct {
	changed chan struct{}
	status  upload.Status
}

func (u fakeUploads) Changed() <-chan struct{} { return u.changed }
func (u fakeUploads) Status() upload.Status    { return u.status }

// A login whose keychain save fails keeps its tokens and says so, while
// uploads resume on them. A stale LoginRequired from the uploader does not
// end it, a second such login replaces the retry, and once the keychain works
// the menu says logged in.
func TestLoginWhenTheKeychainDoesNotSave(t *testing.T) {
	fake := &fakeAuth{}
	m := &Model{}
	m.SetLogin(LoginNeeded)
	var mu sync.Mutex
	var opened []string
	var resumes atomic.Int32
	c := &Controller{
		Auth:  fake,
		Model: m,
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Open: func(url string) error {
			mu.Lock()
			defer mu.Unlock()
			opened = append(opened, url)
			return nil
		},
		SaveRetry: time.Millisecond,
	}
	c.resume = func() { resumes.Add(1) }
	// The uploader's LoginRequired is still set from before the login.
	uploads := fakeUploads{changed: make(chan struct{}), status: upload.Status{LoginRequired: true}}
	go c.followUploads(t.Context(), uploads)
	unsavedNote := "Logged in, but the keychain did not save the login. Retrying; until then, quitting logs you out."

	c.Login(t.Context())
	waitFor(t, "unsaved", func() bool { return m.State().Login == LoginUnsaved })
	if resumes.Load() != 1 {
		t.Errorf("%d resumes after the login, want 1", resumes.Load())
	}

	// A file change while the save is retried.
	uploads.changed <- struct{}{}
	uploads.changed <- struct{}{}
	if got := m.State().Login; got != LoginUnsaved {
		t.Errorf("after a file change: login state %v, want LoginUnsaved", got)
	}

	// A second login whose save fails too.
	m.SetLogin(LoginNeeded)
	c.Login(t.Context())
	waitFor(t, "unsaved again", func() bool { return m.State().Login == LoginUnsaved })
	if v := m.View(time.Now()); v.Note != unsavedNote || v.Login != "" {
		t.Errorf("second login: note %q, login item %q", v.Note, v.Login)
	}

	fake.setSaveOK()
	waitFor(t, "saved", func() bool { return m.State().Login == LoginDone })
	waitFor(t, "retry stopped", func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return !c.saving && c.saveGen == 2
	})
	if n := resumes.Load(); n != 3 {
		t.Errorf("%d resumes, want 3: one per login, one after the save", n)
	}
	mu.Lock()
	defer mu.Unlock()
	want := "https://ogmcp.example/device?user_code=BCDF-GHJK"
	if !slices.Equal(opened, []string{want, want}) {
		t.Errorf("opened %q", opened)
	}
}

// A keychain that could not be read shows "Not logged in" and offers a
// login. A later call that works, a fetch or an upload, shows the login, so
// the user does not make a second one.
func TestLoginWorksAfterAKeychainReadError(t *testing.T) {
	m := &Model{}
	c := &Controller{Auth: &fakeAuth{saveOK: true}, Model: m, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	p := parts{
		watcher: watch.New(time.Second, time.Minute, nil, func(watch.Change) {}),
		updater: adapter.New(nil, nil),
	}
	readErr := fmt.Errorf("%w: %w", auth.ErrNotRead, errors.New("the keychain is locked"))
	check := func(when, status, login string) {
		t.Helper()
		if v := m.View(time.Now()); v.Status != status || v.Login != login {
			t.Errorf("%s: status %q, login item %q", when, v.Status, v.Login)
		}
	}

	c.onFetch(t.Context(), p, nil, readErr)
	check("after the read error", "Not logged in", "Log in…")
	c.onFetch(t.Context(), p, []kits.Kit{}, nil)
	check("after a fetch", "Last upload: none yet", "")
	if s := m.State(); s.Error != "" {
		t.Errorf("error line after a fetch: %q", s.Error)
	}

	c.onFetch(t.Context(), p, nil, readErr)
	at := time.Date(2026, 9, 24, 18, 30, 0, 0, time.Local)
	uploads := fakeUploads{changed: make(chan struct{}), status: upload.Status{LastUpload: at}}
	go c.followUploads(t.Context(), uploads)
	uploads.changed <- struct{}{}
	uploads.changed <- struct{}{}
	if got := m.State().Login; got != LoginDone {
		t.Errorf("after an upload: login state %v, want LoginDone", got)
	}
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}
