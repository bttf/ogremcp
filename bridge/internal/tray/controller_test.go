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

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/upload"
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

// staleUploads is an uploader whose LoginRequired is still set from before
// the latest login.
type staleUploads struct{ changed chan struct{} }

func (u staleUploads) Changed() <-chan struct{} { return u.changed }
func (u staleUploads) Status() upload.Status    { return upload.Status{LoginRequired: true} }

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
	uploads := staleUploads{changed: make(chan struct{})}
	go c.followUploads(t.Context(), uploads)
	unsavedNote := "Logged in, but the keychain did not save the login. Retrying; until then, quitting logs you out."

	c.Login(t.Context())
	waitFor(t, "unsaved", func() bool { return m.State().Login == LoginUnsaved })
	if resumes.Load() != 1 {
		t.Errorf("%d resumes after the login, want 1", resumes.Load())
	}

	// A file change while the save is retried. The second send waits until
	// the first is handled.
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
