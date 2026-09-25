package tray

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/bttf/ogremcp/bridge/internal/auth"
	"github.com/bttf/ogremcp/bridge/internal/config"
)

// tokenServer is a server's discovery document, token endpoint, and kit
// list. It takes only its own refresh token and access token, and records
// each token it is sent. The tokens are invented.
type tokenServer struct {
	*httptest.Server
	mu   sync.Mutex
	seen []string
}

func newTokenServer(t *testing.T, name string) *tokenServer {
	s := &tokenServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		s.mu.Lock()
		for _, tok := range []string{r.PostForm.Get("refresh_token"), bearer} {
			if tok != "" {
				s.seen = append(s.seen, tok)
			}
		}
		s.mu.Unlock()
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"issuer": s.URL, "device_authorization_endpoint": s.URL + "/device/auth", "token_endpoint": s.URL + "/token",
			})
		case "/token":
			if r.PostForm.Get("refresh_token") != "rt-"+name {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token": "at-" + name, "token_type": "Bearer", "expires_in": 3600, "refresh_token": "rt-" + name,
			})
		case "/api/v1/kits":
			if bearer != "at-"+name {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = io.WriteString(w, `{"kits":[]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *tokenServer) tokens() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.seen)
}

// keychain holds a refresh token per server, as package keychain does.
type keychain struct {
	mu     sync.Mutex
	tokens map[string]string
}

func (k *keychain) get(account string) string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.tokens[account]
}

type keychainEntry struct {
	k       *keychain
	account string
}

func (e keychainEntry) Get() (string, error) { return e.k.get(e.account), nil }

func (e keychainEntry) Set(token string) error {
	e.k.mu.Lock()
	defer e.k.mu.Unlock()
	e.k.tokens[e.account] = token
	return nil
}

func (e keychainEntry) Delete() error {
	e.k.mu.Lock()
	defer e.k.mu.Unlock()
	delete(e.k.tokens, e.account)
	return nil
}

// Changing the server stops the bridge and starts it again against the new
// server, with the login in that server's keychain entry. The old server's
// token never reaches the new server, and its entry stays for a change back.
func TestSetServer(t *testing.T) {
	a, b := newTokenServer(t, "a"), newTokenServer(t, "b")
	kc := &keychain{tokens: map[string]string{a.URL: "rt-a", b.URL: "rt-b"}}
	newAuth := func(base string) (Auth, error) {
		return auth.New(base, "test", keychainEntry{k: kc, account: base})
	}
	first, err := newAuth(a.URL)
	if err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(t.TempDir(), "config.json")
	m := &Model{}
	c := &Controller{
		Base: a.URL, Auth: first, NewAuth: newAuth,
		SettingsPath: settingsPath, Model: m,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ctx, cancel := context.WithCancel(t.Context())
	stopped := make(chan struct{})
	go func() {
		c.Run(ctx)
		close(stopped)
	}()
	defer func() {
		cancel()
		<-stopped
	}()
	waitFor(t, "the kits of a", func() bool { return slices.Contains(a.tokens(), "at-a") })
	m.SetErrors("fetch", map[string]string{"kits": "an error of a"})

	if err := c.SetServer("http://localhost:1/path"); err == nil {
		t.Fatal("SetServer took a URL with a path")
	}
	if err := c.SetServer(b.URL); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the kits of b", func() bool { return slices.Contains(b.tokens(), "at-b") })
	waitFor(t, "logged in to b", func() bool { return m.State().Login == LoginDone })
	if s := m.State(); s.Error != "" {
		t.Errorf("the error of a is still shown: %q", s.Error)
	}

	if got := a.tokens(); slices.ContainsFunc(got, func(s string) bool { return strings.HasSuffix(s, "-b") }) {
		t.Errorf("a got %q", got)
	}
	if got := b.tokens(); slices.ContainsFunc(got, func(s string) bool { return strings.HasSuffix(s, "-a") }) {
		t.Errorf("b got %q", got)
	}
	if got := kc.get(a.URL); got != "rt-a" {
		t.Errorf("the keychain entry of a holds %q", got)
	}
	if saved, err := config.Load(settingsPath); err != nil || saved.ServerURL != b.URL {
		t.Errorf("settings file: server_url %q, %v", saved.ServerURL, err)
	}
}
