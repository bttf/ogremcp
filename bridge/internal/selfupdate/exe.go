package selfupdate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// newExeStage creates the file beside exe that the new program is written
// to.
func newExeStage(exe string) (string, error) {
	f, err := os.CreateTemp(filepath.Dir(exe), stagePrefix+"*.exe")
	if err != nil {
		return "", err
	}
	return f.Name(), f.Close()
}

// putExe writes data, the new program, to stage, and puts it in place of
// exe. Windows renames a running program but does not remove it, so the
// running one is renamed aside to stage+".old", which Cleanup removes at the
// next start. When the new one cannot be renamed into place, the old one is
// renamed back.
func putExe(ctx context.Context, stage, exe string, data []byte) error {
	f, err := os.OpenFile(stage, os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fmt.Errorf("could not write the new program: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	old := stage + ".old"
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("could not move the running program aside: %w", err)
	}
	if err := os.Rename(stage, exe); err != nil {
		if rerr := os.Rename(old, exe); rerr != nil {
			return fmt.Errorf("could not put the new program in place: %w; the old program is at %s, and could not be moved back: %w", err, old, rerr)
		}
		return fmt.Errorf("could not put the new program in place: %w", err)
	}
	return nil
}
