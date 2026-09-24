// Package auth is the bridge's login (docs/architecture.md §7, §8.1): the
// OAuth device authorization grant (RFC 8628) against the platform's OAuth
// server, and the access tokens the bridge API takes.
//
// The bridge is the public client ClientID. Login asks the device
// authorization endpoint for a code with scope `ingest`, shows the user code
// and the `/device` page, and polls the token endpoint until the user approves
// or denies the code there, or it expires. Approval gives an access token for
// the bridge API, `<base>/api/v1`, and a refresh token. The endpoints come
// from the server's discovery document.
//
// The refresh token lives in a Store, the OS keychain (package keychain), and
// never in a plain file (§7). Each refresh replaces it with a new one, and the
// server revokes the whole grant when a replaced one is used again. So
// refreshes run one at a time, and a new refresh token is saved to the Store
// before its access token is used. When the save fails, the new tokens stay in
// memory, unused, and each call tries the save again: the Store's old refresh
// token is never sent. If the bridge exits before a save succeeds, the next
// start sends the old one, the server revokes the grant, and the user logs in
// again.
//
// A 401 from the bridge API gets one refresh and one retry, since an access
// token can expire before the bridge expects it to. A refresh the server
// refuses, or a second 401, ends the login (§8.3): the Store's refresh token
// is deleted, and calls return ErrLoginRequired until Login succeeds again.
//
// No token or device code is logged or put in an error. The user code is
// shown to the user, who checks it on the web page.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ClientID is the bridge's pre-registered public client on the OAuth server
// (§8.1). It has no secret.
const ClientID = "ogmcp-bridge"

// scope is the bridge API's scope (§8.1).
const scope = "ingest"

// apiPath is the bridge API's path, and with the base URL its resource
// identifier (RFC 8707).
const apiPath = "/api/v1"

// expiryMargin is how long before its expiry an access token is refreshed, at
// most half its lifetime.
const expiryMargin = time.Minute

// Errors a login ends with. Each is a sentence for the user.
var (
	// ErrLoginRequired means the bridge holds no refresh token, or the server
	// no longer accepts it.
	ErrLoginRequired = errors.New("the bridge is not logged in; log in again")
	ErrDenied        = errors.New("the login was denied on the web page")
	ErrExpired       = errors.New("the login code expired before it was approved; log in again")
	ErrInvalid       = errors.New("the server no longer knows this login code; log in again")
)

// errRefused is a refresh token the server refused.
var errRefused = errors.New("the server refused the refresh token")

// errReplaced is a 401 for an access token that a refresh or a new login has
// since replaced. The new one may still be good.
var errReplaced = errors.New("the server refused an access token that has since been replaced; try again")

// Store holds the refresh token of one server.
type Store interface {
	// Get returns the refresh token, or "" when there is none.
	Get() (string, error)
	// Set replaces the refresh token.
	Set(token string) error
	// Delete removes the refresh token. Deleting none is not an error.
	Delete() error
}

// Code is what the user needs to approve a login.
type Code struct {
	UserCode string
	// VerificationURI is the web UI's `/device` page, where the user enters
	// UserCode.
	VerificationURI string
	// VerificationURIComplete is the page with UserCode filled in, or "".
	VerificationURIComplete string
	// ExpiresIn is how long the code lasts.
	ExpiresIn time.Duration
}

// Client logs the bridge in to one server and gives out access tokens for its
// bridge API. It is safe for concurrent use.
type Client struct {
	base    string
	version string
	store   Store
	http    *http.Client
	log     *slog.Logger
	// sleep waits between polls; ctx cancels it.
	sleep func(ctx context.Context, d time.Duration) error
	now   func() time.Time

	discoveryMu sync.Mutex
	endpoints   *endpoints

	// mu guards the tokens, and is held through each refresh, from the
	// request to the save.
	mu      sync.Mutex
	access  string
	expiry  time.Time // when access is refreshed
	refresh string    // "" means the Store's
	unsaved bool      // refresh is newer than the Store's
}

// New returns a Client for the server at base, a URL ParseBaseURL accepts. It
// keeps the refresh token in store. version goes in the User-Agent.
func New(base, version string, store Store) (*Client, error) {
	base, err := ParseBaseURL(base)
	if err != nil {
		return nil, err
	}
	return &Client{
		base:    base,
		version: version,
		store:   store,
		http: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		log:   slog.Default(),
		sleep: sleep,
		now:   time.Now,
	}, nil
}

// ParseBaseURL checks a server base URL and returns it without a trailing
// slash. It must be an origin only: https, or http on a loopback host for
// development.
func ParseBaseURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSuffix(raw, "/"))
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", fmt.Errorf("the server URL %q must be an origin only, such as https://example.com", raw)
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !isLoopback(u.Hostname())) {
		return "", fmt.Errorf("the server URL %q must start with https://", raw)
	}
	return u.Scheme + "://" + strings.ToLower(u.Host), nil
}

func isLoopback(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// AccessToken returns an access token for the bridge API, refreshing it when
// it is about to expire. It returns ErrLoginRequired when the bridge holds no
// refresh token, or when the server refuses it; the Store's is then deleted.
func (c *Client) AccessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.token(ctx, "")
}

// token returns an access token, refreshing it when it is about to expire.
// refused, when not "", is an access token the server answered with 401: it
// is refreshed however long it seems to have left. Called with mu held.
func (c *Client) token(ctx context.Context, refused string) (string, error) {
	if c.unsaved {
		if err := c.save(); err != nil {
			return "", err
		}
	}
	if c.access != "" && c.access != refused && c.now().Before(c.expiry) {
		return c.access, nil
	}
	if c.refresh == "" {
		stored, err := c.store.Get()
		if err != nil {
			return "", fmt.Errorf("could not read the refresh token from the keychain: %w", err)
		}
		if stored == "" {
			return "", ErrLoginRequired
		}
		c.refresh = stored
	}
	// The server spends the refresh token when it answers, whether or not the
	// caller still waits, so ctx's cancellation does not cut the refresh
	// short. The HTTP client's timeout ends it.
	t, err := c.refreshWith(context.WithoutCancel(ctx), c.refresh)
	if errors.Is(err, errRefused) {
		return "", c.end()
	}
	if err != nil {
		return "", err
	}
	if err := c.adopt(t); err != nil {
		return "", err
	}
	return c.access, nil
}

// Do sends req, a request to the bridge API, with an access token. On a 401
// answer it refreshes the token and sends req once more, so a request with a
// body needs GetBody, which http.NewRequest sets for an in-memory body. A
// second 401 means the token is invalid or revoked (§8.3): Do ends the login,
// as a refused refresh does, and returns ErrLoginRequired.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	if !c.onOrigin(req.URL) {
		return nil, errors.New("an access token goes only to the server it came from")
	}
	token, err := c.AccessToken(req.Context())
	if err != nil {
		return nil, err
	}
	res, err := c.sendWith(req, token)
	if err != nil || res.StatusCode != http.StatusUnauthorized {
		return res, err
	}
	res.Body.Close()

	c.mu.Lock()
	token, err = c.token(req.Context(), token)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	retry := req.Clone(req.Context())
	if req.GetBody != nil {
		if retry.Body, err = req.GetBody(); err != nil {
			return nil, err
		}
	} else if req.Body != nil && req.Body != http.NoBody {
		return nil, errReplaced
	}
	res, err = c.sendWith(retry, token)
	if err != nil || res.StatusCode != http.StatusUnauthorized {
		return res, err
	}
	res.Body.Close()
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case c.refresh == "":
		// Another request ended the login first.
		return nil, ErrLoginRequired
	case c.access != token:
		return nil, errReplaced
	default:
		return nil, c.end()
	}
}

// sendWith sends a copy of req with token.
func (c *Client) sendWith(req *http.Request, token string) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", c.userAgent())
	return c.http.Do(req)
}

// adopt makes t the current tokens and saves its refresh token. Called with
// mu held.
func (c *Client) adopt(t tokenAnswer) error {
	lifetime := time.Duration(t.ExpiresIn) * time.Second
	c.access = t.AccessToken
	// Without its monotonic reading, the expiry is compared in wall-clock
	// time. The monotonic clock stops while a Mac sleeps, and the token's
	// lifetime does not.
	c.expiry = c.now().Round(0).Add(lifetime - min(expiryMargin, lifetime/2))
	c.refresh = t.RefreshToken
	c.unsaved = true
	return c.save()
}

// save writes the current refresh token to the Store. Until it succeeds the
// tokens stay unused. Called with mu held.
func (c *Client) save() error {
	if err := c.store.Set(c.refresh); err != nil {
		return fmt.Errorf("could not save the refresh token to the keychain: %w", err)
	}
	c.unsaved = false
	return nil
}

// end ends the login: it forgets the tokens and deletes the Store's refresh
// token. It returns ErrLoginRequired, joined with the delete's error when
// there is one. Called with mu held.
func (c *Client) end() error {
	c.access, c.refresh, c.unsaved = "", "", false
	if err := c.store.Delete(); err != nil {
		return errors.Join(ErrLoginRequired, fmt.Errorf("could not delete the refresh token from the keychain: %w", err))
	}
	return ErrLoginRequired
}

// tokenAnswer is the token endpoint's answer (RFC 6749 §5.1, §5.2).
type tokenAnswer struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token"`
	Error        string `json:"error"`
	// Interval is a slow_down answer's new polling interval, in seconds.
	Interval int `json:"interval"`
}

func (t tokenAnswer) valid() bool {
	return t.AccessToken != "" && t.RefreshToken != "" && strings.EqualFold(t.TokenType, "Bearer") && t.ExpiresIn > 0
}

// refreshWith exchanges a refresh token for new tokens. It returns errRefused
// when the server refuses the refresh token.
func (c *Client) refreshWith(ctx context.Context, refresh string) (tokenAnswer, error) {
	ep, err := c.discover(ctx)
	if err != nil {
		return tokenAnswer{}, err
	}
	form := url.Values{"client_id": {ClientID}, "grant_type": {"refresh_token"}, "refresh_token": {refresh}}
	status, raw, _, err := c.postForm(ctx, ep.token, form)
	if err != nil {
		return tokenAnswer{}, fmt.Errorf("could not reach the server to refresh the login: %w", err)
	}
	var t tokenAnswer
	_ = json.Unmarshal(raw, &t)
	switch {
	case status == http.StatusOK && t.valid():
		return t, nil
	case status == http.StatusBadRequest && t.Error == "invalid_grant":
		return tokenAnswer{}, errRefused
	default:
		return tokenAnswer{}, fmt.Errorf("the server answered the refresh with status %d", status)
	}
}

// endpoints are the OAuth server's, from its discovery document.
type endpoints struct {
	deviceAuthorization string
	token               string
}

// discover reads the OAuth server's endpoints from its discovery document, and
// keeps them once it has them. Every endpoint must be on the base URL's
// origin, so no token goes elsewhere.
func (c *Client) discover(ctx context.Context) (endpoints, error) {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	if c.endpoints != nil {
		return *c.endpoints, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/.well-known/openid-configuration", nil)
	if err != nil {
		return endpoints{}, err
	}
	status, raw, _, err := c.send(req)
	if err != nil {
		return endpoints{}, fmt.Errorf("could not reach the server: %w", err)
	}
	var doc struct {
		Issuer                      string `json:"issuer"`
		DeviceAuthorizationEndpoint string `json:"device_authorization_endpoint"`
		TokenEndpoint               string `json:"token_endpoint"`
	}
	if status != http.StatusOK || json.Unmarshal(raw, &doc) != nil || doc.Issuer != c.base {
		return endpoints{}, fmt.Errorf("the server at %s did not answer as an Open Gamer MCP server (status %d)", c.base, status)
	}
	if !c.onOriginString(doc.DeviceAuthorizationEndpoint) || !c.onOriginString(doc.TokenEndpoint) {
		return endpoints{}, fmt.Errorf("the server at %s names endpoints on another origin", c.base)
	}
	c.endpoints = &endpoints{deviceAuthorization: doc.DeviceAuthorizationEndpoint, token: doc.TokenEndpoint}
	return *c.endpoints, nil
}

func (c *Client) onOrigin(u *url.URL) bool {
	return u.Scheme+"://"+strings.ToLower(u.Host) == c.base
}

func (c *Client) onOriginString(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && c.onOrigin(u)
}

func (c *Client) userAgent() string {
	return "ogmcp-bridge/" + c.version
}

// postForm posts form to endpoint.
func (c *Client) postForm(ctx context.Context, endpoint string, form url.Values) (int, []byte, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, nil, 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return c.send(req)
}

// send sends req and returns the status, up to 64 KiB of the body, and the
// Retry-After wait.
func (c *Client) send(req *http.Request) (int, []byte, time.Duration, error) {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", c.userAgent())
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, 0, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return 0, nil, 0, err
	}
	var retryAfter time.Duration
	if s, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil && s > 0 {
		retryAfter = time.Duration(s) * time.Second
	}
	return res.StatusCode, raw, retryAfter, nil
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
