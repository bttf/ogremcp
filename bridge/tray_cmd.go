//go:build !darwin || cgo

package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	"fyne.io/systray"

	"github.com/bttf/ogmcp/bridge/internal/autostart"
	"github.com/bttf/ogmcp/bridge/internal/lock"
	"github.com/bttf/ogmcp/bridge/internal/logfile"
	"github.com/bttf/ogmcp/bridge/internal/tray"
)

// runTray runs the bridge as a tray app (§7): an icon in the macOS menu bar or
// the Windows notification area, with a menu that shows the status and offers
// the login, the folder picker, the server (§13.3), and start at login. It
// logs to a file
// (package logfile), and returns the exit status. On macOS it needs cgo; see
// tray_nocgo.go.
//
// Adapted from bttf/wow-guide@df80260, bridge/cmd/tray/main.go: the log
// setup, start at login, the shutdown, and the menu loop. Its pairing, config
// file, and addon toggle are dropped.
func runTray() int {
	logPath, err := logfile.DefaultPath()
	if err != nil {
		alert("Open Gamer MCP could not start: " + err.Error())
		return 1
	}
	logFile, err := logfile.Open(logPath, logfile.DefaultMaxBytes, logfile.DefaultKeep)
	if err != nil {
		alert("Open Gamer MCP could not open its log file: " + err.Error())
		return 1
	}
	defer logFile.Close()
	logger := slog.New(slog.NewTextHandler(logFile, nil))
	// Packages that log to slog.Default, and the tray library, which logs
	// with the standard logger, log to the file too.
	slog.SetDefault(logger)
	defer tray.Recover(logger)

	held, err := acquireLock()
	if errors.Is(err, lock.ErrLocked) {
		logger.Info("another bridge runs for this user; quitting")
		alert("Open Gamer MCP is already running. Its icon is in " + trayPlace() + ".")
		return 0
	}
	if err != nil {
		logger.Error("could not take the single-instance lock", "error", err.Error())
		alert("Open Gamer MCP could not start: " + err.Error())
		return 1
	}
	defer held.Release()

	settings, settingsPath, err := loadSettings()
	if err != nil {
		logger.Error("could not read the settings file", "error", err.Error())
		alert("Open Gamer MCP could not read its settings file: " + err.Error())
		return 1
	}
	client, base, err := newClient(settings)
	if err != nil {
		// A server_url the bridge refuses: it does not fall back to the
		// hosted service.
		logger.Error("could not start", "error", err.Error())
		alert("Open Gamer MCP could not start: " + err.Error())
		return 1
	}
	return runMenu(logger, logPath, &tray.Controller{
		Base:    base,
		Version: version,
		Auth:    client,
		NewAuth: func(base string) (tray.Auth, error) {
			client, err := newAuth(base)
			if err != nil {
				return nil, err
			}
			return client, nil
		},
		Settings:     settings,
		SettingsPath: settingsPath,
		Model:        &tray.Model{},
		Log:          logger,
		Open:         openBrowser,
		PickFolder:   pickFolder,
		AskServer:    askServer,
	})
}

// runMenu sets up start at login, and runs the tray until the user quits.
func runMenu(logger *slog.Logger, logPath string, ctl *tray.Controller) int {
	if exe, err := executable(); err != nil {
		logger.Warn("could not find this program's path; start at login is off", "error", err.Error())
	} else {
		m, err := autostart.New([]string{exe}, filepath.Join(filepath.Dir(logPath), "bridge.stderr.log"))
		switch {
		case err == nil:
			ctl.Autostart = m
		case errors.Is(err, autostart.ErrTranslocated):
			// Opened from Downloads or a disk image without being moved: a
			// login item would point at a copy that is gone after a restart.
			logger.Info("start at login is off until the app is moved to Applications", "reason", err.Error())
			ctl.AutostartBlocked = tray.TitleMoveApp
		default:
			logger.Info("start at login is off", "reason", err.Error())
		}
	}
	logger.Info("tray starting", "version", version, "os", runtime.GOOS, "server", ctl.Base)

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	// Ctrl-C in a terminal and SIGTERM quit as the menu's Quit does.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		sig := <-signals
		logger.Info("quitting on a signal", "signal", sig.String())
		systray.Quit()
	}()
	// The bridge stops before the process ends. The tray library calls
	// onExit on Windows and when macOS ends the app; after Quit on macOS, Run
	// just returns.
	shutdown := sync.OnceFunc(func() {
		cancel()
		select {
		case <-stopped:
		case <-time.After(5 * time.Second):
			logger.Warn("the bridge did not stop within 5 seconds")
		}
		logger.Info("tray stopped")
	})
	systray.Run(func() { onReady(ctx, ctl, logger, stopped) }, shutdown)
	shutdown()
	return 0
}

// onReady builds the menu and starts the bridge. The tray library calls it
// once the icon exists.
func onReady(ctx context.Context, ctl *tray.Controller, logger *slog.Logger, stopped chan<- struct{}) {
	defer tray.Recover(logger)
	ui := &menu{}
	ui.status = systray.AddMenuItem("", "")
	ui.status.Disable()
	ui.note = line()
	ui.err = line()
	for range tray.MaxAdapterLines {
		ui.adapters = append(ui.adapters, line())
	}
	systray.AddSeparator()
	ui.login = systray.AddMenuItem("", "")
	ui.login.Hide()
	ui.folder = systray.AddMenuItem(tray.TitleChooseFolder, "")
	ui.folder.Hide()
	server := systray.AddMenuItem(tray.TitleServer, "")
	ui.autostart = systray.AddMenuItemCheckbox(tray.TitleAutostart, "", false)
	systray.AddSeparator()
	quit := systray.AddMenuItem(tray.TitleQuit, "")

	// The model calls its listener from whichever goroutine changed it. The
	// menu is drawn from one goroutine, always with the newest View.
	changed := make(chan struct{}, 1)
	ctl.Model.Listen(func() {
		select {
		case changed <- struct{}{}:
		default:
		}
	})

	go func() {
		defer tray.Recover(logger)
		// A time on the menu names its day once it is not today.
		minute := time.NewTicker(time.Minute)
		defer minute.Stop()
		var last string
		for {
			v := ctl.Model.View(time.Now())
			if v.Status != last {
				logger.Info("menu", "status", v.Status)
				last = v.Status
			}
			ui.apply(v)
			select {
			case <-ctx.Done():
				return
			case <-changed:
			case <-minute.C:
			case <-ui.login.ClickedCh:
				ctl.Login(ctx)
			case <-ui.folder.ClickedCh:
				ctl.ChooseFolder()
			case <-server.ClickedCh:
				ctl.ChangeServer(ctx)
			case <-ui.autostart.ClickedCh:
				ctl.ToggleAutostart()
			case <-quit.ClickedCh:
				systray.Quit()
			}
		}
	}()
	go func() {
		defer tray.Recover(logger)
		ctl.Run(ctx)
		close(stopped)
	}()
}

// line adds a menu line that shows text only: disabled, and hidden until it
// has some.
func line() *systray.MenuItem {
	item := systray.AddMenuItem("", "")
	item.Disable()
	item.Hide()
	return item
}

type menu struct {
	status, note, err        *systray.MenuItem
	adapters                 []*systray.MenuItem
	login, folder, autostart *systray.MenuItem
	icon                     *bool
}

func (m *menu) apply(v tray.View) {
	if m.icon == nil || *m.icon != v.Active {
		setIcon(v.Active)
		active := v.Active
		m.icon = &active
	}
	systray.SetTooltip(v.Tooltip)
	m.status.SetTitle(v.Status)
	show(m.note, v.Note)
	show(m.err, v.Error)
	for i, item := range m.adapters {
		text := ""
		if i < len(v.Adapters) {
			text = v.Adapters[i]
		}
		show(item, text)
	}
	show(m.login, v.Login)
	enable(m.login, v.LoginEnabled)
	if v.ChooseFolder {
		m.folder.Show()
	} else {
		m.folder.Hide()
	}
	m.autostart.SetTitle(v.AutostartTitle)
	enable(m.autostart, v.AutostartEnabled)
	if v.Autostart {
		m.autostart.Check()
	} else {
		m.autostart.Uncheck()
	}
}

// show sets the title of item and shows it, or hides it when text is "".
func show(item *systray.MenuItem, text string) {
	if text == "" {
		item.Hide()
		return
	}
	item.SetTitle(text)
	item.Show()
}

func enable(item *systray.MenuItem, on bool) {
	if on {
		item.Enable()
	} else {
		item.Disable()
	}
}

func setIcon(active bool) {
	switch runtime.GOOS {
	case "darwin":
		// 36 px draws sharply at the menu bar's 18 pt on a Retina screen.
		png := tray.Icon(active, 36)
		systray.SetTemplateIcon(png, png)
	case "windows":
		systray.SetIcon(tray.ICO(tray.Icon(active, 32), 32))
	default:
		systray.SetIcon(tray.Icon(active, 32))
	}
}

// executable is the path of this program with symbolic links resolved, so a
// login item keeps working when the link it was started from changes.
func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}
