package main

import (
	"context"
	"errors"
	"os/exec"
	"runtime"

	"github.com/ncruces/zenity"
)

// pickFolder shows the OS's folder picker, titled title: an open panel on
// macOS (through osascript) and the common file dialog on Windows. It returns
// "" when the user cancels. The tray answers the manifest's prompt entry with
// it (locate.Prompter, §6.1, §7).
func pickFolder(ctx context.Context, title string) (string, error) {
	dir, err := zenity.SelectFile(zenity.Context(ctx), zenity.Directory(), zenity.Title(title))
	if errors.Is(err, zenity.ErrCanceled) {
		return "", nil
	}
	return dir, err
}

// alert shows text in a message box, for a tray app that cannot start and has
// no menu to say so.
func alert(text string) {
	_ = zenity.Info(text, zenity.Title("Open Gamer MCP"))
}

// trayPlace is where the OS shows the tray icon.
func trayPlace() string {
	if runtime.GOOS == "windows" {
		return "the notification area"
	}
	return "the menu bar"
}

// openBrowser hands a URL to the OS to open in the default browser. It does
// not wait for the browser.
//
// Copied from bttf/wow-guide@df80260, bridge/internal/pair/pair.go
// (OpenBrowser).
func openBrowser(link string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", link)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", link)
	default:
		cmd = exec.Command("xdg-open", link)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
