//go:build windows

package selfupdate

import (
	"context"
	"os"
	"os/exec"
	"runtime"
)

// assetName is the Windows asset: the unsigned amd64 binary (§7, D6).
func assetName(version string) (string, error) {
	if runtime.GOARCH != "amd64" {
		return "", ErrUnsupported
	}
	return project + "_" + version + "_windows_amd64.exe", nil
}

// installPath is the running program.
func installPath() (string, error) { return executable() }

func newStage(exe string) (string, error) { return newExeStage(exe) }

func put(ctx context.Context, stage, exe string, data []byte) error {
	return putExe(ctx, stage, exe, data)
}

// relaunch starts the program at exe, which runs as the tray app.
func relaunch(exe, from string) error {
	cmd := exec.Command(exe)
	cmd.Env = append(os.Environ(), EnvUpdatedFrom+"="+from)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
