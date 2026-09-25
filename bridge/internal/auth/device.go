package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// deviceCodeGrant is the device authorization grant's type (RFC 8628 §3.4).
const deviceCodeGrant = "urn:ietf:params:oauth:grant-type:device_code"

// defaultInterval is the polling interval when the server names none (RFC 8628
// §3.2). oidc-provider names none.
const defaultInterval = 5 * time.Second

// Limits on what the server may ask for, so a wrong answer cannot make the
// bridge wait for hours or poll in a tight loop.
const (
	minInterval = 1 * time.Second
	maxInterval = 60 * time.Second
	maxLifetime = 30 * time.Minute
)

// deviceAnswer is the device authorization endpoint's answer (RFC 8628 §3.2).
type deviceAnswer struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// Login logs the bridge in with the device flow. It calls show once with the
// code for the user, then waits until the user approves it (nil), denies it
// or lets it expire (an error), or ctx ends. On approval it saves the refresh
// token to the Store before it returns. When the save fails, Login returns an
// error that wraps ErrNotSaved, and AccessToken tries the save again.
func (c *Client) Login(ctx context.Context, show func(Code)) error {
	ep, err := c.discover(ctx)
	if err != nil {
		return err
	}
	start, err := c.startDevice(ctx, ep.deviceAuthorization)
	if err != nil {
		return err
	}
	show(Code{
		UserCode:                start.UserCode,
		VerificationURI:         start.VerificationURI,
		VerificationURIComplete: start.VerificationURIComplete,
		ExpiresIn:               time.Duration(start.ExpiresIn) * time.Second,
	})
	t, err := c.pollDevice(ctx, ep.token, start)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.adopt(t)
}

// startDevice asks for a device code for the bridge API.
func (c *Client) startDevice(ctx context.Context, endpoint string) (deviceAnswer, error) {
	form := url.Values{"client_id": {ClientID}, "scope": {scope}, "resource": {c.base + apiPath}}
	status, raw, _, err := c.postForm(ctx, endpoint, form)
	if err != nil {
		return deviceAnswer{}, fmt.Errorf("could not reach the server to log in: %w", err)
	}
	var a deviceAnswer
	if status != http.StatusOK || json.Unmarshal(raw, &a) != nil {
		return deviceAnswer{}, fmt.Errorf("the server refused to start a login (status %d); try again later", status)
	}
	if a.DeviceCode == "" || a.UserCode == "" || a.ExpiresIn <= 0 || !c.onOriginString(a.VerificationURI) ||
		(a.VerificationURIComplete != "" && !c.onOriginString(a.VerificationURIComplete)) {
		return deviceAnswer{}, fmt.Errorf("the server's login answer is not in the expected form")
	}
	return a, nil
}

// pollDevice polls the token endpoint until the user approves or denies the
// code, or it expires.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/pair/pair.go:115-163.
// The answers are the token endpoint's (RFC 8628 §3.5) instead of the
// prototype's own, and an answer without an interval means 5 seconds, not 1.
func (c *Client) pollDevice(ctx context.Context, endpoint string, start deviceAnswer) (tokenAnswer, error) {
	form := url.Values{"client_id": {ClientID}, "grant_type": {deviceCodeGrant}, "device_code": {start.DeviceCode}}
	interval := defaultInterval
	if start.Interval > 0 {
		interval = clamp(time.Duration(start.Interval) * time.Second)
	}
	deadline := c.now().Add(min(time.Duration(start.ExpiresIn)*time.Second, maxLifetime))
	for {
		if err := c.sleep(ctx, interval); err != nil {
			return tokenAnswer{}, err
		}
		if !c.now().Before(deadline) {
			return tokenAnswer{}, ErrExpired
		}
		status, raw, retryAfter, err := c.postForm(ctx, endpoint, form)
		if err != nil {
			if ctx.Err() != nil {
				return tokenAnswer{}, ctx.Err()
			}
			// No answer: the network or the server may be back at the next poll.
			c.log.Warn("login poll failed; trying again", "error", err.Error())
			continue
		}
		var body tokenAnswer
		_ = json.Unmarshal(raw, &body)
		switch {
		case status == http.StatusOK && body.valid():
			return body, nil
		case status == http.StatusOK:
			return tokenAnswer{}, fmt.Errorf("the server's token answer is not in the expected form")
		case status == http.StatusBadRequest && body.Error == "authorization_pending":
		case status == http.StatusBadRequest && body.Error == "slow_down":
			if body.Interval > 0 {
				interval = clamp(time.Duration(body.Interval) * time.Second)
			} else {
				interval = clamp(interval + 5*time.Second)
			}
		case status == http.StatusBadRequest && body.Error == "access_denied":
			return tokenAnswer{}, ErrDenied
		case status == http.StatusBadRequest && body.Error == "expired_token":
			return tokenAnswer{}, ErrExpired
		case status == http.StatusBadRequest && body.Error == "invalid_grant":
			return tokenAnswer{}, ErrInvalid
		case status == http.StatusTooManyRequests || status >= 500:
			if retryAfter > interval {
				if err := c.sleep(ctx, min(retryAfter, maxInterval)); err != nil {
					return tokenAnswer{}, err
				}
			}
		default:
			return tokenAnswer{}, fmt.Errorf("the server answered the login poll with status %d; check the server URL", status)
		}
	}
}

func clamp(d time.Duration) time.Duration {
	return max(minInterval, min(d, maxInterval))
}
