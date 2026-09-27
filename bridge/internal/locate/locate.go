// Package locate finds a kit's game folder, its root, and the paths a
// manifest names under it (docs/architecture.md §6.1).
//
// # Globs
//
// Manifest paths have one wildcard, "*". It matches any run of characters,
// including none, within one path segment. It never matches a separator, so
// "*" does not reach into subfolders. Every other character is literal: there
// is no "?", "[...]", "**", or escape. Both "/" and "\" separate segments, on
// every OS. A segment without "*" names a file or folder, and the OS decides
// whether its case must match. A segment with "*" is matched against the
// folder's entries, ignoring case on Windows and macOS, whose default file
// systems ignore it. §6.1 uses only "*"; add more syntax only when the spec
// does.
//
// # The locate chain
//
// Root tries the root remembered from before, then each root.locate entry in
// order. A path entry is expanded: its variable, when it has one, and then its
// globs. Each existing folder it matches is a candidate. A prompt entry asks
// the Prompter for a folder. A candidate counts only when root.verify matches
// under it. The caller remembers the result for this device (package config).
//
// A path the OS does not let the bridge read does not count, and the chain
// goes on. macOS refuses a folder in Documents until the user allows the
// bridge to read it (§6.6.1). A Prompter that is also a Refuser is told of
// each refused path.
//
// # Staying under root
//
// Glob checks the text of a relative path (manifest.CheckRelative), and then
// each path it resolves: the path the OS would open must be inside root, and
// not root itself. On Windows, filepath.Abs asks the OS to resolve the path
// (GetFullPathName), with the OS's own rules, such as stripping trailing dots
// and spaces. Links are followed: a user may keep a folder elsewhere and link
// it, and a manifest cannot make a link.
//
// {PROGRAM_FILES_X86} and the defaults of DefaultEnv are adapted from
// bttf/wow-guide@df80260, bridge/internal/wow (Candidates).
package locate

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	"github.com/bttf/ogremcp/bridge/internal/manifest"
)

var (
	// ErrNotFound means no entry of the locate chain gave a folder that
	// verifies, and the user picked none.
	ErrNotFound = errors.New("the game folder was not found")
	// ErrWrongFolder means the user picked a folder that does not verify.
	ErrWrongFolder = errors.New("the chosen folder is not the game folder")
)

// Prompter asks the user for the game folder. The tray implements it with a
// folder picker (§7).
type Prompter interface {
	// PickFolder shows a folder picker titled title, the manifest's prompt,
	// and returns the folder the user picked, or "" when the user cancels.
	PickFolder(ctx context.Context, title string) (string, error)
}

// Refuser is told of each path of the locate chain that the OS did not let
// the bridge read. Root calls Refused when its Prompter is a Refuser, and goes
// on with the chain.
type Refuser interface {
	Refused(path string)
}

// refusals tells its Refuser, when it has one, of each path whose error is a
// refusal.
type refusals struct{ to Refuser }

func (r refusals) check(path string, err error) {
	if r.to != nil && errors.Is(err, fs.ErrPermission) {
		r.to.Refused(path)
	}
}

// Env holds the values of the manifest's variables on this device. An empty
// value leaves its variable undefined, and a path entry that starts with it is
// skipped.
type Env struct {
	// ProgramFilesX86 is {PROGRAM_FILES_X86}.
	ProgramFilesX86 string
	// Home is {HOME}.
	Home string
}

// DefaultEnv returns the variables of this device. {PROGRAM_FILES_X86} is
// defined on Windows only: the ProgramFiles(x86) environment variable, or
// C:\Program Files (x86) when it is unset. {HOME} is the user's home folder.
func DefaultEnv() Env {
	var env Env
	if runtime.GOOS == "windows" {
		env.ProgramFilesX86 = os.Getenv("ProgramFiles(x86)")
		if env.ProgramFilesX86 == "" {
			env.ProgramFilesX86 = `C:\Program Files (x86)`
		}
	}
	env.Home, _ = os.UserHomeDir()
	return env
}

// Root runs the locate chain of r and returns the game's root folder.
// remembered, when not "", is the root found before; it is tried first. p may
// be nil, and prompt entries are then skipped. Root returns ErrNotFound when
// nothing verified, and an error that wraps ErrWrongFolder when the user
// picked a folder that does not verify.
func Root(ctx context.Context, r manifest.Root, remembered string, env Env, p Prompter) (string, error) {
	var refused refusals
	refused.to, _ = p.(Refuser)
	if remembered != "" && filepath.IsAbs(remembered) {
		ok, err := verifies(remembered, r.Verify, refused)
		if err != nil {
			return "", err
		}
		if ok {
			return filepath.Clean(remembered), nil
		}
	}
	for _, e := range r.Locate {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		switch {
		case e.Path != "":
			for _, dir := range expand(e.Path, env, refused) {
				ok, err := verifies(dir, r.Verify, refused)
				if err != nil {
					return "", err
				}
				if ok {
					return dir, nil
				}
			}
		case e.Prompt != "" && p != nil:
			dir, err := p.PickFolder(ctx, e.Prompt)
			if err != nil {
				return "", err
			}
			if dir == "" {
				continue
			}
			if !filepath.IsAbs(dir) {
				return "", fmt.Errorf("%w: %q is not a full path", ErrWrongFolder, dir)
			}
			ok, err := verifies(dir, r.Verify, refused)
			if err != nil {
				return "", err
			}
			if !ok {
				return "", fmt.Errorf("%w: nothing in %s matches %q", ErrWrongFolder, dir, r.Verify)
			}
			return filepath.Clean(dir), nil
		}
	}
	return "", ErrNotFound
}

// verifies reports whether dir is a folder and root.verify, pattern, matches
// under it.
func verifies(dir, pattern string, refused refusals) (bool, error) {
	if !isDir(dir, refused) {
		return false, nil
	}
	matches, err := glob(dir, pattern, refused)
	return len(matches) > 0, err
}

// expand returns the existing folders a locate path matches. A path that
// starts with an undefined variable, or that is not absolute on this OS once
// its variable is expanded, matches nothing.
func expand(path string, env Env, refused refusals) []string {
	base, rest := "", path
	if filepath.IsAbs(path) {
		vol := filepath.VolumeName(path)
		base, rest = vol+string(filepath.Separator), path[len(vol):]
	}
	for _, v := range []struct{ name, value string }{
		{manifest.VarProgramFilesX86, env.ProgramFilesX86},
		{manifest.VarHome, env.Home},
	} {
		if after, ok := strings.CutPrefix(path, v.name); ok {
			// The value is literal: a "*" in it is not a glob.
			base, rest = v.value, after
			break
		}
	}
	if !filepath.IsAbs(base) {
		return nil
	}
	var dirs []string
	for _, p := range walk(base, manifest.Segments(rest), refused) {
		if isDir(p, refused) {
			dirs = append(dirs, p)
		}
	}
	return dirs
}

// Glob returns the existing files and folders under root that rel, a relative
// manifest path, matches, sorted. It returns an error when rel is not a valid
// relative path, or when a path it resolves would leave root. Like
// filepath.Glob, it ignores file system errors, such as a folder it cannot
// read.
func Glob(root, rel string) ([]string, error) {
	return glob(root, rel, refusals{})
}

// glob is Glob, and tells refused of each path the OS did not let it read.
func glob(root, rel string, refused refusals) ([]string, error) {
	if err := manifest.CheckRelative(rel); err != nil {
		return nil, fmt.Errorf("the path %q %w", rel, err)
	}
	matches := walk(root, manifest.Segments(rel), refused)
	for _, p := range matches {
		if !inside(root, p) {
			return nil, fmt.Errorf("the path %q leaves the game folder", rel)
		}
	}
	return matches, nil
}

// walk returns the existing paths under base that segs match, sorted. Every
// segment but the last must match a folder.
func walk(base string, segs []string, refused refusals) []string {
	paths := []string{base}
	for i, seg := range segs {
		var next []string
		for _, dir := range paths {
			for _, name := range entries(dir, seg, refused) {
				p := filepath.Join(dir, name)
				if i == len(segs)-1 || isDir(p, refused) {
					next = append(next, p)
				}
			}
		}
		paths = next
	}
	slices.Sort(paths)
	return paths
}

// entries returns the names in dir that seg, one segment, matches.
func entries(dir, seg string, refused refusals) []string {
	if !strings.Contains(seg, "*") {
		p := filepath.Join(dir, seg)
		if _, err := os.Stat(p); err != nil {
			refused.check(p, err)
			return nil
		}
		return []string{seg}
	}
	list, err := os.ReadDir(dir)
	if err != nil {
		refused.check(dir, err)
		return nil
	}
	var names []string
	for _, e := range list {
		if Match(seg, e.Name()) {
			names = append(names, e.Name())
		}
	}
	return names
}

// foldCase is whether Match ignores case: on Windows and macOS, whose default
// file systems do.
var foldCase = runtime.GOOS == "windows" || runtime.GOOS == "darwin"

// Match reports whether name, one path segment, matches pattern, a segment in
// which "*" matches any run of characters, including none. Every other
// character is literal.
func Match(pattern, name string) bool {
	if foldCase {
		pattern, name = strings.ToLower(pattern), strings.ToLower(name)
	}
	parts := strings.Split(pattern, "*")
	first, last := parts[0], parts[len(parts)-1]
	if len(parts) == 1 {
		return name == first
	}
	if !strings.HasPrefix(name, first) {
		return false
	}
	name = name[len(first):]
	for _, part := range parts[1 : len(parts)-1] {
		i := strings.Index(name, part)
		if i < 0 {
			return false
		}
		name = name[i+len(part):]
	}
	return strings.HasSuffix(name, last)
}

// inside reports whether p is under root, and not root itself, once the OS
// has resolved both.
func inside(root, p string) bool {
	r, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	q, err := filepath.Abs(p)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(r, q)
	return err == nil && rel != "." && filepath.IsLocal(rel)
}

// isDir reports whether path is a folder. It tells refused when the OS did
// not let it read path.
func isDir(path string, refused refusals) bool {
	info, err := os.Stat(path)
	refused.check(path, err)
	return err == nil && info.IsDir()
}
