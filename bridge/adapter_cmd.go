package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"

	"github.com/bttf/ogremcp/bridge/internal/adapter"
	"github.com/bttf/ogremcp/bridge/internal/kits"
	"github.com/bttf/ogremcp/bridge/internal/locate"
	"github.com/bttf/ogremcp/bridge/internal/process"
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
	// onFetch returns false when an adapter's sync failed, so the next check
	// of the kit list fetches again.
	onFetch := func(list []kits.Kit, err error) bool {
		if err != nil {
			fmt.Fprintln(os.Stderr, "Could not fetch the kits:", err)
			return false
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
		statuses := updater.Sync(ctx, targets)
		show(statuses)
		return !slices.ContainsFunc(statuses, func(st adapter.Status) bool { return st.State == adapter.StateFailed })
	}

	api := kits.New(base, client)
	if *watch {
		go updater.Run(ctx, adapter.DefaultStagedInterval, show)
		kits.NewPoller(api, settings.KitCheckEvery(), settings.Interval(), onFetch).Run(ctx)
		return nil
	}
	list, err := api.Fetch(ctx)
	if err != nil {
		return err
	}
	onFetch(list, nil)
	return nil
}
