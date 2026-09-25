// Command bridge is the Ogre MCP bridge (docs/architecture.md §7).
//
// Without arguments it is the tray app, which the macOS .app and the login
// item start: an icon in the menu bar or the notification area. Its menu
// shows the last upload, the latest error, and the adapters' states, logs in
// with the device flow (§8.1), shows the folder picker when a game folder is
// not found (§6.1), and turns start at login on and off. It fetches the kits,
// installs and updates the adapters, watches the sources, and uploads each
// settled change, as bridge run and bridge adapter -watch do together. It
// logs to a file (package logfile) and not to a terminal.
//
// It also has these commands:
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
//	bridge adapter  fetch and locate as bridge kits does, install or update
//	                each kit's adapter (§7), and print the outcome at each
//	                adapter folder. Takes -root, and -watch, which syncs every
//	                refresh interval and applies an update staged while the
//	                game ran once it exits
//	bridge run      log in if the bridge is not, and then as bridge kits
//	                -watch, but upload each settled change (§8.3) instead of
//	                printing it. Takes -root. Logs in again when the server
//	                ends the login
//	bridge server   print the server and where its URL comes from
//	    set URL     save URL, a self-hosted server's origin (§13.3), as
//	                the server in the settings file
//	    reset       remove the server from the settings file, so the bridge
//	                uses the hosted service
//
// One bridge process runs per OS user (package lock): the tray app and each
// command hold a lock while they run, and a second one exits. bridge server
// takes it only to change the server.
//
// The server is OGREMCP_BASE_URL when it is set, for development, or else the
// settings file's server_url, or else the hosted service
// (config.File.Server). The tray's Server… item and bridge server set change
// server_url. The game folders, the refresh interval, the debounce delay, and
// the upload cap are in the settings file too (package config).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/bttf/ogremcp/bridge/internal/auth"
	"github.com/bttf/ogremcp/bridge/internal/config"
	"github.com/bttf/ogremcp/bridge/internal/keychain"
	"github.com/bttf/ogremcp/bridge/internal/kits"
	"github.com/bttf/ogremcp/bridge/internal/locate"
	"github.com/bttf/ogremcp/bridge/internal/lock"
	"github.com/bttf/ogremcp/bridge/internal/watch"
)

// version is set by the build's ldflags: the bridge-v tag without its prefix,
// or a commit hash for a dev build (docs/releases.md).
var version = "dev"

func main() {
	// Finder on old macOS versions passes -psn_0_NNNN to an app.
	if len(os.Args) < 2 || strings.HasPrefix(os.Args[1], "-psn_") {
		os.Exit(runTray())
	}
	locked := false
	switch os.Args[1] {
	case "login", "kits", "adapter", "run":
		locked = true
	case "server":
		// The tray app keeps its own copy of the settings file, and would
		// write it back without the change.
		locked = len(os.Args) > 2
	}
	if locked {
		held, err := acquireLock()
		if errors.Is(err, lock.ErrLocked) {
			fmt.Fprintln(os.Stderr, "bridge:", err.Error()+"; quit the tray app or the other bridge command first")
			os.Exit(1)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "bridge: could not take the single-instance lock:", err)
			os.Exit(1)
		}
		defer held.Release()
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
	case "adapter":
		if err := syncAdapters(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "bridge adapter:", err)
			os.Exit(1)
		}
	case "run":
		if err := run(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "bridge run:", err)
			os.Exit(1)
		}
	case "server":
		if err := server(os.Args[2:]); errors.Is(err, errUsage) {
			usage()
		} else if err != nil {
			fmt.Fprintln(os.Stderr, "bridge server:", err)
			os.Exit(1)
		}
	default:
		usage()
	}
}

// errUsage is a command line that names no command.
var errUsage = errors.New("usage")

func usage() {
	fmt.Fprintln(os.Stderr, "usage: bridge | bridge login | bridge kits [-root DIR] [-watch] | bridge adapter [-root DIR] [-watch] | bridge run [-root DIR] | bridge server [set URL | reset]")
	os.Exit(2)
}

// acquireLock takes the lock that keeps a second bridge process of this OS
// user from running (package lock). The caller holds it until it exits.
func acquireLock() (*lock.Lock, error) {
	path, err := lock.DefaultPath()
	if err != nil {
		return nil, err
	}
	return lock.Acquire(path)
}

// loadSettings reads the settings file (package config), and returns it with
// its path.
func loadSettings() (config.File, string, error) {
	path, err := config.DefaultPath()
	if err != nil {
		return config.File{}, "", err
	}
	settings, err := config.Load(path)
	return settings, path, err
}

// newClient returns the auth client of the server that settings and
// OGREMCP_BASE_URL name (config.File.Server), and its base URL.
func newClient(settings config.File) (*auth.Client, string, error) {
	base, err := settings.Server(os.Getenv(config.EnvServerURL))
	if err != nil {
		return nil, "", err
	}
	client, err := newAuth(base)
	return client, base, err
}

// newAuth returns the auth client of the server at base. Each server's
// refresh token is in a keychain entry of its own, so a login for one server
// is never sent to another.
func newAuth(base string) (*auth.Client, error) {
	return auth.New(base, version, keychain.Entry{Account: base})
}

func login() error {
	settings, _, err := loadSettings()
	if err != nil {
		return err
	}
	client, base, err := newClient(settings)
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
	settings, path, err := loadSettings()
	if err != nil {
		return err
	}
	client, base, err := newClient(settings)
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
