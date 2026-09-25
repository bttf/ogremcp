// Package adapter installs and updates the adapter of each enabled kit
// (docs/architecture.md §7, §6.1 adapter, §8.2).
//
// The caller runs Sync after each fetch of the kits (package kits): after
// login, at each start, and on the refresh timer. For each kit with an
// adapter, Sync finds the adapter folders adapter.install names under the
// kit's game folder, and compares each one's version, the ## Version of its
// TOC (§8.2), with the version the platform lists. It installs where the
// folder is missing or older, and never downgrades.
//
//   - A first install happens at any time: the game loads a new addon folder
//     only when it starts. While a process matching adapter.process runs, the
//     state is StateRestart until it exits.
//   - An update never happens under a running game, whose /reload would mix
//     old and new files. While a matching process runs, Sync downloads and
//     verifies the zip, keeps it, and reports StateWaiting ("Close WoW to
//     finish updating"). Run applies it once no matching process runs. When
//     the process list cannot be read, the game counts as running.
//   - The zip's sha256 must be the one GET /api/v1/kits listed and the
//     download's X-Adapter-Sha256 (ErrChanged, ErrChecksum): a mismatch is
//     tried again at the next sync. The zip is unpacked into a temporary
//     folder beside the adapter folder, rejecting unsafe entries
//     (ErrUnsafeZip), and swapped in by rename. The old folder stays until the
//     swap succeeds.
//   - Links on the way to the adapter folder are followed, as when a player
//     links Interface/AddOns to another folder, and every write goes through
//     the resolved parent folder. An adapter folder that is itself a link, as
//     kits/wow/scripts/link-addon.sh makes for a developer, is never replaced
//     or removed (StateLinked).
//   - A kit the user disabled is no longer listed, so Sync is not given it.
//     Its adapter stays installed and is not updated; an update staged for
//     it is dropped. The bridge never deletes an adapter folder.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/addon/updater.go.
package adapter

import (
	"context"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/bttf/ogmcp/bridge/internal/kits"
	"github.com/bttf/ogmcp/bridge/internal/process"
)

// DefaultStagedInterval is how often Run checks whether the game still runs
// while an update is staged.
const DefaultStagedInterval = 30 * time.Second

// ErrNoFolder means no folder under the game folder matches adapter.install.
var ErrNoFolder = errors.New("no folder in the game folder matches adapter.install")

// State is the outcome of a sync at one adapter folder.
type State int

const (
	// StateCurrent: the folder holds the listed version or a newer one.
	StateCurrent State = iota
	// StateInstalled: the listed version was installed or updated now.
	StateInstalled
	// StateRestart: the adapter was installed for the first time while the
	// game runs. The game loads it when it restarts.
	StateRestart
	// StateWaiting: an update is staged until the game exits. The tray says
	// "Close WoW to finish updating".
	StateWaiting
	// StateLinked: the adapter folder is a link, as a developer setup makes.
	// It is never replaced or removed.
	StateLinked
	// StateNotFolder: a file or other non-folder is at the adapter folder's
	// path. It is left as it is.
	StateNotFolder
	// StateFailed: Status.Err says why. The next sync tries again.
	StateFailed
)

func (s State) String() string {
	switch s {
	case StateCurrent:
		return "up to date"
	case StateInstalled:
		return "installed"
	case StateRestart:
		return "installed; restart the game to load it"
	case StateWaiting:
		return "update waiting; close the game to finish updating"
	case StateLinked:
		return "the adapter folder is a link, as a developer setup makes; not updated"
	case StateNotFolder:
		return "something other than a folder is at the adapter folder's path; not touched"
	case StateFailed:
		return "failed"
	}
	return "unknown"
}

// Status is the outcome of a sync at one adapter folder, or, with Path "",
// for a kit whose adapter folders could not be found.
type Status struct {
	Kit string
	// Path is the adapter folder, such as
	// .../_classic_era_/Interface/AddOns/OpenGamerMCP.
	Path  string
	State State
	// Installed is the version in the folder after the sync, or "" when
	// there is none or it cannot be read.
	Installed string
	// Latest is the version the platform lists.
	Latest string
	// Err is why the sync failed, for StateFailed.
	Err error
}

// Target is an enabled kit and the game folder found for it (package
// locate).
type Target struct {
	Kit  kits.Kit
	Root string
}

// Updater installs and updates adapters. Its methods may be called from
// several goroutines; they run one at a time.
type Updater struct {
	client *Client
	procs  process.Lister

	mu sync.Mutex
	// staged holds, by kit, an update that waits for the game to exit.
	staged map[string]staged
	// restart holds the adapter folders first installed while the game ran.
	restart map[string]bool
}

type staged struct {
	target Target
	zip    []byte
}

// New returns an Updater that downloads with client and lists processes with
// procs (process.System).
func New(client *Client, procs process.Lister) *Updater {
	return &Updater{client: client, procs: procs, staged: map[string]staged{}, restart: map[string]bool{}}
}

// Sync brings the adapter of each target up to date, or stages the update
// while its game runs. targets are all the enabled kits whose game folder was
// found; a kit without an adapter is skipped. An update staged for a kit not
// in targets is dropped. Sync returns a Status for each adapter folder.
func (u *Updater) Sync(ctx context.Context, targets []Target) []Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	listed := map[string]bool{}
	for _, t := range targets {
		listed[t.Kit.Kit] = true
	}
	for kit := range u.staged {
		if !listed[kit] {
			delete(u.staged, kit)
		}
	}
	var out []Status
	for _, t := range targets {
		if t.Kit.Adapter == nil || t.Kit.Manifest == nil || t.Kit.Manifest.Adapter == nil {
			continue
		}
		out = append(out, u.sync(ctx, t)...)
	}
	return out
}

// ApplyStaged applies each staged update whose game no longer runs, and
// returns the Status of each adapter folder it synced.
func (u *Updater) ApplyStaged(ctx context.Context) []Status {
	u.mu.Lock()
	defer u.mu.Unlock()
	var out []Status
	for _, kit := range slices.Sorted(maps.Keys(u.staged)) {
		t := u.staged[kit].target
		if running, err := process.Running(u.procs, t.Kit.Manifest.Adapter.Process); running || err != nil {
			continue
		}
		out = append(out, u.sync(ctx, t)...)
	}
	return out
}

// Run calls ApplyStaged every interval until ctx ends, and passes each
// non-empty result to onStatus. The process list is read only while an
// update is staged.
func (u *Updater) Run(ctx context.Context, interval time.Duration, onStatus func([]Status)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if st := u.ApplyStaged(ctx); len(st) > 0 {
				onStatus(st)
			}
		}
	}
}

// sync syncs every adapter folder of t, and stages or unstages t's update.
func (u *Updater) sync(ctx context.Context, t Target) []Status {
	kit, listed, a := t.Kit.Kit, t.Kit.Adapter, t.Kit.Manifest.Adapter
	base := Status{Kit: kit, Latest: listed.Version}
	failed := func(err error) []Status {
		base.State, base.Err = StateFailed, err
		return []Status{base}
	}
	latest, err := ParseVersion(listed.Version)
	if err != nil {
		return failed(errors.New("the server listed an adapter version that is not semver"))
	}
	dirs, name, err := parents(t.Root, a.Install)
	if err != nil {
		return failed(err)
	}
	if len(dirs) == 0 {
		return failed(ErrNoFolder)
	}
	running, err := process.Running(u.procs, a.Process)
	if err != nil {
		running = true
	}

	// The zip is downloaded once per sync, when a folder needs it. A staged
	// one is reused while the server lists the same sha256.
	var zip []byte
	if s, ok := u.staged[kit]; ok && s.target.Kit.Adapter.SHA256 == listed.SHA256 {
		zip = s.zip
	}
	getZip := func() ([]byte, error) {
		if zip != nil {
			return zip, nil
		}
		data, err := u.client.Download(ctx, kit, listed.SHA256)
		if err == nil {
			zip = data
		}
		return data, err
	}

	var out []Status
	waiting := false
	for _, dir := range dirs {
		st := base
		st.Path = filepath.Join(dir, name)
		u.syncFolder(&st, dir, name, latest, running, getZip)
		waiting = waiting || st.State == StateWaiting
		out = append(out, st)
	}
	if waiting {
		u.staged[kit] = staged{target: t, zip: zip}
	} else {
		delete(u.staged, kit)
	}
	return out
}

// syncFolder syncs the adapter folder name in dir, and records the outcome
// in st.
func (u *Updater) syncFolder(st *Status, dir, name string, latest Version, running bool, getZip func() ([]byte, error)) {
	fail := func(err error) {
		st.State, st.Err = StateFailed, err
	}
	r, err := openParent(dir)
	if err != nil {
		fail(err)
		return
	}
	defer r.Close()
	tidy(r, name)
	k, err := inspect(r, name)
	if err != nil {
		fail(err)
		return
	}
	switch k {
	case linked:
		st.State = StateLinked
		return
	case other:
		st.State = StateNotFolder
		return
	case folder:
		// A version that cannot be read is replaced.
		have, err := tocVersion(r.FS(), name)
		if err == nil {
			st.Installed = have.String()
			if have.Compare(latest) >= 0 {
				st.State = StateCurrent
				if !running {
					delete(u.restart, st.Path)
				} else if u.restart[st.Path] {
					st.State = StateRestart
				}
				return
			}
		}
	}
	zip, err := getZip()
	if err != nil {
		fail(err)
		return
	}
	if k == folder && running {
		st.State = StateWaiting
		return
	}
	if err := install(r, name, zip, latest); err != nil {
		fail(err)
		return
	}
	st.Installed = latest.String()
	st.State = StateInstalled
	if k == missing && running {
		st.State = StateRestart
		u.restart[st.Path] = true
	}
}
