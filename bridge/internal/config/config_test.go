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
	if err != nil || f.Roots != nil || f.Interval() != DefaultRefreshInterval {
		t.Fatalf("a missing file: %+v, %v", f, err)
	}

	f.Roots = map[string]string{"wow": filepath.Join(t.TempDir(), "World of Warcraft")}
	f.RefreshInterval = Duration(10 * time.Minute)
	if err := Save(path, f); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil || got.Roots["wow"] != f.Roots["wow"] || got.Interval() != 10*time.Minute {
		t.Errorf("Load = %+v, %v", got, err)
	}

	if err := os.WriteFile(path, []byte(`{"refresh_interval": "1s"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Error("a refresh interval under the minimum passed")
	}
}
