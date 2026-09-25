package upload

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/watch"
)

// upload is one request the server read whole.
type upload struct {
	meta meta
	data []byte
	at   time.Time
}

// server is the ingest route (§8.3). By default it answers stored, or
// duplicate for the same bytes as the instance's last upload. refuse, when it
// is set, answers a request first; it may read the body or not.
type server struct {
	*httptest.Server
	t *testing.T

	mu       sync.Mutex
	refuse   func(n int, w http.ResponseWriter, r *http.Request) bool
	requests int
	uploads  []upload
	last     map[string]string
}

func newServer(t *testing.T) *server {
	t.Helper()
	s := &server{t: t, last: map[string]string{}}
	s.Server = httptest.NewServer(s)
	t.Cleanup(s.Close)
	return s
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/api/v1/ingest" {
		s.t.Errorf("%s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
		return
	}
	s.mu.Lock()
	s.requests++
	n, refuse := s.requests, s.refuse
	s.mu.Unlock()
	if refuse != nil && refuse(n, w, r) {
		return
	}
	up, err := read(r)
	if err != nil {
		s.t.Errorf("request %d: %v", n, err)
		reply(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.uploads = append(s.uploads, up)
	if s.last[up.meta.Instance] == up.meta.SHA256 {
		reply(w, http.StatusOK, "duplicate", "")
		return
	}
	s.last[up.meta.Instance] = up.meta.SHA256
	reply(w, http.StatusCreated, "stored", "")
}

// read reads an upload and checks it against §8.3: `meta` first, then the
// gzip-compressed file, whose SHA-256 is meta.sha256.
func read(r *http.Request) (upload, error) {
	up := upload{at: time.Now()}
	mr, err := r.MultipartReader()
	if err != nil {
		return up, err
	}
	part, err := mr.NextPart()
	if err != nil || part.FormName() != "meta" || part.FileName() != "" {
		return up, fmt.Errorf("the first part is not the meta field: %v", err)
	}
	if err := json.NewDecoder(part).Decode(&up.meta); err != nil {
		return up, err
	}
	part, err = mr.NextPart()
	if err != nil || part.FormName() != "file" || part.FileName() == "" {
		return up, fmt.Errorf("the second part is not the file: %v", err)
	}
	gz, err := gzip.NewReader(part)
	if err != nil {
		return up, err
	}
	if up.data, err = io.ReadAll(gz); err != nil {
		return up, err
	}
	if _, err := mr.NextPart(); err != io.EOF {
		return up, fmt.Errorf("a third part: %v", err)
	}
	sum := sha256.Sum256(up.data)
	if hex.EncodeToString(sum[:]) != up.meta.SHA256 {
		return up, fmt.Errorf("meta.sha256 is not the file's")
	}
	return up, nil
}

func reply(w http.ResponseWriter, code int, status, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"status": status, "message": message})
}

func (s *server) setRefuse(f func(n int, w http.ResponseWriter, r *http.Request) bool) {
	s.mu.Lock()
	s.refuse = f
	s.mu.Unlock()
}

func (s *server) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

func (s *server) got() []upload {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]upload(nil), s.uploads...)
}

// doer is auth.Client's side of a 401: it ends the login.
type doer struct{ c *http.Client }

func (d doer) Do(req *http.Request) (*http.Response, error) {
	res, err := d.c.Do(req)
	if err == nil && res.StatusCode == http.StatusUnauthorized {
		res.Body.Close()
		return nil, auth.ErrLoginRequired
	}
	return res, err
}

// start runs an Uploader against s with short delays.
func start(t *testing.T, s *server) *Uploader {
	t.Helper()
	u := New(s.URL, doer{s.Client()}, "0.1.0-test", 5<<20, nil)
	u.baseDelay = 10 * time.Millisecond
	u.maxDelay = 40 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		u.Run(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return u
}

// change writes data to name in dir and returns its change as the watcher
// reports it, for the instance named instance.
func change(t *testing.T, dir, name, instance string, data []byte) watch.Change {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(instance))
	return watch.Change{Kit: "wow", SourceID: "savedvariables", Instance: hex.EncodeToString(sum[:]), Path: path, ModTime: info.ModTime()}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// instance returns the status of the instance of c.
func instance(u *Uploader, c watch.Change) Instance {
	for _, in := range u.Status().Instances {
		if in.Instance == c.Instance {
			return in
		}
	}
	return Instance{}
}

func TestStoredThenDuplicate(t *testing.T) {
	s := newServer(t)
	u := start(t, s)
	u.CountError(LocateFailed)
	c := change(t, t.TempDir(), "OpenGamerMCP.lua", "WTF/Account/A/SavedVariables/OpenGamerMCP.lua", []byte("OpenGamerMCPDB = {}\n"))
	u.Add(c)
	waitFor(t, "the upload", func() bool { return !u.Status().LastUpload.IsZero() })
	u.Add(c)
	waitFor(t, "the second upload", func() bool { return len(s.got()) == 2 && !instance(u, c).Pending })

	got := s.got()
	m := got[0].meta
	if m.Kit != "wow" || m.SourceID != "savedvariables" || m.Instance != c.Instance || m.MTime != c.ModTime.UTC().Format(time.RFC3339) ||
		m.Client.BridgeVersion != "0.1.0-test" || m.Client.OS == "" || string(got[0].data) != "OpenGamerMCPDB = {}\n" {
		t.Errorf("first upload: %+v", got[0])
	}
	if m.Client.Errors[LocateFailed] != 1 || m.Client.Errors[UploadFailed] != 0 {
		t.Errorf("first upload's errors: %v", m.Client.Errors)
	}
	// The stored upload reset the counters.
	if got[1].meta.Client.Errors[LocateFailed] != 0 {
		t.Errorf("second upload's errors: %v", got[1].meta.Client.Errors)
	}
	if in := instance(u, c); in.Err != "" || in.Pending {
		t.Errorf("status: %+v", in)
	}
}

func TestRateLimitedHonorsRetryAfter(t *testing.T) {
	s := newServer(t)
	var refusedAt time.Time
	s.setRefuse(func(n int, w http.ResponseWriter, r *http.Request) bool {
		if n > 1 {
			return false
		}
		s.mu.Lock()
		refusedAt = time.Now()
		s.mu.Unlock()
		w.Header().Set("Retry-After", "1")
		reply(w, http.StatusTooManyRequests, "rate_limited", "Too many uploads of this file. Try again in 1 s.")
		return true
	})
	u := start(t, s)
	u.Add(change(t, t.TempDir(), "OpenGamerMCP.lua", "a", []byte("x")))
	waitFor(t, "the upload", func() bool { return len(s.got()) == 1 })
	s.mu.Lock()
	defer s.mu.Unlock()
	if wait := s.uploads[0].at.Sub(refusedAt); wait < time.Second {
		t.Errorf("tried again after %s", wait)
	}
}

func TestBrokenConnectionIsRetried(t *testing.T) {
	s := newServer(t)
	s.setRefuse(func(n int, w http.ResponseWriter, r *http.Request) bool {
		if n > 1 {
			return false
		}
		// The server closes the connection while the bridge still sends the
		// body, as after an early 429 or 413.
		io.CopyN(io.Discard, r.Body, 1024)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return true
		}
		conn.Close()
		return true
	})
	u := start(t, s)
	data := make([]byte, 2<<20)
	rand.NewChaCha8([32]byte{}).Read(data)
	u.Add(change(t, t.TempDir(), "OpenGamerMCP.lua", "a", data))
	waitFor(t, "the upload", func() bool { return len(s.got()) == 1 })
	up := s.got()[0]
	if !bytes.Equal(up.data, data) || up.meta.Client.Errors[UploadFailed] != 1 {
		t.Errorf("upload: %d bytes, errors %v", len(up.data), up.meta.Client.Errors)
	}
}

func TestLatestWinsWhileOffline(t *testing.T) {
	s := newServer(t)
	offline := func(n int, w http.ResponseWriter, r *http.Request) bool {
		w.WriteHeader(http.StatusServiceUnavailable)
		return true
	}
	s.setRefuse(offline)
	u := start(t, s)
	dir := t.TempDir()
	old := change(t, dir, "old.lua", "a", []byte("old"))
	u.Add(old)
	waitFor(t, "a failed attempt", func() bool { return s.count() >= 2 })
	latest := change(t, dir, "new.lua", "a", []byte("new"))
	u.Add(latest)
	if in := instance(u, latest); !in.Pending || in.Path != latest.Path {
		t.Errorf("status while offline: %+v", in)
	}
	waitFor(t, "the offline error", func() bool { return instance(u, latest).Err != "" })

	s.setRefuse(nil)
	waitFor(t, "the upload", func() bool { return !instance(u, latest).Pending })
	time.Sleep(100 * time.Millisecond)
	got := s.got()
	if len(got) != 1 || string(got[0].data) != "new" || got[0].meta.Client.Errors[UploadFailed] == 0 {
		t.Fatalf("uploads after the server came back: %+v", got)
	}
	if in := instance(u, latest); in.Err != "" {
		t.Errorf("error after the upload: %q", in.Err)
	}
}

func TestLoginRequiredStops(t *testing.T) {
	s := newServer(t)
	s.setRefuse(func(n int, w http.ResponseWriter, r *http.Request) bool {
		w.WriteHeader(http.StatusUnauthorized)
		return true
	})
	u := start(t, s)
	c := change(t, t.TempDir(), "OpenGamerMCP.lua", "a", []byte("x"))
	u.Add(c)
	waitFor(t, "the refused login", func() bool { return u.Status().LoginRequired })
	u.Add(c)
	time.Sleep(100 * time.Millisecond)
	if n := s.count(); n != 1 {
		t.Fatalf("%d requests after the login ended", n)
	}

	// A new login.
	s.setRefuse(nil)
	u.Resume()
	waitFor(t, "the upload", func() bool { return len(s.got()) == 1 })
	if u.Status().LoginRequired {
		t.Error("still LoginRequired")
	}
}

func TestDeviceLimitStopsThatInstanceOnly(t *testing.T) {
	s := newServer(t)
	dir := t.TempDir()
	held := change(t, dir, "a.lua", "a", []byte("a"))
	other := change(t, dir, "b.lua", "b", []byte("b"))
	const msg = "Another device holds this account's upload slot. Revoke it on the Devices page to use this one."
	s.setRefuse(func(n int, w http.ResponseWriter, r *http.Request) bool {
		up, err := read(r)
		switch {
		case err != nil:
			t.Error(err)
			reply(w, http.StatusBadRequest, "bad_request", err.Error())
		case up.meta.Instance == held.Instance:
			reply(w, http.StatusForbidden, "device_limit", msg)
		default:
			reply(w, http.StatusCreated, "stored", "")
		}
		return true
	})
	u := start(t, s)
	u.Add(held)
	waitFor(t, "device_limit", func() bool { return instance(u, held).Stopped })
	u.Add(other)
	u.Add(held)
	waitFor(t, "the other instance's upload", func() bool { return !instance(u, other).Pending })
	time.Sleep(100 * time.Millisecond)
	if n := s.count(); n != 2 {
		t.Errorf("%d requests", n)
	}
	if in := instance(u, held); in.Err != msg || !in.Pending {
		t.Errorf("stopped instance: %+v", in)
	}
	if in := instance(u, other); in.Err != "" || u.Status().LastUpload.IsZero() {
		t.Errorf("other instance: %+v", in)
	}
}
