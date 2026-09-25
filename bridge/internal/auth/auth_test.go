package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// Invented values. None is a real code or token.
const (
	testDeviceCode = "test-device-code"
	testUserCode   = "BCDF-GHJK"
)

// events records saves to the Store and uses of access tokens, in order.
type events struct {
	mu   sync.Mutex
	list []string
}

func (e *events) add(s string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.list = append(e.list, s)
}

func (e *events) all() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return slices.Clone(e.list)
}

// server is the OAuth server and bridge API. Like the platform, it replaces
// the refresh token on each use, and revokes the grant when a replaced one is
// used again.
type server struct {
	*httptest.Server
	events *events

	mu sync.Mutex
	// polls are the device code answers in turn: "approve", or an error code.
	polls     []string
	pollCount int
	issued    int
	refreshes int
	refresh   string
	access    map[string]bool
	revoked   bool
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = r.ParseForm()
	form := r.PostForm
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		answer(w, 200, map[string]any{
			"issuer":                        s.URL,
			"device_authorization_endpoint": s.URL + "/oauth/device/auth",
			"token_endpoint":                s.URL + "/oauth/token",
		})
	case "/oauth/device/auth":
		if form.Get("client_id") != ClientID || form.Get("scope") != "ingest" || form.Get("resource") != s.URL+"/api/v1" {
			answer(w, 400, map[string]any{"error": "invalid_request"})
			return
		}
		answer(w, 200, map[string]any{
			"device_code": testDeviceCode, "user_code": testUserCode,
			"verification_uri": s.URL + "/device", "expires_in": 600,
		})
	case "/oauth/token":
		if form.Get("client_id") != ClientID {
			answer(w, 401, map[string]any{"error": "invalid_client"})
			return
		}
		switch form.Get("grant_type") {
		case deviceCodeGrant:
			if form.Get("device_code") != testDeviceCode {
				answer(w, 400, map[string]any{"error": "invalid_grant"})
				return
			}
			next := s.polls[min(s.pollCount, len(s.polls)-1)]
			s.pollCount++
			if next == "approve" {
				s.issue(w)
				return
			}
			answer(w, 400, map[string]any{"error": next})
		case "refresh_token":
			s.refreshes++
			if s.revoked || form.Get("refresh_token") != s.refresh {
				s.revoked = true
				answer(w, 400, map[string]any{"error": "invalid_grant"})
				return
			}
			s.issue(w)
		}
	case "/api/v1/kits":
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if s.revoked || !s.access[token] {
			w.WriteHeader(401)
			return
		}
		event := "use:" + token
		if body, _ := io.ReadAll(r.Body); len(body) > 0 {
			event += " " + string(body)
		}
		s.events.add(event)
		w.WriteHeader(200)
	default:
		w.WriteHeader(404)
	}
}

// issue answers new tokens and makes them the live ones. Called with mu held.
func (s *server) issue(w http.ResponseWriter) {
	s.issued++
	access := fmt.Sprintf("at-%d", s.issued)
	s.refresh = fmt.Sprintf("rt-%d", s.issued)
	s.access[access] = true
	answer(w, 200, map[string]any{
		"access_token": access, "token_type": "Bearer", "expires_in": 3600,
		"refresh_token": s.refresh, "scope": "ingest",
	})
}

func (s *server) state() (refreshes int, revoked bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refreshes, s.revoked
}

func answer(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// memStore is a Store in memory. It records each save in events.
type memStore struct {
	mu     sync.Mutex
	token  string
	getErr error
	setErr error
	events *events
}

func (m *memStore) Get() (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.token, m.getErr
}

func (m *memStore) Set(token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.setErr != nil {
		return m.setErr
	}
	m.token = token
	m.events.add("save:" + token)
	return nil
}

func (m *memStore) Delete() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = ""
	return nil
}

func (m *memStore) get() string {
	token, _ := m.Get()
	return token
}

// setup starts a server whose live refresh token is rt-0, and a Client for it
// with an empty Store. The Client's clock stands still unless the test moves
// *now.
func setup(t *testing.T) (*server, *memStore, *Client, *time.Time) {
	t.Helper()
	ev := &events{}
	s := &server{events: ev, refresh: "rt-0", access: map[string]bool{}}
	s.Server = httptest.NewServer(s)
	t.Cleanup(s.Close)
	store := &memStore{events: ev}
	c, err := New(s.URL, "test", store)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 24, 18, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return now }
	c.sleep = func(context.Context, time.Duration) error { return nil }
	c.log = slog.New(slog.DiscardHandler)
	return s, store, c, &now
}

func getKits(t *testing.T, c *Client, base string) error {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+"/api/v1/kits", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Do(req)
	if err == nil {
		res.Body.Close()
	}
	return err
}

func TestLogin(t *testing.T) {
	for _, tc := range []struct {
		name   string
		polls  []string
		err    error
		sleeps []time.Duration
	}{
		{"approved", []string{"authorization_pending", "approve"}, nil, []time.Duration{5 * time.Second, 5 * time.Second}},
		{"slow_down", []string{"slow_down", "approve"}, nil, []time.Duration{5 * time.Second, 10 * time.Second}},
		{"expired", []string{"authorization_pending", "expired_token"}, ErrExpired, []time.Duration{5 * time.Second, 5 * time.Second}},
		{"denied", []string{"access_denied"}, ErrDenied, []time.Duration{5 * time.Second}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, store, c, _ := setup(t)
			s.polls = tc.polls
			var sleeps []time.Duration
			c.sleep = func(_ context.Context, d time.Duration) error {
				sleeps = append(sleeps, d)
				return nil
			}
			var shown Code
			err := c.Login(t.Context(), func(code Code) { shown = code })
			if !errors.Is(err, tc.err) {
				t.Fatalf("Login: got %v, want %v", err, tc.err)
			}
			if shown.UserCode != testUserCode || shown.VerificationURI != s.URL+"/device" {
				t.Errorf("shown %+v", shown)
			}
			if !slices.Equal(sleeps, tc.sleeps) {
				t.Errorf("sleeps: got %v, want %v", sleeps, tc.sleeps)
			}
			if tc.err != nil {
				if store.get() != "" {
					t.Error("a failed login stored a refresh token")
				}
				return
			}
			if store.get() != "rt-1" {
				t.Errorf("stored %q, want rt-1", store.get())
			}
			if token, err := c.AccessToken(t.Context()); token != "at-1" || err != nil {
				t.Errorf("AccessToken: got %q, %v", token, err)
			}
		})
	}
}

// A keychain that cannot be read is not a login required: the bridge cannot
// tell, and the tray says so.
func TestKeychainReadError(t *testing.T) {
	_, store, c, _ := setup(t)
	store.getErr = errors.New("keychain locked")
	if _, err := c.AccessToken(t.Context()); !errors.Is(err, ErrNotRead) || errors.Is(err, ErrLoginRequired) {
		t.Fatalf("AccessToken with an unreadable keychain: got %v", err)
	}
}

func TestRefreshSavesBeforeUse(t *testing.T) {
	s, store, c, now := setup(t)
	store.token = "rt-0"

	// The keychain refuses the new refresh token: its access token is not used.
	store.setErr = errors.New("keychain locked")
	if _, err := c.AccessToken(t.Context()); !errors.Is(err, ErrNotSaved) {
		t.Fatalf("AccessToken with a failing save: got %v", err)
	}
	if err := getKits(t, c, s.URL); err == nil {
		t.Fatal("Do used the tokens of a failed save")
	}

	// The keychain works again. The next call saves rt-1 and uses at-1
	// without refreshing, so rt-0 is never sent again.
	store.setErr = nil
	if err := getKits(t, c, s.URL); err != nil {
		t.Fatal(err)
	}

	// A refresh near expiry: rt-2 is saved before at-2 is used.
	*now = now.Add(time.Hour)
	if err := getKits(t, c, s.URL); err != nil {
		t.Fatal(err)
	}

	want := []string{"save:rt-1", "use:at-1", "save:rt-2", "use:at-2"}
	if got := s.events.all(); !slices.Equal(got, want) {
		t.Errorf("events: got %v, want %v", got, want)
	}
	if refreshes, revoked := s.state(); refreshes != 2 || revoked {
		t.Errorf("server saw %d refreshes, revoked %v", refreshes, revoked)
	}
}

func TestConcurrentRefresh(t *testing.T) {
	s, store, c, _ := setup(t)
	store.token = "rt-0"
	tokens := make([]string, 20)
	var wg sync.WaitGroup
	for i := range tokens {
		wg.Go(func() {
			token, err := c.AccessToken(t.Context())
			if err != nil {
				t.Error(err)
			}
			tokens[i] = token
		})
	}
	wg.Wait()
	for _, token := range tokens {
		if token != "at-1" {
			t.Fatalf("tokens: %v", tokens)
		}
	}
	if refreshes, revoked := s.state(); refreshes != 1 || revoked {
		t.Errorf("server saw %d refreshes, revoked %v", refreshes, revoked)
	}
}

func TestUnauthorizedRefreshesOnce(t *testing.T) {
	s, store, c, _ := setup(t)
	store.token = "rt-0"
	if err := getKits(t, c, s.URL); err != nil {
		t.Fatal(err)
	}

	// at-1 expires before the bridge expects it to, as when a Mac sleeps past
	// its lifetime. The 401 gets a refresh, rt-2 is saved, and the request is
	// sent again with at-2 and its body.
	s.mu.Lock()
	delete(s.access, "at-1")
	s.mu.Unlock()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, s.URL+"/api/v1/kits", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatalf("Do after an early 401: %v", err)
	}
	res.Body.Close()

	want := []string{"save:rt-1", "use:at-1", "save:rt-2", "use:at-2 body"}
	if got := s.events.all(); !slices.Equal(got, want) {
		t.Errorf("events: got %v, want %v", got, want)
	}
	if store.get() != "rt-2" {
		t.Errorf("stored %q, want rt-2", store.get())
	}
	if refreshes, revoked := s.state(); refreshes != 2 || revoked {
		t.Errorf("server saw %d refreshes, revoked %v", refreshes, revoked)
	}
}

func TestUnauthorizedEndsLogin(t *testing.T) {
	s, store, c, _ := setup(t)
	store.token = "rt-0"
	if err := getKits(t, c, s.URL); err != nil {
		t.Fatal(err)
	}

	// The user revokes the device on the web.
	s.mu.Lock()
	s.revoked = true
	s.mu.Unlock()
	if err := getKits(t, c, s.URL); !errors.Is(err, ErrLoginRequired) {
		t.Fatalf("Do after a 401: got %v", err)
	}
	if store.get() != "" {
		t.Error("the refresh token is still stored")
	}
	if _, err := c.AccessToken(t.Context()); !errors.Is(err, ErrLoginRequired) {
		t.Errorf("AccessToken after a 401: got %v", err)
	}

	// A bridge that starts with the revoked grant's refresh token is refused
	// at the refresh, and forgets the token too.
	other := &memStore{token: "rt-1", events: &events{}}
	c2, err := New(s.URL, "test", other)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c2.AccessToken(t.Context()); !errors.Is(err, ErrLoginRequired) {
		t.Errorf("AccessToken with a revoked refresh token: got %v", err)
	}
	if other.get() != "" {
		t.Error("the revoked refresh token is still stored")
	}
}

func TestParseBaseURL(t *testing.T) {
	for raw, want := range map[string]string{
		"https://OGREMCP.example/":  "https://ogremcp.example",
		"http://localhost:3000":     "http://localhost:3000",
		"http://127.0.0.1:3000/":    "http://127.0.0.1:3000",
		"http://ogremcp.example":    "",
		"https://ogremcp.example/x": "",
		"ogremcp.example":           "",
	} {
		got, err := ParseBaseURL(raw)
		if got != want || (err == nil) != (want != "") {
			t.Errorf("ParseBaseURL(%q): got %q, %v; want %q", raw, got, err, want)
		}
	}
}
