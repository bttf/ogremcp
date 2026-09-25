package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSaveAndLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ogremcp-bridge", "config.json")
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

// OGREMCP_BASE_URL wins over server_url, which wins over the default. A URL
// the bridge would not send a token to is refused, never passed over.
func TestServer(t *testing.T) {
	const saved = "https://ogremcp.example.com"
	cases := []struct {
		env, saved, want string
	}{
		{"", "", DefaultServerURL},
		{"", saved + "/", saved},
		{"http://localhost:4790", saved, "http://localhost:4790"},
	}
	for _, c := range cases {
		if got, err := (File{ServerURL: c.saved}).Server(c.env); got != c.want || err != nil {
			t.Errorf("env %q, server_url %q: %q, %v; want %q", c.env, c.saved, got, err, c.want)
		}
	}
	for _, bad := range []string{"http://ogremcp.example.com", "https://user:pw@ogremcp.example.com", "https://ogremcp.example.com/app", "ogremcp.example.com"} {
		if got, err := (File{ServerURL: bad}).Server(""); err == nil {
			t.Errorf("server_url %q: %q", bad, got)
		}
		if got, err := (File{ServerURL: saved}).Server(bad); err == nil {
			t.Errorf("env %q: %q", bad, got)
		}
	}
}
