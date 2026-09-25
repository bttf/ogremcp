package adapter

import (
	"bufio"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/bttf/ogmcp/bridge/internal/locate"
	"github.com/bttf/ogmcp/bridge/internal/manifest"
)

// The temporary folders beside the adapter folder. The game loads an addon
// folder only when it holds a TOC of its own name, so it never loads these.
const (
	stagePrefix = ".ogmcp-new-"
	oldPrefix   = ".ogmcp-old-"
)

// rename is (*os.Root).Rename; tests make it fail.
var rename = func(r *os.Root, from, to string) error { return r.Rename(from, to) }

// kind is what sits at an adapter folder's path.
type kind int

const (
	// missing: nothing is there.
	missing kind = iota
	// folder: a folder.
	folder
	// linked: a symbolic link or, on Windows, a junction, as
	// kits/wow/scripts/link-addon.sh makes for a developer.
	linked
	// other: a file or anything else.
	other
)

// place is where adapter.install puts one adapter folder: in the folder
// base/rel..., its parent. base exists: it is root, or a folder the glob part
// of adapter.install matched. The folders of rel are literal, and need not
// exist yet: on a first install, the adapter folder is missing, and so may be
// the folders above it, such as Interface/AddOns in a new game folder.
type place struct {
	base string
	rel  []string
}

// dir is the adapter folder's parent.
func (p place) dir() string {
	return filepath.Join(append([]string{p.base}, p.rel...)...)
}

// parents returns the places adapter.install puts the adapter folder under
// root, and the adapter folder's name: install's last segment, which has no
// "*". The segments up to the last one with a "*" are a glob, and expand to
// each existing folder they match (§6.1: each flavor folder).
func parents(root, install string) ([]place, string, error) {
	if err := manifest.CheckRelative(install); err != nil {
		return nil, "", fmt.Errorf("adapter.install %q %w", install, err)
	}
	segs := manifest.Segments(install)
	name := segs[len(segs)-1]
	if strings.Contains(name, "*") || !filepath.IsLocal(name) {
		return nil, "", fmt.Errorf("adapter.install %q must end in the adapter's folder name, without a \"*\"", install)
	}
	dirs := segs[:len(segs)-1]
	glob := 0
	for i, s := range dirs {
		if strings.Contains(s, "*") {
			glob = i + 1
		}
	}
	bases := []string{root}
	if glob > 0 {
		matches, err := locate.Glob(root, strings.Join(dirs[:glob], "/"))
		if err != nil {
			return nil, "", err
		}
		bases = bases[:0]
		for _, m := range matches {
			if info, err := os.Stat(m); err == nil && info.IsDir() {
				bases = append(bases, m)
			}
		}
	}
	var out []place
	for _, b := range bases {
		out = append(out, place{base: b, rel: dirs[glob:]})
	}
	return out, name, nil
}

// openParent opens dir as a Root, or returns nil when dir does not exist.
// Links on the way are followed: a player may keep Interface/AddOns elsewhere
// and link it (owner decision on RED-319). The Root is the resolved folder, so
// every later write stays in it.
func openParent(dir string) (*os.Root, error) {
	resolved, err := filepath.EvalSymlinks(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return os.OpenRoot(resolved)
}

// makeParent creates the missing folders of p's parent and opens the parent
// as a Root (openParent). It creates them through a Root on the deepest
// folder of the parent's path that exists, at or below p.base. It is called
// only when an install will happen.
func makeParent(p place) (*os.Root, error) {
	i := len(p.rel)
	for ; i > 0; i-- {
		_, err := os.Stat(place{base: p.base, rel: p.rel[:i]}.dir())
		if err == nil {
			break
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}
	r, err := openParent(place{base: p.base, rel: p.rel[:i]}.dir())
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, fmt.Errorf("%s no longer exists", p.base)
	}
	if i == len(p.rel) {
		return r, nil
	}
	defer r.Close()
	rest := filepath.Join(p.rel[i:]...)
	if err := r.MkdirAll(rest, 0o755); err != nil {
		return nil, err
	}
	return r.OpenRoot(rest)
}

// inspect reports what sits at name under r, without following a link.
func inspect(r *os.Root, name string) (kind, error) {
	info, err := r.Lstat(name)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return missing, nil
	case err != nil:
		return other, err
	case info.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0:
		return linked, nil
	case info.IsDir():
		return folder, nil
	}
	return other, nil
}

// maxTOC is the most bytes read of one TOC file.
const maxTOC = 1 << 20

// tocVersion returns the adapter's version in dir, a folder of fsys: the
// ## Version line of the .toc files at its top, which must all name the
// same one. It is the version GET /api/v1/kits lists (§8.2), which the
// platform reads the same way.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/addon/install.go
// (InstalledVersion).
func tocVersion(fsys fs.FS, dir string) (Version, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return Version{}, err
	}
	var found *Version
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || strings.HasPrefix(name, ".") || !strings.EqualFold(path.Ext(name), ".toc") {
			continue
		}
		v, err := readTOC(fsys, path.Join(dir, name))
		if err != nil {
			return Version{}, fmt.Errorf("%s: %w", name, err)
		}
		if found != nil && found.Compare(v) != 0 {
			return Version{}, errors.New("the .toc files name different versions")
		}
		found = &v
	}
	if found == nil {
		return Version{}, errors.New("the adapter folder has no .toc file")
	}
	return *found, nil
}

func readTOC(fsys fs.FS, name string) (Version, error) {
	f, err := fsys.Open(name)
	if err != nil {
		return Version{}, err
	}
	defer f.Close()
	s := bufio.NewScanner(io.LimitReader(f, maxTOC))
	for s.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(s.Text(), "\uFEFF"))
		if !strings.HasPrefix(line, "##") {
			continue
		}
		key, value, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(line, "##")), ":")
		if ok && strings.EqualFold(strings.TrimSpace(key), "Version") {
			return ParseVersion(value)
		}
	}
	if err := s.Err(); err != nil {
		return Version{}, err
	}
	return Version{}, errors.New("no ## Version line")
}

// install unpacks the zip data into a new folder beside name, under r, and
// swaps it in by rename (§7). The zip's TOC must name want. When a folder is
// at name, it is renamed aside first, and removed only once the new folder is
// in place; when the second rename fails, it is renamed back. A link or other
// non-folder at name is never replaced.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/addon/install.go
// (Install).
func install(r *os.Root, name string, data []byte, want Version) error {
	stage := stagePrefix + rand.Text()
	if err := r.Mkdir(stage, 0o755); err != nil {
		return err
	}
	defer r.RemoveAll(stage)
	if err := unpack(r, stage, name, data, want); err != nil {
		return err
	}
	// The new folder must be a folder, not a link put in its place.
	fresh := filepath.Join(stage, name)
	if k, err := inspect(r, fresh); err != nil || k != folder {
		return errors.Join(errors.New("the unpacked adapter is not a folder"), err)
	}

	k, err := inspect(r, name)
	switch {
	case err != nil:
		return err
	case k == linked || k == other:
		return errors.New("the adapter folder is a link or not a folder; it is left as it is")
	case k == missing:
		return rename(r, fresh, name)
	}
	old := oldPrefix + rand.Text()
	if err := rename(r, name, old); err != nil {
		return err
	}
	if err := rename(r, fresh, name); err != nil {
		if rerr := rename(r, old, name); rerr != nil {
			return fmt.Errorf("%w; putting the old adapter folder back failed too, so it is kept as %s: %v", err, old, rerr)
		}
		return err
	}
	// A folder left behind is removed at the next sync (tidy).
	r.RemoveAll(old)
	return nil
}

// unpack extracts the zip data into stage, a new folder under r, through a
// Root on stage, and checks that its TOC names want. The Root is closed
// before install renames anything.
func unpack(r *os.Root, stage, name string, data []byte, want Version) error {
	sr, err := r.OpenRoot(stage)
	if err != nil {
		return err
	}
	defer sr.Close()
	if err := extract(sr, data, name); err != nil {
		return err
	}
	got, err := tocVersion(sr.FS(), name)
	if err != nil {
		return fmt.Errorf("the adapter zip: %w", err)
	}
	if got.Compare(want) != 0 {
		return fmt.Errorf("the adapter zip holds version %s, not the listed %s", got, want)
	}
	return nil
}

// tidy removes the temporary folders an earlier install left beside name
// under r, as when the bridge stopped part way. An old adapter folder is
// removed only while a folder is at name, so the old one stays until a swap
// has succeeded.
func tidy(r *os.Root, name string) {
	entries, err := fs.ReadDir(r.FS(), ".")
	if err != nil {
		return
	}
	k, err := inspect(r, name)
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, stagePrefix) || (strings.HasPrefix(n, oldPrefix) && err == nil && k == folder) {
			r.RemoveAll(n)
		}
	}
}
