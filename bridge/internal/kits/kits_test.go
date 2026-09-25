package kits

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// server is the bridge API's kit routes. It serves the WoW kit's manifest,
// read from the repo, and lists a kit it has no manifest for and a kit with
// an invalid name.
type server struct {
	*httptest.Server
	manifest []byte

	mu    sync.Mutex
	paths []string
}

func newServer(t *testing.T) *server {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "kits", "wow", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	s := &server{manifest: raw}
	s.Server = httptest.NewServer(s)
	t.Cleanup(s.Close)
	return s
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.paths = append(s.paths, r.URL.Path)
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/v1/kits":
		w.Write([]byte(`{"kits": [
			{"kit": "wow", "manifest_version": "0.1.0", "adapter": {"version": "0.1.0", "sha256": "` + zeros + `"}},
			{"kit": "gone", "manifest_version": "1.0.0", "adapter": null},
			{"kit": "../admin", "manifest_version": "1.0.0", "adapter": null}
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

// fetches runs a Poller and returns a channel of its results, and the Poller.
func fetches(t *testing.T, interval time.Duration) (<-chan []Kit, *Poller) {
	t.Helper()
	s := newServer(t)
	results := make(chan []Kit, 16)
	p := NewPoller(New(s.URL, s.Client()), interval, func(list []Kit, err error) {
		if err != nil {
			t.Error(err)
		}
		select {
		case results <- list:
		default: // the test has what it needs
		}
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
	results, _ := fetches(t, 10*time.Millisecond)
	for range 3 {
		next(t, results)
	}
}

func TestPollerFetchesWhenWoken(t *testing.T) {
	results, p := fetches(t, time.Hour)
	next(t, results) // at start
	p.Wake()         // as after a login
	next(t, results)
}
