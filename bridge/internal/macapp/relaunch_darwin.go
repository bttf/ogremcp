//go:build darwin

package macapp

import (
	"fmt"
	"os/exec"
	"strings"
)

// Relaunch opens the app at app as a new instance, beside the running one,
// with env (NAME=value) in its environment, and the caller then quits. The
// new instance finds the single-instance lock (package lock) held until the
// caller quits, and env tells it to wait for the lock. When open fails,
// nothing has started, and the caller keeps running. Self-update (package
// selfupdate) and the move to ~/Applications both start the app this way.
func Relaunch(app, env string) error {
	out, err := exec.Command("/usr/bin/open", "-n", "--env", env, app).CombinedOutput()
	if err != nil {
		return fmt.Errorf("could not open %s: %w: %s", app, err, strings.TrimSpace(string(out)))
	}
	return nil
}
