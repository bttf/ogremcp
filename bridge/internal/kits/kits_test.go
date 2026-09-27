package kits

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

// server is the bridge API's kit routes. It serves the WoW kit's manifest,
// read from the repo, and lists WoW and the entries in extra: at first a kit
// it has no manifest for and a kit with an invalid name. The list's ETag is
// its version, and a matching If-None-Match gets 304.
type server struct {
	*httptest.Server
	manifest []byte

	mu    sync.Mutex
	paths []string
	// checks holds the If-None-Match of each request of the list.
	checks  []string
	version int
	extra   string
}

func newServer(t *testing.T) *server {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "kits", "wow", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	s := &server{manifest: raw, extra: `,
		{"kit": "gone", "manifest_version": "1.0.0", "adapter": null},
		{"kit": "../admin", "manifest_version": "1.0.0", "adapter": null}`}
	s.Server = httptest.NewServer(s)
	t.Cleanup(s.Close)
	return s
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.paths = append(s.paths, r.URL.Path)
	etag, extra := fmt.Sprintf(`"v%d"`, s.version), s.extra
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/v1/kits":
		s.mu.Lock()
		s.checks = append(s.checks, r.Header.Get("If-None-Match"))
		s.mu.Unlock()
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Write([]byte(`{"kits": [
			{"kit": "wow", "manifest_version": "0.1.0", "adapter": {"version": "0.1.0", "sha256": "` + zeros + `"}}` + extra + `
		]}`))
	case "/api/v1/kits/wow/manifest":
		w.Write(s.manifest)
	default:
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error": "unknown_kit"}`))
	}
}

const zeros = "0000000000000000000000000000000000000000000000000000000000000000"

func (s *server) requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.paths...)
}

func TestFetch(t *testing.T) {
	s := newServer(t)
	list, err := New(s.URL, s.Client()).Fetch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 {
		t.Fatalf("%d kits", len(list))
	}
	wow := list[0]
	if wow.Err != nil || wow.Manifest == nil || wow.Manifest.Kit != "wow" || wow.Adapter == nil || wow.Adapter.SHA256 != zeros {
		t.Errorf("wow: %+v", wow)
	}
	if list[1].Err == nil || list[1].Manifest != nil || list[1].Adapter != nil {
		t.Errorf("a kit the server has no manifest for: %+v", list[1])
	}
	if list[2].Err == nil {
		t.Errorf("a kit with an invalid name: %+v", list[2])
	}
	for _, p := range s.requests() {
		if p != "/api/v1/kits" && p != "/api/v1/kits/wow/manifest" && p != "/api/v1/kits/gone/manifest" {
			t.Errorf("requested %s", p)
		}
	}
}

// fetches runs a Poller of s and returns a channel of its results, and the
// Poller.
func fetches(t *testing.T, s *server, check, interval time.Duration) (<-chan []Kit, *Poller) {
	t.Helper()
	results := make(chan []Kit, 16)
	p := NewPoller(New(s.URL, s.Client()), check, interval, func(list []Kit, err error) bool {
		if err != nil {
			t.Error(err)
		}
		select {
		case results <- list:
		default: // the test has what it needs
		}
		return true
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		p.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return results, p
}

func next(t *testing.T, results <-chan []Kit) {
	t.Helper()
	select {
	case list := <-results:
		if len(list) == 0 || list[0].Manifest == nil {
			t.Errorf("fetched %+v", list)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no fetch")
	}
}

func TestPollerFetchesAtStartAndEveryInterval(t *testing.T) {
	results, _ := fetches(t, newServer(t), time.Hour, 10*time.Millisecond)
	for range 3 {
		next(t, results)
	}
}

func TestPollerFetchesOnSync(t *testing.T) {
	results, p := fetches(t, newServer(t), time.Hour, time.Hour)
	next(t, results) // at start
	p.Sync()
	next(t, results)
}

// The check sends the list's ETag. A 304 fetches nothing; a changed list
// fetches the manifests, and onFetch gets it (§7, §8.2). A manifest the
// server does not send makes each check fetch again.
func TestPollerChecksTheList(t *testing.T) {
	s := newServer(t)
	s.extra = ""
	results, _ := fetches(t, s, 10*time.Millisecond, time.Hour)
	next(t, results) // at start
	checks := func() []string {
		s.mu.Lock()
		defer s.mu.Unlock()
		return slices.Clone(s.checks)
	}
	waitFor(t, "three checks", func() bool { return len(checks()) >= 4 })
	if got := checks()[:4]; !slices.Equal(got, []string{"", `"v0"`, `"v0"`, `"v0"`}) {
		t.Errorf("If-None-Match of each request: %q", got)
	}
	select {
	case list := <-results:
		t.Fatalf("a 304 fetched %+v", list)
	default:
	}
	before := len(s.requests())

	// The server has no manifest for the new kit.
	s.mu.Lock()
	s.version++
	s.extra = `, {"kit": "bg1", "name": "Baldur's Gate", "manifest_version": "1.0.0", "adapter": null}`
	s.mu.Unlock()
	for i := range 2 {
		select {
		case list := <-results:
			if len(list) != 2 || list[1].Kit != "bg1" || list[1].Err == nil {
				t.Errorf("fetch %d: %+v", i, list)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no fetch %d after the list changed", i)
		}
	}
	if got := s.requests()[before:]; !slices.Contains(got, "/api/v1/kits/bg1/manifest") {
		t.Errorf("requests after the change: %q", got)
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
