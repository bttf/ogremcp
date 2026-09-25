// Package process tells whether a game runs, by the adapter.process globs of
// its kit's manifest (docs/architecture.md §6.1, §7). The bridge applies an
// adapter update only while no matching process runs.
//
// A glob matches a process's executable name: the part of the name or path
// the OS lists after the last "/" or "\". The glob syntax is that of package
// locate: "*" matches any run of characters, and every other character is
// literal. Matching ignores case on every OS, as the prototype did: Windows
// reads "wow.exe" and "Wow.exe" as the same program, and a kit author should
// not have to list both.
//
// Adapted from bttf/wow-guide@df80260, bridge/internal/wow (wow.go: Lister,
// ClientRunning, IsClient; process_unix.go; process_windows.go).
package process

import (
	"strings"

	"github.com/bttf/ogmcp/bridge/internal/locate"
)

// Lister lists the executable names or paths of the running processes.
type Lister interface {
	Processes() ([]string, error)
}

// Running reports whether a process of l matches one of globs.
func Running(l Lister, globs []string) (bool, error) {
	procs, err := l.Processes()
	if err != nil {
		return false, err
	}
	for _, p := range procs {
		for _, g := range globs {
			if Match(g, p) {
				return true, nil
			}
		}
	}
	return false, nil
}

// Match reports whether process, an executable name or path, matches glob.
// Only the name after the last "/" or "\" counts, and case is ignored.
func Match(glob, process string) bool {
	name := strings.TrimSpace(process[strings.LastIndexAny(process, `/\`)+1:])
	return locate.Match(strings.ToLower(glob), strings.ToLower(name))
}
