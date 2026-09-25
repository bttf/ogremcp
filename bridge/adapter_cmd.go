package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/bttf/ogmcp/bridge/internal/adapter"
	"github.com/bttf/ogmcp/bridge/internal/config"
	"github.com/bttf/ogmcp/bridge/internal/kits"
	"github.com/bttf/ogmcp/bridge/internal/locate"
	"github.com/bttf/ogmcp/bridge/internal/process"
)

// syncAdapters is the dev command `bridge adapter`: it fetches the enabled
// kits, locates each game folder, installs or updates each adapter (§7), and
// prints the outcome at each adapter folder.
func syncAdapters(args []string) error {
	flags := flag.NewFlagSet("bridge adapter", flag.ContinueOnError)
	rootFlag := flags.String("root", "", "answer the folder prompt with this folder; without it the prompt is skipped")
	watch := flags.Bool("watch", false, "keep running: sync every refresh interval, and apply a staged update once the game exits")
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

	updater := adapter.New(adapter.NewClient(base, client), process.System{})
	show := func(list []adapter.Status) {
		for _, st := range list {
			where := st.Path
			if where == "" {
				where = "(no adapter folder)"
			}
			fmt.Printf("%s %s: %s", st.Kit, where, st.State)
			if st.Installed != "" {
				fmt.Printf(" (installed %s, latest %s)", st.Installed, st.Latest)
			}
			if st.Err != nil {
				fmt.Printf(": %v", st.Err)
			}
			fmt.Println()
		}
	}
	env := locate.DefaultEnv()
	onFetch := func(list []kits.Kit, err error) {
		if err != nil {
			fmt.Fprintln(os.Stderr, "Could not fetch the kits:", err)
			return
		}
		var targets []adapter.Target
		for _, k := range list {
			if k.Err != nil {
				fmt.Printf("%s: %v\n", k.Kit, k.Err)
				continue
			}
			if k.Adapter == nil || k.Manifest.Adapter == nil {
				continue
			}
			root, err := locate.Root(ctx, k.Manifest.Root, settings.Roots[k.Kit], env, prompter)
			if err != nil {
				fmt.Printf("%s: %v\n", k.Kit, err)
				continue
			}
			targets = append(targets, adapter.Target{Kit: k, Root: root})
		}
		show(updater.Sync(ctx, targets))
	}

	api := kits.New(base, client)
	if *watch {
		go updater.Run(ctx, adapter.DefaultStagedInterval, show)
		kits.NewPoller(api, settings.Interval(), onFetch).Run(ctx)
		return nil
	}
	list, err := api.Fetch(ctx)
	if err != nil {
		return err
	}
	onFetch(list, nil)
	return nil
}
