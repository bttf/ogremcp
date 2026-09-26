package selfupdate

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/bttf/ogremcp/bridge/internal/adapter"
)

// Only published, stable bridge-v releases count, compared as versions, and
// the bridge never goes back to an older one.
func TestNewest(t *testing.T) {
	list := []ghRelease{
		{TagName: "addon-v9.0.0"},
		{TagName: "bridge-v1.4.0", Draft: true},
		{TagName: "bridge-v1.3.0", Prerelease: true},
		{TagName: "bridge-v1.3.1-rc.1"},
		{TagName: "bridge-vv1.3.2"},
		{TagName: "bridge-v1.2.9"},
		{TagName: "bridge-v1.2.10"},
	}
	for _, tc := range []struct{ current, want string }{
		{"1.2.3", "bridge-v1.2.10"},
		{"1.2.10-rc.1", "bridge-v1.2.10"},
		{"1.2.10", ""},
		{"2.0.0", ""},
	} {
		current, err := adapter.ParseVersion(tc.current)
		if err != nil {
			t.Fatal(err)
		}
		got := ""
		if r := newest(list, current); r != nil {
			got = r.Tag
		}
		if got != tc.want {
			t.Errorf("newest from %s = %q, want %q", tc.current, got, tc.want)
		}
	}
}

// The download is used only when checksums.txt carries the embedded key's
// signature and lists the download's sha256.
func TestFetchVerifies(t *testing.T) {
	pub, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	_, otherKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	const name = "ogremcp-bridge_1.2.4_windows_amd64.exe"
	asset := []byte("the new bridge")
	tampered := []byte("a tampered bridge")
	sums := checksumsOf(map[string][]byte{name: asset, "ogremcp-bridge_1.2.4_darwin_all.app.zip": []byte("app")})
	sign := func(k ed25519.PrivateKey, data []byte) []byte {
		return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(k, data)) + "\n")
	}

	for _, tc := range []struct {
		name            string
		sums, sig, file []byte
		wantErr         error
	}{
		{"good signature", sums, sign(key, sums), asset, nil},
		{"signed by another key", sums, sign(otherKey, sums), asset, ErrSignature},
		{"checksums changed after signing", checksumsOf(map[string][]byte{name: tampered}), sign(key, sums), tampered, ErrSignature},
		{"download does not match its checksum", sums, sign(key, sums), tampered, ErrChecksum},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string][]byte{checksumsName: tc.sums, signatureName: tc.sig, name: tc.file}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				w.Write(files[req.URL.Path[1:]])
			}))
			defer srv.Close()
			r := &Release{Tag: "bridge-v1.2.4", Assets: map[string]string{}}
			for f := range files {
				r.Assets[f] = srv.URL + "/" + f
			}
			u := &Updater{http: srv.Client(), key: pub}
			data, err := u.fetch(context.Background(), r, name)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("fetch: %v, want %v", err, tc.wantErr)
			}
			if err == nil && !bytes.Equal(data, asset) {
				t.Errorf("fetch = %q, want %q", data, asset)
			}
		})
	}
}

func checksumsOf(files map[string][]byte) []byte {
	var b bytes.Buffer
	for name, data := range files {
		sum := sha256.Sum256(data)
		b.WriteString(hex.EncodeToString(sum[:]) + "  " + name + "\n")
	}
	return b.Bytes()
}

// A macOS update replaces the whole bundle and keeps the binary executable.
// When the new bundle fails its check, the running one stays. The bundle an
// update moved aside is gone after Cleanup's pass at the next start.
func TestPutApp(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "Ogre MCP.app")
	writeFile(t, filepath.Join(app, "Contents", "MacOS", "ogremcp-bridge"), "old", 0o755)
	writeFile(t, filepath.Join(app, "Contents", "Info.plist"), "old", 0o644)
	data := appZip(t, "new")
	ctx := context.Background()

	stage, err := newAppStage(app)
	if err != nil {
		t.Fatal(err)
	}
	broken := errors.New("the seal is broken")
	if err := putApp(ctx, stage, app, "ogremcp-bridge", data, func(string) error { return broken }); !errors.Is(err, broken) {
		t.Fatalf("putApp with a failing check: %v", err)
	}
	os.RemoveAll(stage)
	readFile(t, filepath.Join(app, "Contents", "MacOS", "ogremcp-bridge"), "old")

	stage, err = newAppStage(app)
	if err != nil {
		t.Fatal(err)
	}
	if err := putApp(ctx, stage, app, "ogremcp-bridge", data, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(app, "Contents", "MacOS", "ogremcp-bridge")
	readFile(t, exe, "new")
	readFile(t, filepath.Join(app, "Contents", "Info.plist"), "new")
	readFile(t, filepath.Join(stage+".old", "Contents", "MacOS", "ogremcp-bridge"), "old")
	if info, err := os.Stat(exe); err != nil || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		t.Errorf("the new binary is not executable: %v, %v", info, err)
	}

	if err := removeStages(dir); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "Ogre MCP.app" {
		t.Errorf("after Cleanup the folder holds %v, %v; want the app only", entries, err)
	}
}

// appZip is a zipped .app as scripts/macos-app.sh zips it with ditto.
func appZip(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range []struct {
		name string
		mode fs.FileMode
	}{
		{"Ogre MCP.app/", fs.ModeDir | 0o755},
		{"Ogre MCP.app/Contents/", fs.ModeDir | 0o755},
		{"Ogre MCP.app/Contents/MacOS/", fs.ModeDir | 0o755},
		{"Ogre MCP.app/Contents/MacOS/ogremcp-bridge", 0o755},
		{"Ogre MCP.app/Contents/Info.plist", 0o644},
	} {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		h.SetMode(e.mode)
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if !e.mode.IsDir() {
			f.Write([]byte(body))
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func writeFile(t *testing.T, path, body string, perm fs.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), perm); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || string(got) != want {
		t.Errorf("%s holds %q, %v; want %q", path, got, err, want)
	}
}
