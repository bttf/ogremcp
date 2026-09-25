package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/bttf/ogremcp/bridge/internal/auth"
	"github.com/bttf/ogremcp/bridge/internal/config"
	"github.com/bttf/ogremcp/bridge/internal/kits"
	"github.com/bttf/ogremcp/bridge/internal/locate"
	"github.com/bttf/ogremcp/bridge/internal/upload"
	"github.com/bttf/ogremcp/bridge/internal/watch"
)

// run is the dev command `bridge run`: it logs in when the bridge holds no
// login, fetches the enabled kits every refresh interval, locates each game
// folder, watches the kits' sources, and uploads each settled change (§7,
// §8.3). When the server ends the login, it logs in again.
func run(args []string) error {
	flags := flag.NewFlagSet("bridge run", flag.ContinueOnError)
	rootFlag := flags.String("root", "", "answer the folder prompt with this folder; without it the prompt is skipped")
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

	if _, err := client.AccessToken(ctx); errors.Is(err, auth.ErrLoginRequired) {
		if err := client.Login(ctx, showCode); err != nil {
			return fmt.Errorf("login failed: %w", err)
		}
	} else if err != nil {
		// Offline, perhaps: the uploads wait and try again.
		fmt.Fprintln(os.Stderr, "Could not refresh the login:", err)
	}

	uploader := upload.New(base, client, version, settings.UploadCap(), nil)
	watcher := watch.New(settings.DebounceDelay(), settings.Interval(), nil, uploader.Add)
	go func() {
		if err := watcher.Run(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "Could not watch the game folders:", err)
		}
	}()
	go uploader.Run(ctx)

	relogin := make(chan struct{}, 1)
	env := locate.DefaultEnv()
	onFetch := func(list []kits.Kit, err error) {
		if errors.Is(err, auth.ErrLoginRequired) {
			select {
			case relogin <- struct{}{}:
			default:
			}
			return
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "Could not fetch the kits:", err)
			return
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
				uploader.CountError(upload.LocateFailed)
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
		watcher.SetKits(located)
	}
	poller := kits.NewPoller(kits.New(base, client), settings.Interval(), onFetch)

	// Log in again when the server ends the login.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-uploader.Changed():
				if !uploader.Status().LoginRequired {
					continue
				}
			case <-relogin:
			}
			// A signal from before the last login finds a login in place.
			if _, err := client.AccessToken(ctx); errors.Is(err, auth.ErrLoginRequired) {
				fmt.Println("The server ended the login.")
				if err := client.Login(ctx, showCode); err != nil {
					if ctx.Err() == nil {
						fmt.Fprintln(os.Stderr, "Login failed:", err)
					}
					continue
				}
			}
			uploader.Resume()
			poller.Wake()
		}
	}()

	poller.Run(ctx)
	return nil
}
