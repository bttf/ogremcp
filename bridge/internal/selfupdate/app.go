package selfupdate

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// The most a zipped .app may unpack to.
const (
	maxAppBytes   = 512 << 20
	maxAppEntries = 10000
)

// errUnsafeZip means an entry of the zipped .app would land outside its
// bundle, or is not a plain file or folder.
var errUnsafeZip = errors.New("the app zip has an unsafe entry")

// newAppStage creates the folder beside app that the new bundle is unpacked
// into.
func newAppStage(app string) (string, error) {
	return os.MkdirTemp(filepath.Dir(app), stagePrefix+"*")
}

// putApp unpacks data, a zipped .app as scripts/macos-app.sh zips it, into
// stage, and puts the new bundle in place of app. check verifies the new
// bundle first, and the new bundle must hold Contents/MacOS/exe, the running
// binary's name. The running bundle is renamed aside to stage+".old", which
// Cleanup removes at the next start. When the new bundle cannot be renamed
// into place, the old one is renamed back.
func putApp(ctx context.Context, stage, app, exe string, data []byte, check func(bundle string) error) error {
	bundle, err := unpackApp(stage, data)
	if err != nil {
		return err
	}
	info, err := os.Stat(filepath.Join(bundle, "Contents", "MacOS", exe))
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("the new app has no Contents/MacOS/%s", exe)
	}
	if err := check(bundle); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	old := stage + ".old"
	if err := os.Rename(app, old); err != nil {
		return fmt.Errorf("could not move the running app aside: %w", err)
	}
	if err := os.Rename(bundle, app); err != nil {
		if rerr := os.Rename(old, app); rerr != nil {
			return fmt.Errorf("could not put the new app in place: %w; the old app is at %s, and could not be moved back: %w", err, old, rerr)
		}
		return fmt.Errorf("could not put the new app in place: %w", err)
	}
	// Empty now.
	os.Remove(stage)
	return nil
}

// unpackApp unpacks data into stage, a new, empty folder, and returns the
// bundle's path. Every entry must be under one folder whose name ends in
// .app. An absolute path, a colon, a backslash, an empty, "." or ".." part, a
// symbolic link, or any other special file fails the whole zip before
// anything is written. A file keeps its executable bits. Every write goes
// through stage, so no entry can leave it.
func unpackApp(stage string, data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("could not read the app zip: %w", err)
	}
	if len(zr.File) == 0 || len(zr.File) > maxAppEntries {
		return "", fmt.Errorf("%w: it has %d entries", errUnsafeZip, len(zr.File))
	}
	top, _, _ := strings.Cut(zr.File[0].Name, "/")
	if !strings.HasSuffix(top, ".app") {
		return "", fmt.Errorf("%w: %q is not in an .app folder", errUnsafeZip, zr.File[0].Name)
	}
	var total uint64
	for _, f := range zr.File {
		if err := checkAppEntry(f, top); err != nil {
			return "", err
		}
		total += f.UncompressedSize64
	}
	if total > maxAppBytes {
		return "", fmt.Errorf("%w: too large when unpacked", errUnsafeZip)
	}

	r, err := os.OpenRoot(stage)
	if err != nil {
		return "", err
	}
	defer r.Close()
	budget := int64(maxAppBytes)
	for _, f := range zr.File {
		target := filepath.FromSlash(strings.TrimSuffix(f.Name, "/"))
		if f.FileInfo().IsDir() {
			if err := r.MkdirAll(target, 0o755); err != nil {
				return "", err
			}
			continue
		}
		if err := r.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return "", err
		}
		n, err := writeAppEntry(r, f, target, budget)
		if err != nil {
			return "", err
		}
		budget -= n
	}
	return filepath.Join(stage, top), nil
}

func checkAppEntry(f *zip.File, top string) error {
	name := f.Name
	unsafe := func(why string) error { return fmt.Errorf("%w: %q %s", errUnsafeZip, name, why) }
	if !strings.HasPrefix(name, top+"/") {
		return unsafe("is outside " + top)
	}
	if strings.ContainsAny(name, "\\:\x00") {
		return unsafe("has a backslash, colon, or NUL")
	}
	if !filepath.IsLocal(filepath.FromSlash(name)) {
		return unsafe("is not a local path")
	}
	for _, part := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		if strings.Trim(part, ".") == "" {
			return unsafe("has an empty, \".\", or \"..\" part")
		}
	}
	if mode := f.Mode(); !mode.IsRegular() && !mode.IsDir() {
		return unsafe("is a symbolic link or special file")
	}
	return nil
}

// writeAppEntry creates target under r, which must not exist, copies at most
// budget bytes of f into it, and flushes it to disk. The file is executable
// when f is.
func writeAppEntry(r *os.Root, f *zip.File, target string, budget int64) (int64, error) {
	rc, err := f.Open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()
	perm := os.FileMode(0o644)
	if f.Mode()&0o111 != 0 {
		perm = 0o755
	}
	out, err := r.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(rc, budget+1))
	if err == nil && n > budget {
		err = fmt.Errorf("%w: too large when unpacked", errUnsafeZip)
	}
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return n, err
}
