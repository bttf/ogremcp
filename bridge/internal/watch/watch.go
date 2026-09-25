// Package watch watches the source instances of the user's kits and reports
// each change once its writes have settled (docs/architecture.md §7).
//
// # Instances
//
// A source's path (§6.1) is relative to its kit's root and may have globs
// (package locate). Each file it matches is a source instance. The watcher
// resolves every segment of the path but the last to folders, watches those
// folders with fsnotify, and filters their events by the last segment, the
// file name. The game may replace a file when it saves it, and WoW keeps a
// .bak copy beside it. A watch on the file itself would end at the first
// replacement; a watch on its folder does not. A file that does not exist yet
// becomes an instance when it is first written.
//
// fsnotify does not watch subfolders, and flavor folders and accounts appear
// while the bridge runs. The watcher resolves the globs again at start, after
// each SetKits, and every interval (§7, proposed 5 min; package config). It
// drops the watch of each folder that no longer matches, and starts one for
// each new folder, and again for a folder whose path now names another
// folder. A matching file already in a newly watched folder counts as
// changed, since it may have been written before the watch started. So every
// instance counts as changed at start, and after fsnotify reports that it
// lost events; the platform ignores an upload whose bytes it already has
// (§8.3).
//
// # Changes
//
// Each event that names an instance's file, other than a change of mode,
// starts or restarts that instance's debounce timer (§7, proposed 2 s;
// package config). When the timer runs out and the file exists, the watcher
// calls its onChange with a Change. It reads no file. It watches whether or
// not the game runs.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/watch: the event loop,
// the folder watches, the debounce, and the rescan.
package watch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/bttf/ogmcp/bridge/internal/locate"
	"github.com/bttf/ogmcp/bridge/internal/manifest"
)

// Kit is a kit whose sources the watcher watches.
type Kit struct {
	// Kit is the kit's ID, such as "wow".
	Kit string
	// Root is the kit's game folder, a full path (package locate).
	Root string
	// Sources are the sources of the kit's manifest. The watcher watches
	// those of type file and ignores the rest.
	Sources []manifest.Source
}

// Change is a settled change of one source instance: its file exists and has
// gone the debounce delay without a write. It holds what an upload needs
// (§8.3), except the file's bytes and their SHA-256.
type Change struct {
	// Kit is the kit's ID.
	Kit string
	// SourceID is the source's ID, sent as source_id.
	SourceID string
	// Instance is the instance's ID, sent as instance: the SHA-256, as
	// lower-case hex, of the file's path relative to root, with "/"
	// separators on every OS. The path itself stays on this device.
	Instance string
	// Path is the file's full path.
	Path string
	// ModTime is the file's modification time when the change settled.
	ModTime time.Time
}

// Watcher watches the source instances of a set of kits. Make one with New.
type Watcher struct {
	debounce time.Duration
	interval time.Duration
	log      *slog.Logger
	onChange func(Change)

	// mu guards next, the kits of the latest SetKits. wake tells Run of it.
	mu   sync.Mutex
	next []Kit
	wake chan struct{}

	// clock makes the timers. Tests set a fake one.
	clock clock
	// trace, when set, is told what the event loop does. Tests wait on it.
	trace func(string)
	// probe runs functions on the event loop. It is nil, and never ready,
	// outside tests.
	probe chan func()

	// The rest belongs to Run's goroutine.
	ctx     context.Context
	fsw     *fsnotify.Watcher
	kits    []Kit
	watches map[watchKey]*watch
	byDir   map[string][]*watch
	// dirs holds the folders fsw watches, each as it was when its watch
	// started.
	dirs    map[string]os.FileInfo
	pending map[instKey]*pending
	due     chan *pending
	tick    chan struct{}
	// warned holds the problems logged already, so each is logged once.
	warned map[string]bool
}

// watchKey names one source's watch of one folder.
type watchKey struct{ kit, source, dir string }

// watch is one source's watch of one folder: each file in dir whose name
// matches pattern is an instance of the source.
type watch struct {
	watchKey
	// rel is dir relative to the kit's root, with "/" separators, or "" for
	// the root itself.
	rel string
	// pattern is the last segment of the source's path.
	pattern string
}

// instKey names one instance: a file in a watched folder.
type instKey struct {
	watchKey
	name string
}

// pending is the debounce timer of one instance.
type pending struct {
	key   instKey
	timer timer
}

// New returns a Watcher. debounce is how long an instance's file must go
// without a write before the change is reported, and interval is how often
// the globs are resolved again. log gets the watcher's warnings; nil means
// slog.Default().
//
// Run calls onChange for each settled change, on Run's goroutine, one change
// at a time. It must return quickly, since the watcher reads no file events
// while it runs. It hands the change to the uploader, which keeps only the
// latest change of each instance (§7).
func New(debounce, interval time.Duration, log *slog.Logger, onChange func(Change)) *Watcher {
	if log == nil {
		log = slog.Default()
	}
	return &Watcher{
		debounce: debounce,
		interval: interval,
		log:      log,
		onChange: onChange,
		wake:     make(chan struct{}, 1),
		clock:    realClock{},
	}
}

// SetKits replaces the kits the watcher watches, and makes it resolve the
// globs again. A kit left out, such as one whose root was not found, loses
// its watches. SetKits does not block, and it may be called before Run.
func (w *Watcher) SetKits(kits []Kit) {
	w.mu.Lock()
	w.next = slices.Clone(kits)
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// Run watches until ctx ends. It returns an error only when it cannot start
// watching. Call it once.
func (w *Watcher) Run(ctx context.Context) error {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("could not start watching files: %w", err)
	}
	defer fsw.Close()
	// The timers' goroutines wait on ctx to hand over what fired.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	w.ctx = ctx
	w.fsw = fsw
	w.watches = map[watchKey]*watch{}
	w.byDir = map[string][]*watch{}
	w.dirs = map[string]os.FileInfo{}
	w.pending = map[instKey]*pending{}
	w.due = make(chan *pending)
	w.tick = make(chan struct{})
	w.warned = map[string]bool{}

	w.takeKits()
	w.rescan()
	period := w.clock.AfterFunc(w.interval, w.tock)
	defer func() {
		period.Stop()
		for _, p := range w.pending {
			p.timer.Stop()
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-w.wake:
			w.takeKits()
			w.rescan()
		case <-w.tick:
			w.rescan()
			period = w.clock.AfterFunc(w.interval, w.tock)
		case ev := <-fsw.Events:
			w.event(ev)
		case err := <-fsw.Errors:
			w.log.Warn("file watcher error", "error", err)
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				// Events were lost: count every instance as changed.
				for _, wt := range w.watches {
					w.scheduleExisting(wt)
				}
			}
		case p := <-w.due:
			// A timer that fired before it was restarted is not the
			// pending one.
			if w.pending[p.key] == p {
				delete(w.pending, p.key)
				w.settle(p.key)
			}
		case f := <-w.probe:
			f()
		}
	}
}

// tock runs when the rescan timer fires, on the timer's goroutine.
func (w *Watcher) tock() {
	select {
	case w.tick <- struct{}{}:
	case <-w.ctx.Done():
	}
}

func (w *Watcher) takeKits() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.kits = w.next
}

// event handles one file event: it starts or restarts the debounce of each
// instance the event names.
func (w *Watcher) event(ev fsnotify.Event) {
	if ev.Op == fsnotify.Chmod {
		return
	}
	dir, name := filepath.Dir(ev.Name), filepath.Base(ev.Name)
	matched := false
	for _, wt := range w.byDir[dir] {
		if locate.Match(wt.pattern, name) {
			w.schedule(instKey{wt.watchKey, wt.fileName(name)})
			matched = true
		}
	}
	if !matched {
		w.tracef("ignore %s", ev.Name)
	}
}

// fileName returns the name of the instance that name, a matching file in the
// folder, is. A pattern without "*" names the file: the file systems that
// ignore case read every spelling of it as the same file, so it is one
// instance.
func (wt *watch) fileName(name string) string {
	if strings.Contains(wt.pattern, "*") {
		return name
	}
	return wt.pattern
}

// schedule starts or restarts the debounce timer of an instance.
func (w *Watcher) schedule(key instKey) {
	if p := w.pending[key]; p != nil {
		p.timer.Stop()
	}
	p := &pending{key: key}
	w.pending[key] = p
	ctx := w.ctx
	p.timer = w.clock.AfterFunc(w.debounce, func() {
		select {
		case w.due <- p:
		case <-ctx.Done():
		}
	})
	w.tracef("schedule %s", filepath.Join(key.dir, key.name))
}

// settle reports the change of an instance whose debounce ran out, when its
// source still watches the folder and the file exists.
func (w *Watcher) settle(key instKey) {
	wt := w.watches[key.watchKey]
	if wt == nil {
		return
	}
	path := filepath.Join(key.dir, key.name)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		w.tracef("gone %s", path)
		return
	}
	rel := key.name
	if wt.rel != "" {
		rel = wt.rel + "/" + key.name
	}
	sum := sha256.Sum256([]byte(rel))
	w.onChange(Change{
		Kit:      key.kit,
		SourceID: key.source,
		Instance: hex.EncodeToString(sum[:]),
		Path:     path,
		ModTime:  info.ModTime(),
	})
}

// rescan resolves the globs of every source again, and brings the folder
// watches in line with them.
func (w *Watcher) rescan() {
	want := map[watchKey]*watch{}
	for _, k := range w.kits {
		for _, s := range k.Sources {
			if s.Type != "file" {
				w.warnOnce("type\x00"+k.Kit+"\x00"+s.ID, "ignoring a source of a type the bridge cannot watch",
					"kit", k.Kit, "source", s.ID, "type", s.Type)
				continue
			}
			list, err := resolve(k, s)
			if err != nil {
				w.warnOnce("path\x00"+k.Kit+"\x00"+s.ID, "cannot watch a source",
					"kit", k.Kit, "source", s.ID, "error", err)
				continue
			}
			for _, wt := range list {
				want[wt.watchKey] = wt
			}
		}
	}
	wanted := map[string]bool{}
	for key := range want {
		wanted[key.dir] = true
	}

	// fsnotify drops the watch of a folder that is removed or renamed. A
	// watch follows its folder, so when an ancestor is renamed, as when WoW's
	// WTF folder is renamed to reset the UI, the path can name a new folder
	// that the watch does not see. That watch starts again.
	listed := map[string]bool{}
	for _, dir := range w.fsw.WatchList() {
		listed[dir] = true
	}
	changed := false
	for dir, was := range w.dirs {
		keep := listed[dir] && wanted[dir]
		if keep {
			now, err := os.Stat(dir)
			keep = err == nil && os.SameFile(was, now)
		}
		if listed[dir] && !keep {
			w.fsw.Remove(dir)
		}
		if !keep {
			delete(w.dirs, dir)
			changed = true
		}
	}
	added := map[string]bool{}
	for _, dir := range slices.Sorted(maps.Keys(wanted)) {
		if w.dirs[dir] != nil {
			continue
		}
		// Stat comes first: if the folder is replaced before Add, the next
		// rescan finds that the watch is not on the folder Stat saw.
		info, err := os.Stat(dir)
		if err == nil {
			// On Windows, SameFile reads the file ID on first use; read it now.
			os.SameFile(info, info)
			err = w.fsw.Add(dir)
		}
		if err != nil {
			w.warnOnce("add\x00"+dir, "cannot watch a folder", "error", err)
			continue
		}
		delete(w.warned, "add\x00"+dir)
		w.dirs[dir] = info
		added[dir] = true
		changed = true
	}

	old := w.watches
	w.watches = map[watchKey]*watch{}
	w.byDir = map[string][]*watch{}
	for key, wt := range want {
		if w.dirs[key.dir] == nil {
			continue
		}
		w.watches[key] = wt
		w.byDir[key.dir] = append(w.byDir[key.dir], wt)
		if added[key.dir] || old[key] == nil {
			w.scheduleExisting(wt)
		}
	}
	for key, p := range w.pending {
		if w.watches[key.watchKey] == nil {
			p.timer.Stop()
			delete(w.pending, key)
		}
	}
	if changed {
		w.log.Info("watching source folders", "folders", len(w.dirs))
	}
	w.tracef("rescan")
}

// scheduleExisting starts the debounce of each instance already in the
// folder of a new watch. Its file may have been written before the watch
// started.
func (w *Watcher) scheduleExisting(wt *watch) {
	entries, err := os.ReadDir(wt.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if locate.Match(wt.pattern, e.Name()) {
			w.schedule(instKey{wt.watchKey, wt.fileName(e.Name())})
		}
	}
}

// resolve returns the watches of a source: one for each folder under the
// kit's root that the source path's parent matches.
func resolve(k Kit, s manifest.Source) ([]*watch, error) {
	if !filepath.IsAbs(k.Root) {
		return nil, fmt.Errorf("the game folder %q is not a full path", k.Root)
	}
	if err := manifest.CheckRelative(s.Path); err != nil {
		return nil, fmt.Errorf("the path %q %w", s.Path, err)
	}
	root := filepath.Clean(k.Root)
	segs := manifest.Segments(s.Path)
	dirs := []string{root}
	if len(segs) > 1 {
		var err error
		// Glob checks that each folder is inside root.
		dirs, err = locate.Glob(root, strings.Join(segs[:len(segs)-1], "/"))
		if err != nil {
			return nil, err
		}
	}
	var list []*watch
	for _, dir := range dirs {
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			continue
		}
		rel, err := filepath.Rel(root, dir)
		if err != nil {
			continue
		}
		if rel == "." {
			rel = ""
		}
		list = append(list, &watch{
			watchKey: watchKey{kit: k.Kit, source: s.ID, dir: dir},
			rel:      filepath.ToSlash(rel),
			pattern:  segs[len(segs)-1],
		})
	}
	return list, nil
}

// warnOnce logs a warning, unless the problem named key was logged before.
func (w *Watcher) warnOnce(key, msg string, args ...any) {
	if w.warned[key] {
		return
	}
	w.warned[key] = true
	w.log.Warn(msg, args...)
}

func (w *Watcher) tracef(format string, args ...any) {
	if w.trace != nil {
		w.trace(fmt.Sprintf(format, args...))
	}
}
