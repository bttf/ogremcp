package adapter

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	// maxUnpacked is the most bytes all files of a zip may hold.
	maxUnpacked = 64 << 20
	maxEntries  = 1000
)

// ErrUnsafeZip means an entry of the zip would land outside its folder, or is
// not a plain file or folder.
var ErrUnsafeZip = errors.New("the adapter zip has an unsafe entry")

// extract unpacks the zip data into dest, a folder under r, which must exist.
// Every entry must be a file or folder under folder/, the adapter's folder
// (§6.1 adapter.install; the platform zips the adapter under it). An absolute
// path, a drive letter or other ":", a backslash, an empty, "." or ".." part,
// a part Windows would read as one, a symbolic link, or any other special file
// fails the whole zip with ErrUnsafeZip before anything is written. Every
// write goes through r, so no entry can leave it.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/addon/unzip.go.
func extract(r *os.Root, data []byte, dest, folder string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("could not read the adapter zip: %w", err)
	}
	if len(zr.File) > maxEntries {
		return fmt.Errorf("%w: too many entries", ErrUnsafeZip)
	}
	var total uint64
	for _, f := range zr.File {
		if err := checkEntry(f, folder); err != nil {
			return err
		}
		total += f.UncompressedSize64
	}
	if total > maxUnpacked {
		return fmt.Errorf("%w: too large when unpacked", ErrUnsafeZip)
	}

	budget := int64(maxUnpacked)
	for _, f := range zr.File {
		target := filepath.Join(dest, filepath.FromSlash(strings.TrimSuffix(f.Name, "/")))
		if f.FileInfo().IsDir() {
			if err := r.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := r.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		n, err := writeEntry(r, f, target, budget)
		if err != nil {
			return err
		}
		budget -= n
	}
	return nil
}

func checkEntry(f *zip.File, folder string) error {
	name := f.Name
	unsafe := func(why string) error { return fmt.Errorf("%w: %q %s", ErrUnsafeZip, name, why) }
	if !strings.HasPrefix(name, folder+"/") {
		return unsafe("is outside " + folder + "/")
	}
	if strings.ContainsAny(name, "\\:\x00") {
		return unsafe("has a backslash, colon, or NUL")
	}
	if !filepath.IsLocal(filepath.FromSlash(name)) {
		return unsafe("is not a local path")
	}
	for _, part := range strings.Split(strings.TrimSuffix(name, "/"), "/") {
		// Windows strips trailing dots and spaces, so it reads ".. " as "..".
		if strings.Trim(part, ". ") == "" {
			return unsafe("has an empty part, or one of only dots and spaces")
		}
	}
	if mode := f.Mode(); !mode.IsRegular() && !mode.IsDir() {
		return unsafe("is a symbolic link or special file")
	}
	return nil
}

// writeEntry creates target under r, which must not exist, and copies at most
// budget bytes of f into it.
func writeEntry(r *os.Root, f *zip.File, target string, budget int64) (int64, error) {
	rc, err := f.Open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()
	out, err := r.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, io.LimitReader(rc, budget+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n > budget {
		err = fmt.Errorf("%w: too large when unpacked", ErrUnsafeZip)
	}
	return n, err
}
