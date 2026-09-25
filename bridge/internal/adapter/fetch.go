package adapter

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"

	"github.com/bttf/ogmcp/bridge/internal/manifest"
)

// SHA256Header carries the adapter zip's sha256, as lower-case hex (§8.2).
const SHA256Header = "X-Adapter-Sha256"

// MaxZip is the largest adapter zip the bridge downloads. The WoW adapter is
// far smaller.
const MaxZip = 20 << 20

var (
	// ErrChanged means the server serves another zip than GET /api/v1/kits
	// listed, as when a deploy came between the two requests. The next sync
	// tries again.
	ErrChanged = errors.New("the server's adapter changed since the kit list; the bridge tries again later")
	// ErrChecksum means the downloaded zip does not have the sha256 the
	// server listed. The next sync tries again.
	ErrChecksum = errors.New("the adapter download does not match its sha256; the bridge tries again later")
)

var hexSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Doer sends a request to the bridge API with an access token. It is an
// *auth.Client.
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

// Client downloads adapter zips from the bridge API.
type Client struct {
	base string
	api  Doer
}

// NewClient returns a Client for the server at base, the base URL api holds
// tokens for.
func NewClient(base string, api Doer) *Client {
	return &Client{base: base, api: api}
}

// Download returns the zip of GET /api/v1/kits/{kit}/adapter. want is the
// sha256 GET /api/v1/kits listed for it. The answer's SHA256Header must be
// want, or Download fails with ErrChanged, and the bytes must hash to want,
// or it fails with ErrChecksum.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/addon/fetch.go.
func (c *Client) Download(ctx context.Context, kit, want string) ([]byte, error) {
	if !manifest.ValidKit(kit) {
		return nil, fmt.Errorf("%q is not a valid kit name", kit)
	}
	if !hexSHA256.MatchString(want) {
		return nil, errors.New("the server listed an adapter sha256 that is not 64 lower-case hex digits")
	}
	path := "/api/v1/kits/" + kit + "/adapter"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/zip")
	res, err := c.api.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the server answered %s with status %d", path, res.StatusCode)
	}
	if res.Header.Get(SHA256Header) != want {
		return nil, ErrChanged
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, MaxZip+1))
	if err != nil {
		return nil, fmt.Errorf("could not download the adapter of kit %q: %w", kit, err)
	}
	if len(data) > MaxZip {
		return nil, fmt.Errorf("the adapter of kit %q is over %d bytes", kit, MaxZip)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != want {
		return nil, ErrChecksum
	}
	return data, nil
}
