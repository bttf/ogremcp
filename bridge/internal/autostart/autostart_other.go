//go:build !darwin && !windows

package autostart

// New returns ErrUnsupported: the tray app starts at login on macOS and
// Windows only.
func New(args []string, stderrPath string) (Manager, error) {
	return nil, ErrUnsupported
}
