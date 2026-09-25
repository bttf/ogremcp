package autostart

import "os"

// New is the login item that runs args, a LaunchAgent of the current user.
// args[0] is the executable: inside an .app bundle, the binary in
// Contents/MacOS, so that the app's Info.plist applies. launchd writes the
// app's standard error to stderrPath.
func New(args []string, stderrPath string) (Manager, error) {
	if len(args) > 0 && Translocated(args[0]) {
		return nil, ErrTranslocated
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return LaunchAgent{Path: launchAgentPath(home, Label), Label: Label, Args: args, Stderr: stderrPath}, nil
}
