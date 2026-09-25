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
	"testing"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/auth"
)

// fakeAuth approves each login, and fails the keychain save of the first
// saveFailures saves.
type fakeAuth struct {
	mu           sync.Mutex
	saveFailures int
	saves        int
}

func (f *fakeAuth) save() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.saves++
	if f.saves <= f.saveFailures {
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

// AccessToken tries the unsaved refresh token's save first, as auth.Client
// does.
func (f *fakeAuth) AccessToken(context.Context) (string, error) {
	if err := f.save(); err != nil {
		return "", err
	}
	return "at-1", nil
}

func (f *fakeAuth) Do(*http.Request) (*http.Response, error)       { return nil, errors.New("unused") }
func (f *fakeAuth) DoUpload(*http.Request) (*http.Response, error) { return nil, errors.New("unused") }

// A login whose keychain save fails keeps its tokens, says so, and saves
// them on a later try; then the uploads resume and the kits are fetched.
func TestLoginRetriesTheKeychainSave(t *testing.T) {
	fake := &fakeAuth{saveFailures: 3}
	m := &Model{}
	var mu sync.Mutex
	var logins []Login
	var notes []string
	m.Listen(func() {
		mu.Lock()
		defer mu.Unlock()
		s := m.State()
		if len(logins) == 0 || logins[len(logins)-1] != s.Login {
			logins = append(logins, s.Login)
			notes = append(notes, Render(s, time.Now()).Note)
		}
	})
	var opened []string
	resumed := make(chan struct{}, 2)
	c := &Controller{
		Auth:      fake,
		Model:     m,
		Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		Open:      func(url string) error { opened = append(opened, url); return nil },
		SaveRetry: time.Millisecond,
	}
	c.resume = func() { resumed <- struct{}{} }

	c.Login(t.Context())
	select {
	case <-resumed:
	case <-time.After(5 * time.Second):
		t.Fatal("the uploads did not resume")
	}

	mu.Lock()
	defer mu.Unlock()
	if want := []Login{LoginWaiting, LoginUnsaved, LoginDone}; !slices.Equal(logins, want) {
		t.Errorf("login states %v, want %v", logins, want)
	}
	if notes[1] != "Logged in, but the keychain did not save the login. Retrying; until then, quitting logs you out." {
		t.Errorf("unsaved note %q", notes[1])
	}
	if !slices.Equal(opened, []string{"https://ogmcp.example/device?user_code=BCDF-GHJK"}) {
		t.Errorf("opened %q", opened)
	}
	// The login's save and two retries failed; the third retry saved.
	if fake.saves != 4 {
		t.Errorf("%d saves, want 4", fake.saves)
	}
	if s := m.State(); s.Error != "" {
		t.Errorf("error line %q", s.Error)
	}
	select {
	case <-resumed:
		t.Error("resumed twice")
	default:
	}
}
