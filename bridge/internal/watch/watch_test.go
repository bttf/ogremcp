package watch

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/manifest"
)

// The watcher runs on a fake clock: its timers fire only when a test advances
// the clock. File events are real, and the tests wait for the watcher to
// report them rather than sleep.
const (
	debounce = 2 * time.Second
	interval = 5 * time.Minute
	// guard bounds every wait. Reaching it is a failure, not a timing.
	guard = 10 * time.Second
)

// fakeClock fires timers when Advance moves it past their time.
type fakeClock struct {
	mu     sync.Mutex
	now    time.Duration
	timers []*fakeTimer
}

type fakeTimer struct {
	clock *fakeClock
	at    time.Duration
	f     func()
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{clock: c, at: c.now + d, f: f}
	c.timers = append(c.timers, t)
	return t
}

func (t *fakeTimer) Stop() bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	i := slices.Index(c.timers, t)
	if i < 0 {
		return false
	}
	c.timers = slices.Delete(c.timers, i, i+1)
	return true
}

// Advance moves the clock forward and fires what is due, in order of time, on
// the calling goroutine. A timer hands what fired to the event loop, so when
// Advance returns the loop has taken it, but may not have handled it.
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now += d
	var due []*fakeTimer
	c.timers = slices.DeleteFunc(c.timers, func(t *fakeTimer) bool {
		if t.at <= c.now {
			due = append(due, t)
			return true
		}
		return false
	})
	c.mu.Unlock()
	slices.SortStableFunc(due, func(a, b *fakeTimer) int { return cmp.Compare(a.at, b.at) })
	for _, t := range due {
		t.f()
	}
}

// harness runs a watcher and records its changes and trace.
type harness struct {
	t       *testing.T
	w       *Watcher
	clock   *fakeClock
	changes chan Change

	mu     sync.Mutex
	traces []string
	from   int // waitTrace looks at traces from here on
}

const sourcePath = "_*_/WTF/Account/*/SavedVariables/OpenGamerMCP.lua"

func start(t *testing.T, root string) *harness {
	t.Helper()
	h := &harness{t: t, clock: &fakeClock{}, changes: make(chan Change, 100)}
	h.w = New(debounce, interval, slog.New(slog.DiscardHandler), func(c Change) { h.changes <- c })
	h.w.clock = h.clock
	h.w.trace = h.record
	h.w.probe = make(chan func())
	h.w.SetKits([]Kit{{
		Kit:  "wow",
		Root: root,
		Sources: []manifest.Source{{
			ID: "savedvariables", Type: "file", Format: "text", Path: sourcePath, Trigger: "on_change",
		}},
	}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.w.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Run: %v", err)
		}
	})
	h.sync()
	return h
}

func (h *harness) record(line string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.traces = append(h.traces, line)
}

// mark starts a step: later waits look only at what the watcher does from
// now on.
func (h *harness) mark() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.from = len(h.traces)
}

// waitTrace waits for the trace line want since the last mark.
func (h *harness) waitTrace(want string) {
	h.t.Helper()
	deadline := time.Now().Add(guard)
	for {
		h.mu.Lock()
		found := slices.Contains(h.traces[h.from:], want)
		all := strings.Join(h.traces, "\n")
		h.mu.Unlock()
		if found {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("no trace %q; traces:\n%s", want, all)
		}
		time.Sleep(time.Millisecond)
	}
}

// advance moves the clock forward and waits until the event loop has handled
// what fired.
func (h *harness) advance(d time.Duration) {
	h.clock.Advance(d)
	h.sync()
}

// sync waits until the event loop has finished what it was doing.
func (h *harness) sync() {
	done := make(chan struct{})
	h.w.probe <- func() { close(done) }
	<-done
}

// seen waits until the watcher has scheduled path, a file in dir, since the
// last mark, and has handled every event of the change. One change can give
// several events, and kqueue may report them after the event of a later
// change in the folder. Once the first event is in, the event of a write to
// another file comes after the rest.
func (h *harness) seen(dir, path string) {
	h.t.Helper()
	h.waitTrace("schedule " + path)
	barrier := filepath.Join(dir, fmt.Sprintf("barrier-%d", time.Now().UnixNano()))
	h.mark()
	write(h.t, barrier, "")
	h.waitTrace("ignore " + barrier)
}

// next returns the next change.
func (h *harness) next() Change {
	h.t.Helper()
	select {
	case c := <-h.changes:
		return c
	case <-time.After(guard):
		h.mu.Lock()
		defer h.mu.Unlock()
		h.t.Fatalf("no change; traces:\n%s", strings.Join(h.traces, "\n"))
		return Change{}
	}
}

// none checks that the watcher has reported no change the test did not take.
func (h *harness) none() {
	h.t.Helper()
	h.sync()
	select {
	case c := <-h.changes:
		h.t.Fatalf("unexpected change %+v", c)
	default:
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func savedVariables(root, flavor, account string) string {
	return filepath.Join(root, flavor, "WTF", "Account", account, "SavedVariables")
}

func TestReplaceOnSave(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	dir := savedVariables(root, "_classic_era_", "ACCOUNT1")
	path := filepath.Join(dir, "OpenGamerMCP.lua")
	write(t, path, "v1")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	// Every instance counts as changed at start.
	h := start(t, root)
	h.advance(debounce)
	sum := sha256.Sum256([]byte("_classic_era_/WTF/Account/ACCOUNT1/SavedVariables/OpenGamerMCP.lua"))
	want := Change{
		Kit:      "wow",
		SourceID: "savedvariables",
		Instance: hex.EncodeToString(sum[:]),
		Path:     path,
		ModTime:  info.ModTime(),
	}
	if got := h.next(); got != want {
		t.Errorf("change = %+v, want %+v", got, want)
	}
	h.none()

	// The game writes a temporary file and renames it over the old one. Twice,
	// to show that the watch outlives the first replacement.
	for i := range 2 {
		h.mark()
		tmp := filepath.Join(dir, "OpenGamerMCP.lua.tmp")
		write(t, tmp, fmt.Sprint("v", i+2))
		if err := os.Rename(tmp, path); err != nil {
			t.Fatal(err)
		}
		h.seen(dir, path)
		h.advance(debounce)
		if got := h.next(); got.Instance != want.Instance || got.Path != path {
			t.Errorf("replacement %d: change = %+v", i+1, got)
		}
		h.none()
	}
}

func TestBurstOfWritesIsOneChange(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	dir := savedVariables(root, "_classic_era_", "ACCOUNT1")
	path := filepath.Join(dir, "OpenGamerMCP.lua")
	write(t, path, "v1")
	h := start(t, root)
	h.advance(debounce)
	h.next()

	// Each write restarts the debounce.
	for i := range 3 {
		h.mark()
		write(t, path, fmt.Sprint("v", i+2))
		h.seen(dir, path)
		h.advance(debounce / 2)
	}
	h.none()
	h.advance(debounce / 2)
	if got := h.next(); got.Path != path {
		t.Errorf("change = %+v", got)
	}
	h.none()
}

func TestOtherFilesAreIgnored(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	dir := savedVariables(root, "_classic_era_", "ACCOUNT1")
	write(t, filepath.Join(dir, "OpenGamerMCP.lua"), "v1")
	h := start(t, root)
	h.advance(debounce)
	h.next()

	h.mark()
	for _, name := range []string{"OpenGamerMCP.lua.bak", "OtherAddon.lua"} {
		write(t, filepath.Join(dir, name), "x")
		h.waitTrace("ignore " + filepath.Join(dir, name))
	}
	h.advance(debounce)
	h.none()
}

func TestRescanFindsNewFolders(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	h := start(t, root)

	// A flavor folder and an account appear while the bridge runs, with the
	// file already written.
	dir := savedVariables(root, "_classic_era_", "ACCOUNT2")
	path := filepath.Join(dir, "OpenGamerMCP.lua")
	write(t, path, "v1")
	h.advance(interval)
	h.advance(debounce)
	if got := h.next(); got.Path != path {
		t.Errorf("change = %+v", got)
	}
	h.none()

	// The account goes away, and so does its watch.
	if err := os.RemoveAll(filepath.Join(root, "_classic_era_")); err != nil {
		t.Fatal(err)
	}
	h.advance(interval)
	watched := make(chan []string)
	h.w.probe <- func() { watched <- h.w.fsw.WatchList() }
	if got := <-watched; len(got) != 0 {
		t.Errorf("still watching %q", got)
	}
}
