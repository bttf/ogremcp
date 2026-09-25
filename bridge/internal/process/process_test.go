package process

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/bttf/ogmcp/bridge/internal/manifest"
)

type list []string

func (l list) Processes() ([]string, error) { return l, nil }

// The WoW kit's globs match every client the prototype's
// ^wow(classic)?[a-z]?(-64)?$ matched on Windows, and its macOS clients, in
// any case. The test reads the manifest from the repo; the bridge itself
// builds from nothing outside bridge/ (§5).
func TestWoWProcessGlobs(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "kits", "wow", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := manifest.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	globs := m.Adapter.Process
	for _, name := range []string{
		"Wow.exe", "WowT.exe", "WowB.exe", "Wow-64.exe", "WowT-64.exe",
		"WowClassic.exe", "WowClassicT.exe", "WowClassicB.exe", "WowClassic-64.exe", "WowClassicT-64.exe",
		"WOWCLASSIC.EXE", `C:\Program Files (x86)\World of Warcraft\_classic_era_\WowClassic.exe`,
		"World of Warcraft", "World of Warcraft Classic",
		"/Applications/World of Warcraft/_classic_era_/World of Warcraft Classic.app/Contents/MacOS/World of Warcraft Classic",
	} {
		if running, err := Running(list{"Battle.net.exe", name}, globs); !running || err != nil {
			t.Errorf("%q is not matched by %q", name, globs)
		}
	}
	if running, _ := Running(list{"Battle.net.exe", "Agent.exe", "/Applications/Battle.net.app/Contents/MacOS/Battle.net"}, globs); running {
		t.Error("the launcher counts as the game")
	}
}
