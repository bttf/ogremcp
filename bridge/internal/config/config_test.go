package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveAndLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ogmcp-bridge", "config.json")
	f, err := Load(path)
	if err != nil || f.Roots != nil || f.Interval() != DefaultRefreshInterval || f.DebounceDelay() != DefaultDebounce || f.UploadCap() != DefaultMaxUploadBytes {
		t.Fatalf("a missing file: %+v, %v", f, err)
	}

	f.Roots = map[string]string{"wow": filepath.Join(t.TempDir(), "World of Warcraft")}
	f.RefreshInterval = Duration(10 * time.Minute)
	f.Debounce = Duration(500 * time.Millisecond)
	if err := Save(path, f); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil || got.Roots["wow"] != f.Roots["wow"] || got.Interval() != 10*time.Minute || got.DebounceDelay() != 500*time.Millisecond {
		t.Errorf("Load = %+v, %v", got, err)
	}

	for _, bad := range []string{`{"refresh_interval": "1s"}`, `{"debounce": "-1s"}`, `{"max_upload_bytes": -1}`} {
		if err := os.WriteFile(path, []byte(bad), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(path); err == nil {
			t.Errorf("%s passed", bad)
		}
	}
}
