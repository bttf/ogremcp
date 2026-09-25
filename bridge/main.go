// Command bridge is the Open Gamer MCP bridge (docs/architecture.md §7).
// Until the tray UI (P5), it has three development commands:
//
//	bridge login    log in with the device flow (§8.1) and keep the refresh
//	                token in the OS keychain
//	bridge kits     fetch the enabled kits' manifests (§8.2), locate each
//	                game folder (§6.1), remember it, and print it
//	    -root DIR   answer the folder prompt with DIR; without it the prompt
//	                is skipped
//	    -watch      keep running, fetch and locate again every refresh
//	                interval, and watch the kits' sources (§7): print each
//	                settled change of a source instance
//	bridge run      log in if the bridge is not, and then as bridge kits
//	                -watch, but upload each settled change (§8.3) instead of
//	                printing it. Takes -root. Logs in again when the server
//	                ends the login
//
// The server is OGMCP_BASE_URL, or the development default below. The game
// folders, the refresh interval, the debounce delay, and the upload cap are
// in the settings file (package config).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/config"
	"github.com/bttf/ogmcp/bridge/internal/keychain"
	"github.com/bttf/ogmcp/bridge/internal/kits"
	"github.com/bttf/ogmcp/bridge/internal/locate"
	"github.com/bttf/ogmcp/bridge/internal/watch"
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
	case "kits":
		if err := listKits(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "bridge kits:", err)
			os.Exit(1)
		}
	case "run":
		if err := run(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "bridge run:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "usage: bridge login | bridge kits [-root DIR] [-watch] | bridge run [-root DIR]")
		os.Exit(2)
	}
}

// newClient returns the auth client of the server and its base URL.
func newClient() (*auth.Client, string, error) {
	raw := os.Getenv("OGMCP_BASE_URL")
	if raw == "" {
		raw = defaultBaseURL
	}
	base, err := auth.ParseBaseURL(raw)
	if err != nil {
		return nil, "", err
	}
	client, err := auth.New(base, version, keychain.Entry{Account: base})
	return client, base, err
}

func login() error {
	client, base, err := newClient()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	err = client.Login(ctx, showCode)
	if errors.Is(err, context.Canceled) {
		return errors.New("interrupted")
	}
	if err != nil {
		return err
	}
	fmt.Println("Logged in to", base+". The refresh token is in the OS keychain.")
	return nil
}

// showCode shows the code of a login to the user.
func showCode(code auth.Code) {
	fmt.Printf("\nTo log in this bridge, open this page and sign in:\n\n    %s\n\nEnter the code %s and approve it.\nThe code expires in %d minutes. Waiting for approval...\n\n",
		code.VerificationURI, code.UserCode, int(code.ExpiresIn.Minutes()+0.5))
}

// folderFlag answers the folder prompt with the -root flag.
type folderFlag string

func (f folderFlag) PickFolder(context.Context, string) (string, error) {
	return string(f), nil
}

func listKits(args []string) error {
	flags := flag.NewFlagSet("bridge kits", flag.ContinueOnError)
	rootFlag := flags.String("root", "", "answer the folder prompt with this folder; without it the prompt is skipped")
	follow := flags.Bool("watch", false, "keep running, fetch and locate again every refresh interval, and print each settled change of a source instance")
	if err := flags.Parse(args); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	var prompter locate.Prompter
	if *rootFlag != "" {
		dir, err := filepath.Abs(*rootFlag)
		if err != nil {
			return err
		}
		prompter = folderFlag(dir)
	}
	client, base, err := newClient()
	if err != nil {
		return err
	}
	path, err := config.DefaultPath()
	if err != nil {
		return err
	}
	settings, err := config.Load(path)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var watcher *watch.Watcher
	if *follow {
		watcher = watch.New(settings.DebounceDelay(), settings.Interval(), nil, func(c watch.Change) {
			fmt.Printf("%s %s %s: changed at %s\n", c.Kit, c.SourceID, c.Instance[:12], c.ModTime.Format(time.RFC3339))
		})
		go func() {
			if err := watcher.Run(ctx); err != nil {
				fmt.Fprintln(os.Stderr, "Could not watch the game folders:", err)
			}
		}()
	}

	env := locate.DefaultEnv()
	show := func(list []kits.Kit, err error) {
		if err != nil {
			fmt.Fprintln(os.Stderr, "Could not fetch the kits:", err)
			return
		}
		if len(list) == 0 {
			fmt.Println("No kits are enabled for this account.")
		}
		var located []watch.Kit
		for _, k := range list {
			if k.Err != nil {
				fmt.Printf("%s: %v\n", k.Kit, k.Err)
				continue
			}
			root, err := locate.Root(ctx, k.Manifest.Root, settings.Roots[k.Kit], env, prompter)
			if err != nil {
				fmt.Printf("%s %s: %v\n", k.Kit, k.Manifest.Version, err)
				continue
			}
			fmt.Printf("%s %s: %s\n", k.Kit, k.Manifest.Version, root)
			located = append(located, watch.Kit{Kit: k.Kit, Root: root, Sources: k.Manifest.Sources})
			if settings.Roots[k.Kit] != root {
				if settings.Roots == nil {
					settings.Roots = map[string]string{}
				}
				settings.Roots[k.Kit] = root
				if err := config.Save(path, settings); err != nil {
					fmt.Fprintln(os.Stderr, "Could not remember the game folder:", err)
				}
			}
		}
		if watcher != nil {
			watcher.SetKits(located)
		}
	}

	api := kits.New(base, client)
	if *follow {
		kits.NewPoller(api, settings.Interval(), show).Run(ctx)
		return nil
	}
	list, err := api.Fetch(ctx)
	if err != nil {
		return err
	}
	show(list, nil)
	return nil
}
