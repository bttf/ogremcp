package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// wow parses the WoW kit's manifest. The test reads it from the repo; the
// bridge itself builds from nothing outside bridge/ (§5).
func wow(t *testing.T) *Manifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "kits", "wow", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestParseWoWManifest(t *testing.T) {
	m := wow(t)
	if m.Kit != "wow" || m.ToolPrefix != "wow" {
		t.Errorf("kit %q, tool_prefix %q", m.Kit, m.ToolPrefix)
	}
	locate := m.Root.Locate
	if len(locate) < 2 || locate[0].Path != "{PROGRAM_FILES_X86}/World of Warcraft" || locate[len(locate)-1].Prompt == "" {
		t.Errorf("root.locate = %+v", locate)
	}
	if m.Root.Verify != "_*_" {
		t.Errorf("root.verify = %q", m.Root.Verify)
	}
	if m.Adapter == nil || m.Adapter.Install != "_*_/Interface/AddOns/OpenGamerMCP" || len(m.Adapter.Process) == 0 {
		t.Errorf("adapter = %+v", m.Adapter)
	}
	if len(m.Sources) != 1 || m.Sources[0].ID != "savedvariables" || m.Sources[0].Path != "_*_/WTF/Account/*/SavedVariables/OpenGamerMCP.lua" {
		t.Errorf("sources = %+v", m.Sources)
	}
	if m.Flavors["classic_era"].Status != "supported" {
		t.Errorf("flavors = %+v", m.Flavors)
	}
}

func TestParseRejectsLocateEntryShape(t *testing.T) {
	for _, entry := range []string{`{"path": "/a", "prompt": "b"}`, `{"steam": "123"}`} {
		raw := `{"kit": "wow", "root": {"locate": [` + entry + `], "verify": "x"}}`
		if _, err := Parse([]byte(raw)); err == nil || !strings.Contains(err.Error(), "exactly one of path and prompt") {
			t.Errorf("%s: %v", entry, err)
		}
	}
}

func TestValidateRejects(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(m *Manifest)
		want   string
	}{
		{"absolute verify", func(m *Manifest) { m.Root.Verify = "/etc" }, "absolute"},
		{"backslash-rooted install", func(m *Manifest) { m.Adapter.Install = `\Windows\x` }, "absolute"},
		{"drive letter", func(m *Manifest) { m.Sources[0].Path = "C:/Windows/x" }, `":"`},
		{"dot-dot", func(m *Manifest) { m.Adapter.Install = "_*_/../../x" }, `".."`},
		{"dot-dot with backslashes", func(m *Manifest) { m.Sources[0].Path = `_*_\..\x` }, `".."`},
		{"dot-dot with a trailing space", func(m *Manifest) { m.Sources[0].Path = "_*_/.. /x" }, `".. "`},
		{"dot-dot with a trailing dot", func(m *Manifest) { m.Root.Verify = "..." }, `"..."`},
		{"names nothing", func(m *Manifest) { m.Root.Verify = "./" }, "names nothing"},
		{"variable in a relative path", func(m *Manifest) { m.Root.Verify = "{HOME}/x" }, "variable"},
		{"variable inside a locate path", func(m *Manifest) { m.Root.Locate[1].Path = "/x/{HOME}" }, "only start"},
		{"variable without a separator", func(m *Manifest) { m.Root.Locate[1].Path = "{HOME}x" }, "separator"},
		{"both path and prompt", func(m *Manifest) { m.Root.Locate[1].Prompt = "x" }, "exactly one"},
		{"duplicate source id", func(m *Manifest) { m.Sources = append(m.Sources, m.Sources[0]) }, "earlier source"},
		{"unknown source type", func(m *Manifest) { m.Sources[0].Type = "log_tail" }, "not file"},
		{"kit name", func(m *Manifest) { m.Kit = "../x" }, "snake_case"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := wow(t)
			tc.change(m)
			err := m.Validate()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("Validate() = %v, want an error with %s", err, tc.want)
			}
		})
	}
}
