package process

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/bttf/ogremcp/bridge/internal/manifest"
)

type list []string

func (l list) Processes() ([]string, error) { return l, nil }

// The WoW kit's globs match its Windows clients and their test and beta
// builds, and its macOS clients, in any case. They do not match the
// Battle.net launcher or the WowUp addon manager, which often stays open in
// the tray and would keep a staged update from ever applying. The test reads
// the manifest from the repo; the bridge itself builds from nothing outside
// bridge/ (§5).
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
		"Wow.exe", "WowT.exe", "WowB.exe", "Wow-64.exe", "WowT-64.exe", "WowB-64.exe",
		"WowClassic.exe", "WowClassicT.exe", "WowClassicB.exe", "WowClassic-64.exe", "WowClassicT-64.exe",
		"WOWCLASSIC.EXE", `C:\Program Files (x86)\World of Warcraft\_classic_era_\WowClassic.exe`,
		"World of Warcraft", "World of Warcraft Classic",
		"/Applications/World of Warcraft/_classic_era_/World of Warcraft Classic.app/Contents/MacOS/World of Warcraft Classic",
	} {
		if running, err := Running(list{"Battle.net.exe", name}, globs); !running || err != nil {
			t.Errorf("%q is not matched by %q", name, globs)
		}
	}
	for _, name := range []string{"Battle.net.exe", "Agent.exe", "/Applications/Battle.net.app/Contents/MacOS/Battle.net", "WowUp.exe", "WowUpCf.exe"} {
		if running, _ := Running(list{name}, globs); running {
			t.Errorf("%q counts as the game", name)
		}
	}
}
