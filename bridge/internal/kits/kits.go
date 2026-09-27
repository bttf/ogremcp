// Package kits fetches the user's enabled kits and their manifests from the
// platform's bridge API (docs/architecture.md §7, §8.2).
//
// Fetch asks GET /api/v1/kits for the enabled kits, and then GET
// /api/v1/kits/{kit}/manifest for each. Poller runs a fetch at start, on Sync,
// and every refresh interval (§7, proposed 5 min; package config). Between
// those, it checks the list every kit check interval (§7, proposed 60 s), and
// when woken, as after a login: it sends the list's ETag in If-None-Match, the
// server answers 304 while the list is the same (§8.2), and a changed list
// makes it fetch the manifests. So a game enabled on the website reaches the
// bridge within about a minute.
package kits

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"time"

	"github.com/bttf/ogremcp/bridge/internal/auth"
	"github.com/bttf/ogremcp/bridge/internal/manifest"
)

// maxBody is the largest answer the bridge reads from the kit routes.
const maxBody = 1 << 20

// Doer sends a request to the bridge API with an access token. It is an
// *auth.Client.
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Entry is one kit of GET /api/v1/kits.
type Entry struct {
	// Kit is the manifest's kit, such as "wow".
	Kit string `json:"kit"`
	// Name is the kit's display name, such as "World of Warcraft", or "" from
	// a server that sends none. The manifest has none.
	Name string `json:"name"`
	// ManifestVersion is the manifest's version.
	ManifestVersion string `json:"manifest_version"`
	// Adapter is nil for a kit without an adapter.
	Adapter *Adapter `json:"adapter"`
}

// Adapter is the adapter zip the platform serves for a kit.
type Adapter struct {
	// Version is the adapter's version (§8.2).
	Version string `json:"version"`
	// SHA256 is the zip's SHA-256, as lower-case hex.
	SHA256 string `json:"sha256"`
}

// Kit is an enabled kit and its manifest, or the error that kept the bridge
// from getting the manifest.
type Kit struct {
	Entry
	Manifest *manifest.Manifest
	Err      error
}

// Client reads the kit routes of the bridge API.
type Client struct {
	base string
	api  Doer
}

// New returns a Client for the server at base, the base URL api holds tokens
// for.
func New(base string, api Doer) *Client {
	return &Client{base: base, api: api}
}

// Fetch returns the user's enabled kits, each with its manifest or the error
// that kept the bridge from getting it. It fails as a whole when the list
// fails, when the login ends, or when ctx ends.
func (c *Client) Fetch(ctx context.Context) ([]Kit, error) {
	entries, err := c.List(ctx)
	if err != nil {
		return nil, err
	}
	return c.manifests(ctx, entries)
}

// manifests returns the kits of entries, each with its manifest or the error
// that kept the bridge from getting it. It fails as a whole when the login
// ends or when ctx ends.
func (c *Client) manifests(ctx context.Context, entries []Entry) ([]Kit, error) {
	list := make([]Kit, len(entries))
	for i, e := range entries {
		m, err := c.Manifest(ctx, e.Kit)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, auth.ErrLoginRequired) {
			return nil, err
		}
		list[i] = Kit{Entry: e, Manifest: m, Err: err}
	}
	return list, nil
}

// List returns the user's enabled kits.
func (c *Client) List(ctx context.Context) ([]Entry, error) {
	entries, _, err := c.list(ctx, "")
	return entries, err
}

// errNotModified means the server answered 304: the list is the one whose
// ETag the bridge sent.
var errNotModified = errors.New("the list of kits has not changed")

// list returns the user's enabled kits and the list's ETag, or "" when the
// server sends none. With etag not "", it sends If-None-Match, and fails with
// errNotModified when the list has not changed.
func (c *Client) list(ctx context.Context, etag string) ([]Entry, string, error) {
	raw, tag, err := c.get(ctx, "/api/v1/kits", etag)
	if err != nil {
		return nil, "", err
	}
	var list struct {
		Kits []Entry `json:"kits"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, "", fmt.Errorf("could not read the list of kits: %w", err)
	}
	return list.Kits, tag, nil
}

// Manifest returns the manifest of kit, checked (manifest.Parse).
func (c *Client) Manifest(ctx context.Context, kit string) (*manifest.Manifest, error) {
	if !manifest.ValidKit(kit) {
		return nil, fmt.Errorf("the server listed a kit named %q, which is not a valid kit name", kit)
	}
	raw, _, err := c.get(ctx, "/api/v1/kits/"+kit+"/manifest", "")
	if err != nil {
		return nil, err
	}
	m, err := manifest.Parse(raw)
	if err != nil {
		return nil, err
	}
	if m.Kit != kit {
		return nil, fmt.Errorf("the server sent the manifest of kit %q for kit %q", m.Kit, kit)
	}
	return m, nil
}

// get returns the body of a 200 answer to GET path, and its ETag. With etag
// not "", it sends If-None-Match, and fails with errNotModified on a 304.
func (c *Client) get(ctx context.Context, path, etag string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept", "application/json")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	res, err := c.api.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer res.Body.Close()
	if etag != "" && res.StatusCode == http.StatusNotModified {
		return nil, "", errNotModified
	}
	if res.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("the server answered %s with status %d", path, res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return nil, "", fmt.Errorf("could not read the server's answer to %s: %w", path, err)
	}
	if len(raw) > maxBody {
		return nil, "", fmt.Errorf("the server's answer to %s is over %d bytes", path, maxBody)
	}
	return raw, res.Header.Get("ETag"), nil
}

// Poller fetches the kits at start, on Sync, and every interval, and checks
// the list every check interval and when woken. Make one with NewPoller.
type Poller struct {
	client   *Client
	check    time.Duration
	interval time.Duration
	onFetch  func([]Kit, error) bool
	wake     chan struct{}
	sync     chan struct{}

	// Run's goroutine owns the rest. etag is the ETag of entries, the list
	// of the last fetch. known is true after a fetch that had every
	// manifest and that onFetch finished; a check sends If-None-Match only
	// then.
	etag    string
	entries []Entry
	known   bool
}

// NewPoller returns a Poller that fetches from c every interval, checks the
// list every check, and passes each fetch's result to onFetch. onFetch
// returns false when it could not finish with the kits, as when an adapter
// download failed: the next check then fetches again.
func NewPoller(c *Client, check, interval time.Duration, onFetch func([]Kit, error) bool) *Poller {
	return &Poller{
		client:   c,
		check:    check,
		interval: interval,
		onFetch:  onFetch,
		wake:     make(chan struct{}, 1),
		sync:     make(chan struct{}, 1),
	}
}

// Wake makes Run check the list now, as after a login. It does not block.
func (p *Poller) Wake() {
	signal(p.wake)
}

// Sync makes Run fetch now, without If-None-Match, as the tray's Sync with
// server does (§7). It does not block.
func (p *Poller) Sync() {
	signal(p.sync)
}

// Run fetches at once, then after each interval and on each Sync, and checks
// the list after each check interval and on each Wake, until ctx ends. A
// check that finds the list changed goes on as a fetch. Run calls onFetch
// after each fetch, on Run's goroutine; a check that finds the list the same
// calls nothing.
func (p *Poller) Run(ctx context.Context) {
	check := time.NewTimer(p.check)
	defer check.Stop()
	full := time.NewTimer(p.interval)
	defer full.Stop()
	p.poll(ctx, false)
	for ctx.Err() == nil {
		conditional := true
		select {
		case <-ctx.Done():
			return
		case <-check.C:
		case <-p.wake:
		case <-full.C:
			conditional = false
		case <-p.sync:
			conditional = false
		}
		if !conditional {
			full.Reset(p.interval)
		}
		p.poll(ctx, conditional)
		check.Reset(p.check)
	}
}

// poll fetches the kits and passes them to onFetch. When conditional, it
// sends the ETag of the last list, and stops when the server answers 304 or
// the list is the same.
func (p *Poller) poll(ctx context.Context, conditional bool) {
	conditional = conditional && p.known
	etag := ""
	if conditional {
		etag = p.etag
	}
	entries, tag, err := p.client.list(ctx, etag)
	if errors.Is(err, errNotModified) {
		return
	}
	if err == nil && conditional && slices.EqualFunc(entries, p.entries, sameEntry) {
		// A server that sends no ETag, or a new one for the same list.
		p.etag = tag
		return
	}
	var list []Kit
	if err == nil {
		list, err = p.client.manifests(ctx, entries)
	}
	if ctx.Err() != nil {
		return
	}
	done := p.onFetch(list, err)
	// After a failure, a manifest the server did not send, or a fetch that
	// onFetch could not finish, the next check fetches again, and does not
	// wait for the list to change.
	p.etag, p.entries = tag, entries
	p.known = err == nil && done && !slices.ContainsFunc(list, func(k Kit) bool { return k.Err != nil })
}

// sameEntry reports whether a and b list the same kit, manifest, and
// adapter.
func sameEntry(a, b Entry) bool {
	if a.Kit != b.Kit || a.Name != b.Name || a.ManifestVersion != b.ManifestVersion || (a.Adapter == nil) != (b.Adapter == nil) {
		return false
	}
	return a.Adapter == nil || *a.Adapter == *b.Adapter
}

// signal sends on a channel of capacity 1 without blocking.
func signal(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}
