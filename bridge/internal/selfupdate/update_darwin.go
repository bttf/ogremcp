//go:build darwin

package selfupdate

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
)

// assetName is the macOS asset: the universal binary in a zipped .app,
// signed and notarized (docs/releases.md).
func assetName(version string) (string, error) {
	return project + "_" + version + "_darwin_all.app.zip", nil
}

// installPath is the .app bundle the running binary is in:
// <bundle>.app/Contents/MacOS/<binary>.
func installPath() (string, error) {
	exe, err := executable()
	if err != nil {
		return "", err
	}
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	app := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || !strings.HasSuffix(app, ".app") {
		return "", fmt.Errorf("%s is not in an .app bundle", exe)
	}
	return app, nil
}

func newStage(app string) (string, error) { return newAppStage(app) }

func put(ctx context.Context, stage, app string, data []byte) error {
	exe, err := executable()
	if err != nil {
		return err
	}
	return putApp(ctx, stage, app, filepath.Base(exe), data, verifyBundle)
}

// verifyBundle checks the new bundle's code signature before it replaces the
// running one, so that a bundle that unpacked wrong never replaces one that
// opens.
func verifyBundle(bundle string) error {
	out, err := exec.Command("/usr/bin/codesign", "--verify", "--strict", bundle).CombinedOutput()
	if err != nil {
		return fmt.Errorf("the new app's code signature does not verify: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// relaunch opens the bundle at app as a new instance, beside the running one,
// which then quits.
func relaunch(app, from string) error {
	out, err := exec.Command("/usr/bin/open", "-n", "--env", EnvUpdatedFrom+"="+from, app).CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not open %s: %w: %s", app, err, strings.TrimSpace(string(out)))
	}
	return nil
}
