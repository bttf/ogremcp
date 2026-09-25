package locate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/bttf/ogremcp/bridge/internal/manifest"
)

func mkdir(t *testing.T, parts ...string) string {
	t.Helper()
	dir := filepath.Join(parts...)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

// answer is a Prompter that picks one folder.
type answer string

func (a answer) PickFolder(context.Context, string) (string, error) { return string(a), nil }

func TestRoot(t *testing.T) {
	ctx := context.Background()
	home := t.TempDir()
	mkdir(t, home, "Games", "Empty") // matches the glob, but does not verify
	game := filepath.Join(home, "Games", "World of Warcraft")
	mkdir(t, game, "_classic_era_", "WTF")
	env := Env{Home: home} // {PROGRAM_FILES_X86} is undefined

	r := manifest.Root{
		Locate: []manifest.LocateEntry{
			{Path: "{PROGRAM_FILES_X86}/World of Warcraft"},
			{Path: "{HOME}/Games/*"},
			{Prompt: "Select your game folder"},
		},
		Verify: "_*_",
	}
	if got, err := Root(ctx, r, "", env, nil); got != game || err != nil {
		t.Errorf("the chain: %q, %v; want %q", got, err, game)
	}

	// A remembered root comes first while it verifies.
	other := filepath.Join(t.TempDir(), "Elsewhere")
	mkdir(t, other, "_retail_")
	if got, err := Root(ctx, r, other, env, nil); got != other || err != nil {
		t.Errorf("remembered: %q, %v", got, err)
	}
	if got, err := Root(ctx, r, filepath.Join(home, "Games", "Empty"), env, nil); got != game || err != nil {
		t.Errorf("a remembered root that no longer verifies: %q, %v", got, err)
	}

	// The prompt, when no path verifies.
	r.Locate[1].Path = "{HOME}/Missing/*"
	if got, err := Root(ctx, r, "", env, answer(game)); got != game || err != nil {
		t.Errorf("the prompt: %q, %v", got, err)
	}
	if _, err := Root(ctx, r, "", env, answer(home)); !errors.Is(err, ErrWrongFolder) {
		t.Errorf("a picked folder that does not verify: %v", err)
	}
	if _, err := Root(ctx, r, "", env, answer("")); !errors.Is(err, ErrNotFound) {
		t.Errorf("a cancelled prompt: %v", err)
	}
	if _, err := Root(ctx, r, "", env, nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("no prompter: %v", err)
	}
}

func TestGlobMatchesOneSegment(t *testing.T) {
	root := t.TempDir()
	mkdir(t, root, "_classic_era_", "WTF", "Account", "ONE", "SavedVariables")
	mkdir(t, root, "_classic_era_", "WTF", "Account", "TWO", "SavedVariables")
	mkdir(t, root, "Data")

	got, err := Glob(root, "_*_/WTF/Account/*/SavedVariables")
	want := []string{
		filepath.Join(root, "_classic_era_", "WTF", "Account", "ONE", "SavedVariables"),
		filepath.Join(root, "_classic_era_", "WTF", "Account", "TWO", "SavedVariables"),
	}
	if err != nil || !slices.Equal(got, want) {
		t.Errorf("Glob = %q, %v; want %q", got, err, want)
	}
	// "*" does not reach into subfolders.
	if got, err := Glob(root, "*/SavedVariables"); len(got) != 0 || err != nil {
		t.Errorf("Glob reached into subfolders: %q, %v", got, err)
	}

	for _, tc := range []struct {
		pattern, name string
		want          bool
	}{
		{"_*_", "_classic_era_", true},
		{"_*_", "_", false},
		{"_*_", "Data", false},
		{"*", "anything", true},
		{"a*b*a", "aba", true},
		{"a*a*a", "aa", false},
		{"Wow?.exe", "WowB.exe", false}, // "?" is literal
	} {
		if got := Match(tc.pattern, tc.name); got != tc.want {
			t.Errorf("Match(%q, %q) = %v", tc.pattern, tc.name, got)
		}
	}
}

func TestGlobStaysUnderRoot(t *testing.T) {
	root := mkdir(t, t.TempDir(), "World of Warcraft")
	mkdir(t, root, "_classic_era_")
	for _, rel := range []string{"_*_/../../x", `_*_\..\..`, "_*_/.. /x", "/etc", "C:/Windows", "."} {
		if _, err := Glob(root, rel); err == nil {
			t.Errorf("Glob(%q) passed", rel)
		}
	}

	// The check on each resolved path.
	for _, tc := range []struct {
		path string
		want bool
	}{
		{filepath.Join(root, "_classic_era_"), true},
		{root, false},
		{root + string(filepath.Separator) + ".." + string(filepath.Separator) + "x", false},
		{filepath.Dir(root), false},
	} {
		if got := inside(root, tc.path); got != tc.want {
			t.Errorf("inside(%q) = %v", tc.path, got)
		}
	}
}
