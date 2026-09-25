//go:build darwin

package macapp

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

// Relaunch opens app once this process has exited, and returns without
// waiting. The caller then quits. The new process would otherwise find the
// single-instance lock taken (package lock), and macOS could bring this
// process forward instead of starting the app.
//
// A shell waits for this process to exit and then runs open, as LetsMove's
// relaunch does.
func Relaunch(app string) error {
	const script = `while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.2; done; exec /usr/bin/open "$2"`
	cmd := exec.Command("/bin/sh", "-c", script, "sh", strconv.Itoa(os.Getpid()), app)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
