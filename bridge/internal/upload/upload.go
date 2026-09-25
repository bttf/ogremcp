// Package upload uploads the settled changes of source instances to the
// platform's ingest route (docs/architecture.md §7, §8.3).
//
// # Uploads
//
// The watcher (package watch) hands each settled change to Add. Run uploads
// the changes one at a time. For each attempt it reads the instance's file
// once, up to the upload cap (§8.3, 5 MB of uncompressed bytes; package
// config), and sends POST /api/v1/ingest as multipart/form-data: the `meta`
// part first, and then the file, gzip-compressed, as the `file` part. The
// server checks its rate limit as soon as `meta` arrives, and reads no more
// of a request it refuses. A file over the cap is not sent; it counts as a
// too_large answer. An attempt's deadline is 30 s plus the body's time at
// 16 KB/s, so a large file on a slow uplink can finish.
//
// # Offline
//
// Each instance has at most one pending upload: its latest change (§7). A
// change that arrives while another is pending or in flight replaces it, and
// is uploaded once the attempt in flight ends. There is never a backlog. An
// attempt that gets no §8.3 answer is tried again after a backoff that
// doubles up to a cap, with jitter: a network error, a 5xx, or an error
// while the body is sent, since the server may answer a 413 or 429 and close
// the connection before it reads the whole body. A 429 waits at least its
// Retry-After. A new change keeps the wait of the change it replaces.
//
// # Answers
//
//   - stored, duplicate: the server holds the file's bytes. Status's
//     LastUpload is set, and the instance's error is cleared.
//   - parse_error, unsupported_flavor, too_large, bad_request: the server
//     refuses these bytes. They are not sent again; the next change is. The
//     message becomes the instance's error.
//   - device_limit: the free tier's upload slot is another device's (§8.3,
//     §14). The instance stops until Resume, which the caller calls after a
//     login; a new start also clears it. Its latest change stays pending.
//   - 401: package auth ends the login and returns auth.ErrLoginRequired.
//     Every upload stops until Resume, and Status's LoginRequired is set.
//
// Each instance's error is logged once, when it changes (§7). Status reports
// it for the tray.
//
// # Error counters
//
// meta.client.errors counts the bridge's errors since the last upload the
// server kept as a row, which holds the counts (§8.3, §16.1): stored,
// parse_error, or unsupported_flavor. CountError adds one. A duplicate or a
// refusal keeps no row, so it does not reset them.
//
// The backoff and the Retry-After reading are adapted from
// bttf/wow-guide@df80260, bridge/internal/ingest/ingest.go, and the retry
// delay per file from its delivery loop, bridge/internal/app/app.go. The
// prototype sent batches of records; this sends one file per instance.
package upload

import (
	"cmp"
	"context"
	"log/slog"
	"math"
	"math/rand/v2"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/bttf/ogremcp/bridge/internal/watch"
)

// The names of the error counters (§8.3 meta.client.errors, §16.1).
const (
	// LocateFailed counts the times a kit's game folder was not found.
	LocateFailed = "locate_failed"
	// ReadFailed counts the attempts that could not read an instance's file.
	ReadFailed = "read_failed"
	// UploadFailed counts the attempts that got no §8.3 answer.
	UploadFailed = "upload_failed"
)

// Delays of the retries.
const (
	baseDelay = 2 * time.Second
	// maxDelay caps the backoff.
	maxDelay = 10 * time.Minute
	// maxRetryAfter caps a Retry-After the server sends.
	maxRetryAfter = 10 * time.Minute
)

// An attempt's deadline is attemptBase, plus the body's time at attemptRate
// bytes per second, a slow uplink.
const (
	attemptBase = 30 * time.Second
	attemptRate = 16 << 10
)

// Doer sends an upload to the bridge API with an access token, bounded by
// the request's context only. It is an *auth.Client, which returns
// auth.ErrLoginRequired when the server refuses the login.
type Doer interface {
	DoUpload(req *http.Request) (*http.Response, error)
}

// Status is what the tray shows (§7).
type Status struct {
	// LastUpload is when the server last answered stored or duplicate, or
	// zero.
	LastUpload time.Time
	// LoginRequired means the server refused the login. Uploads wait for a
	// new login and Resume.
	LoginRequired bool
	// Instances are the instances the uploader has had a change of, by kit,
	// source, and path.
	Instances []Instance
}

// Instance is the status of one source instance.
type Instance struct {
	Kit      string
	SourceID string
	// Instance is the instance's ID (watch.Change).
	Instance string
	// Path is the file's full path. It stays on this device.
	Path string
	// Pending means an upload of the latest change waits: for a retry, for
	// Resume, or for its turn.
	Pending bool
	// Stopped means the server answered device_limit. The instance waits
	// for Resume.
	Stopped bool
	// Err is the latest error, a sentence for the user, or "" since the last
	// upload the server took.
	Err string
	// ErrAt is when Err last changed.
	ErrAt time.Time
}

// Uploader uploads the changes of source instances. Make one with New.
type Uploader struct {
	url      string
	api      Doer
	version  string
	maxBytes int64
	log      *slog.Logger

	// Tests set these.
	baseDelay     time.Duration
	maxDelay      time.Duration
	maxRetryAfter time.Duration
	attemptBase   time.Duration
	attemptRate   int
	jitter        func() float64
	now           func() time.Time

	wake    chan struct{}
	changed chan struct{}

	mu            sync.Mutex
	entries       map[key]*entry
	counts        map[string]int
	lastUpload    time.Time
	loginRequired bool
}

// key names one instance.
type key struct{ kit, source, instance string }

// entry is the state of one instance.
type entry struct {
	// change is the latest change. seq counts the changes, so an attempt
	// knows whether a newer one arrived while it ran.
	change  watch.Change
	seq     uint64
	pending bool
	// failures counts the attempts in a row that will be tried again.
	failures int
	// due is when the next attempt may start.
	due     time.Time
	stopped bool
	err     string
	errAt   time.Time
}

// New returns an Uploader for the server at base, the base URL api holds
// tokens for. version is the bridge's version, sent in meta. maxBytes is the
// upload cap, in uncompressed bytes. log gets the uploads and the errors;
// nil means slog.Default().
func New(base string, api Doer, version string, maxBytes int64, log *slog.Logger) *Uploader {
	if log == nil {
		log = slog.Default()
	}
	return &Uploader{
		url:           base + "/api/v1/ingest",
		api:           api,
		version:       version,
		maxBytes:      maxBytes,
		log:           log,
		baseDelay:     baseDelay,
		maxDelay:      maxDelay,
		maxRetryAfter: maxRetryAfter,
		attemptBase:   attemptBase,
		attemptRate:   attemptRate,
		jitter:        rand.Float64,
		now:           time.Now,
		wake:          make(chan struct{}, 1),
		changed:       make(chan struct{}, 1),
		entries:       map[key]*entry{},
		counts:        map[string]int{LocateFailed: 0, ReadFailed: 0, UploadFailed: 0},
	}
}

// Add makes c the pending upload of its instance, in place of any other. It
// does not block: it is the watcher's onChange.
func (u *Uploader) Add(c watch.Change) {
	u.mu.Lock()
	k := key{c.Kit, c.SourceID, c.Instance}
	e := u.entries[k]
	if e == nil {
		e = &entry{}
		u.entries[k] = e
	}
	e.change = c
	e.seq++
	e.pending = true
	u.mu.Unlock()
	signal(u.wake)
	signal(u.changed)
}

// CountError adds one to the error counter name, such as LocateFailed.
func (u *Uploader) CountError(name string) {
	u.mu.Lock()
	u.counts[name]++
	u.mu.Unlock()
}

// Resume starts the uploads again after a login: those that waited for the
// login, and those of the instances stopped by device_limit.
func (u *Uploader) Resume() {
	u.mu.Lock()
	u.loginRequired = false
	for _, e := range u.entries {
		if e.stopped {
			e.stopped = false
			e.due = time.Time{}
		}
	}
	u.mu.Unlock()
	signal(u.wake)
	signal(u.changed)
}

// Changed receives when the status may have changed. It holds one signal at
// most; read Status after each.
func (u *Uploader) Changed() <-chan struct{} {
	return u.changed
}

// Status returns the current status.
func (u *Uploader) Status() Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	s := Status{LastUpload: u.lastUpload, LoginRequired: u.loginRequired}
	for k, e := range u.entries {
		s.Instances = append(s.Instances, Instance{
			Kit:      k.kit,
			SourceID: k.source,
			Instance: k.instance,
			Path:     e.change.Path,
			Pending:  e.pending,
			Stopped:  e.stopped,
			Err:      e.err,
			ErrAt:    e.errAt,
		})
	}
	slices.SortFunc(s.Instances, func(a, b Instance) int {
		return cmp.Or(cmp.Compare(a.Kit, b.Kit), cmp.Compare(a.SourceID, b.SourceID), cmp.Compare(a.Path, b.Path))
	})
	return s
}

// Run uploads the pending changes, one at a time, until ctx ends. Call it
// once.
func (u *Uploader) Run(ctx context.Context) {
	for {
		k, c, seq, counts, wait := u.next()
		if wait == 0 {
			res := u.attempt(ctx, c, counts)
			if ctx.Err() != nil {
				return
			}
			u.finish(k, seq, counts, res)
			continue
		}
		var timer *time.Timer
		var timeout <-chan time.Time
		if wait > 0 {
			timer = time.NewTimer(wait)
			timeout = timer.C
		}
		select {
		case <-ctx.Done():
		case <-u.wake:
		case <-timeout:
		}
		if timer != nil {
			timer.Stop()
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// next returns the instance to upload now, with its change, the change's
// seq, and the error counts to send, and a wait of 0. With none to upload
// now, it returns how long until the next one is due, or -1 when none is.
func (u *Uploader) next() (key, watch.Change, uint64, map[string]int, time.Duration) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.loginRequired {
		return key{}, watch.Change{}, 0, nil, -1
	}
	now := u.now()
	var best key
	var first *entry
	for k, e := range u.entries {
		if e.pending && !e.stopped && (first == nil || e.due.Before(first.due)) {
			best, first = k, e
		}
	}
	if first == nil {
		return key{}, watch.Change{}, 0, nil, -1
	}
	if wait := first.due.Sub(now); wait > 0 {
		return key{}, watch.Change{}, 0, nil, wait
	}
	counts := make(map[string]int, len(u.counts))
	for name, n := range u.counts {
		counts[name] = min(n, math.MaxInt32)
	}
	return best, first.change, first.seq, counts, 0
}

// finish records the result of an attempt that sent change seq of instance
// k with the error counts sent.
func (u *Uploader) finish(k key, seq uint64, sent map[string]int, res result) {
	u.mu.Lock()
	defer u.mu.Unlock()
	defer signal(u.changed)
	e := u.entries[k]
	now := u.now()
	if keptRow(res.status) {
		for name, n := range sent {
			u.counts[name] -= n
		}
	}
	settled := true
	switch res.action {
	case taken:
		u.lastUpload = now
		u.log.Info("uploaded", u.attrs(k, "status", res.status)...)
		u.setErr(k, e, "", now)
	case refused:
		u.setErr(k, e, res.message, now)
	case gone:
	case retry:
		settled = false
		e.failures++
		e.due = now.Add(max(u.backoff(e.failures), res.retryAfter))
		if res.counter != "" {
			u.counts[res.counter]++
		}
		u.log.Debug("upload failed; trying again", u.attrs(k, "status", res.status, "wait", e.due.Sub(now).Round(time.Millisecond).String(), "error", res.detail)...)
		if res.message != "" {
			u.setErr(k, e, res.message, now)
		}
	case stop:
		settled = false
		e.stopped = true
		e.failures = 0
		u.setErr(k, e, res.message, now)
	case login:
		settled = false
		if !u.loginRequired {
			u.log.Warn("the server refused the login; uploads wait for a new login")
		}
		u.loginRequired = true
	}
	if settled {
		e.failures = 0
		e.due = time.Time{}
		if e.seq == seq {
			e.pending = false
		}
	}
}

// keptRow reports whether the server kept an upload with status as a row,
// with its meta.client.errors (§8.3).
func keptRow(status string) bool {
	return status == "stored" || status == "parse_error" || status == "unsupported_flavor"
}

// setErr sets the error of an instance, and logs a new one.
func (u *Uploader) setErr(k key, e *entry, msg string, now time.Time) {
	if e.err == msg {
		return
	}
	e.err, e.errAt = msg, now
	if msg != "" {
		u.log.Warn(msg, u.attrs(k)...)
	}
}

// attrs are the log attributes of an instance. A short ID names it, not its
// path.
func (u *Uploader) attrs(k key, args ...any) []any {
	return append([]any{"kit", k.kit, "source", k.source, "instance", k.instance[:min(12, len(k.instance))]}, args...)
}

// backoff is baseDelay doubled per failure, capped at maxDelay, with the
// upper half jittered.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/ingest/ingest.go:258-269.
func (u *Uploader) backoff(failures int) time.Duration {
	d := u.baseDelay
	for i := 1; i < failures && d < u.maxDelay; i++ {
		d *= 2
	}
	d = min(d, u.maxDelay)
	return d/2 + time.Duration(u.jitter()*float64(d/2))
}

// signal sends on a channel of capacity 1 without blocking.
func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}
