// Command bridge is the Open Gamer MCP bridge (docs/architecture.md §7).
// Until the tray UI (P5), it has one development command:
//
//	bridge login    log in with the device flow (§8.1) and keep the refresh
//	                token in the OS keychain
//
// The server is OGMCP_BASE_URL, or the development default below.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/keychain"
)

// version is set by the build's ldflags: the bridge-v tag without its prefix,
// or a commit hash for a dev build (docs/releases.md).
var version = "dev"

// defaultBaseURL is the platform's Railway domain, for development. The
// production domain is not decided yet (§19.1 D4).
const defaultBaseURL = "https://ogmcp-production.up.railway.app"

func main() {
	if len(os.Args) < 2 {
		return
	}
	switch os.Args[1] {
	case "login":
		if err := login(); err != nil {
			fmt.Fprintln(os.Stderr, "Login failed:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "usage: bridge login")
		os.Exit(2)
	}
}

func login() error {
	raw := os.Getenv("OGMCP_BASE_URL")
	if raw == "" {
		raw = defaultBaseURL
	}
	base, err := auth.ParseBaseURL(raw)
	if err != nil {
		return err
	}
	client, err := auth.New(base, version, keychain.Entry{Account: base})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	err = client.Login(ctx, func(code auth.Code) {
		fmt.Printf("\nTo log in this bridge, open this page and sign in:\n\n    %s\n\nEnter the code %s and approve it.\nThe code expires in %d minutes. Waiting for approval...\n\n",
			code.VerificationURI, code.UserCode, int(code.ExpiresIn.Minutes()+0.5))
	})
	if errors.Is(err, context.Canceled) {
		return errors.New("interrupted")
	}
	if err != nil {
		return err
	}
	fmt.Println("Logged in to", base+". The refresh token is in the OS keychain.")
	return nil
}
