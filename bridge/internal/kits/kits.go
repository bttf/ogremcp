// Package kits fetches the user's enabled kits and their manifests from the
// platform's bridge API (docs/architecture.md §7, §8.2).
//
// Fetch asks GET /api/v1/kits for the enabled kits, and then GET
// /api/v1/kits/{kit}/manifest for each. Poller runs Fetch at start, when woken
// (the caller wakes it after each login), and every refresh interval (§7,
// proposed 5 min; package config).
package kits

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/manifest"
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
	raw, err := c.get(ctx, "/api/v1/kits")
	if err != nil {
		return nil, err
	}
	var list struct {
		Kits []Entry `json:"kits"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("could not read the list of kits: %w", err)
	}
	return list.Kits, nil
}

// Manifest returns the manifest of kit, checked (manifest.Parse).
func (c *Client) Manifest(ctx context.Context, kit string) (*manifest.Manifest, error) {
	if !manifest.ValidKit(kit) {
		return nil, fmt.Errorf("the server listed a kit named %q, which is not a valid kit name", kit)
	}
	raw, err := c.get(ctx, "/api/v1/kits/"+kit+"/manifest")
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

// get returns the body of a 200 answer to GET path.
func (c *Client) get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.api.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the server answered %s with status %d", path, res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("could not read the server's answer to %s: %w", path, err)
	}
	if len(raw) > maxBody {
		return nil, fmt.Errorf("the server's answer to %s is over %d bytes", path, maxBody)
	}
	return raw, nil
}

// Poller runs Fetch at start, when woken, and every interval.
type Poller struct {
	client   *Client
	interval time.Duration
	onFetch  func([]Kit, error)
	wake     chan struct{}
}

// NewPoller returns a Poller that fetches from c every interval and passes
// each result to onFetch.
func NewPoller(c *Client, interval time.Duration, onFetch func([]Kit, error)) *Poller {
	return &Poller{client: c, interval: interval, onFetch: onFetch, wake: make(chan struct{}, 1)}
}

// Wake makes Run fetch now, as after a login, and start the interval again.
// It does not block.
func (p *Poller) Wake() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// Run fetches at once, then after each interval and on each Wake, until ctx
// ends. It calls onFetch after each fetch, on Run's goroutine.
func (p *Poller) Run(ctx context.Context) {
	for {
		list, err := p.client.Fetch(ctx)
		if ctx.Err() != nil {
			return
		}
		p.onFetch(list, err)
		timer := time.NewTimer(p.interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-p.wake:
			timer.Stop()
		}
	}
}
