package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/ncruces/zenity"

	"github.com/bttf/ogmcp/bridge/internal/auth"
	"github.com/bttf/ogmcp/bridge/internal/config"
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

// serverTitle is the title of the server dialogs.
const serverTitle = "Open Gamer MCP server"

// askServer asks for the server in a text dialog that starts with current,
// the server in use, and confirms the change. It is the tray's
// Controller.AskServer (§13.3). An empty entry means the hosted service. An
// entry that auth.ParseBaseURL refuses is shown, and asked for again. It
// returns false when the user cancels or enters the server in use. While
// OGMCP_BASE_URL is set, which overrides server_url, it says so and returns
// false.
func askServer(ctx context.Context, current string) (string, bool, error) {
	if os.Getenv(config.EnvServerURL) != "" {
		err := zenity.Info(config.EnvServerURL+" sets the server, "+current+". To choose the server here, remove "+config.EnvServerURL+" and start the bridge again.",
			zenity.Title(serverTitle), zenity.Context(ctx))
		return "", false, ignoreCancel(err)
	}
	text := current
	for {
		entry, err := zenity.Entry("The bridge uploads to "+current+".\n\nTo use your own server, enter its address, such as https://ogmcp.example.com. Leave it empty to use the hosted service.",
			zenity.Title(serverTitle), zenity.EntryText(text), zenity.Context(ctx))
		if err != nil {
			return "", false, ignoreCancel(err)
		}
		text = strings.TrimSpace(entry)
		value, base := "", config.DefaultServerURL
		if text != "" {
			if base, err = auth.ParseBaseURL(text); err != nil {
				msg := err.Error()
				if err := zenity.Error(strings.ToUpper(msg[:1])+msg[1:], zenity.Title(serverTitle), zenity.Context(ctx)); ignoreCancel(err) != nil {
					return "", false, err
				}
				continue
			}
			value = base
		}
		if base == current {
			return "", false, nil
		}
		err = zenity.Question("Change the server to "+base+"?\n\nThe bridge stops uploading to "+current+" and uses its login for "+base+". If it has none, the menu asks you to log in. The login for "+current+" stays saved, so changing back needs no new login.",
			zenity.Title(serverTitle), zenity.OKLabel("Change"), zenity.Context(ctx))
		if err != nil {
			return "", false, ignoreCancel(err)
		}
		return value, true, nil
	}
}

// ignoreCancel is err, or nil when the user canceled the dialog.
func ignoreCancel(err error) error {
	if errors.Is(err, zenity.ErrCanceled) {
		return nil
	}
	return err
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
// not wait for the browser. When the program that opens it fails, it logs
// that to slog.Default, without the URL, which can hold a login code.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/pair/pair.go
// (OpenBrowser), which did not log the failure.
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
	go func() {
		if err := cmd.Wait(); err != nil {
			slog.Warn("could not open the browser", "program", cmd.Path, "error", err.Error())
		}
	}()
	return nil
}
