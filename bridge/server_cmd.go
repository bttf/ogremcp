package main

import (
	"fmt"
	"os"

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/config"
)

// server is the command `bridge server` (§13.3). Without arguments it prints
// the server and where its URL comes from. `set URL` saves URL, which must
// pass auth.ParseBaseURL, as server_url in the settings file, and `reset`
// removes server_url, so the bridge uses the hosted service. The change
// lasts across restarts, and reaches the tray app when it starts at login,
// which OGMCP_BASE_URL does not on macOS.
func server(args []string) error {
	settings, path, err := loadSettings()
	if err != nil {
		return err
	}
	env := os.Getenv(config.EnvServerURL)
	switch {
	case len(args) == 0:
		base, err := settings.Server(env)
		if err != nil {
			return err
		}
		switch {
		case env != "":
			fmt.Println(base, "(from "+config.EnvServerURL+")")
		case settings.ServerURL != "":
			fmt.Println(base, "(from server_url in "+path+")")
		default:
			fmt.Println(base, "(the hosted service)")
		}
		return nil
	case len(args) == 2 && args[0] == "set":
		base, err := auth.ParseBaseURL(args[1])
		if err != nil {
			return err
		}
		settings.ServerURL = base
	case len(args) == 1 && args[0] == "reset":
		settings.ServerURL = ""
	default:
		return errUsage
	}
	if err := config.Save(path, settings); err != nil {
		return err
	}
	base, err := settings.Server("")
	if err != nil {
		return err
	}
	fmt.Println("The bridge now uses", base+".")
	fmt.Println("It keeps a separate login for each server. Without one for this server, log in with bridge login or the tray's Log in….")
	if env != "" {
		fmt.Println(config.EnvServerURL, "is set, and overrides this setting while it is set.")
	}
	return nil
}
