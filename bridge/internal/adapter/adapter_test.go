package adapter

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/bttf/ogremcp/bridge/internal/kits"
	"github.com/bttf/ogremcp/bridge/internal/manifest"
)

const folderName = "OgreMCP"

type entry struct {
	name, body string
	mode       fs.FileMode
}

func makeZip(t *testing.T, entries ...entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Store}
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		h.SetMode(mode)
		f, err := w.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(f, e.body)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func adapterZip(t *testing.T, version string) []byte {
	return makeZip(t,
		entry{name: folderName + "/" + folderName + ".toc", body: "## Interface: 11509\n## Version: " + version + "\nOgreMCP.lua\n"},
		entry{name: folderName + "/OgreMCP.lua", body: "-- " + version + "\n"},
	)
}

func sum(data []byte) string {
	s := sha256.Sum256(data)
	return hex.EncodeToString(s[:])
}

// platform serves one adapter zip at GET /api/v1/kits/wow/adapter. header,
// when set, replaces the X-Adapter-Sha256 of the zip.
type platform struct {
	*httptest.Server
	mu        sync.Mutex
	zip       []byte
	header    string
	downloads int
}

func newPlatform(t *testing.T) *platform {
	p := &platform{}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		defer p.mu.Unlock()
		if r.URL.Path != "/api/v1/kits/wow/adapter" {
			http.NotFound(w, r)
			return
		}
		p.downloads++
		h := p.header
		if h == "" {
			h = sum(p.zip)
		}
		w.Header().Set(SHA256Header, h)
		w.Write(p.zip)
	}))
	t.Cleanup(p.Close)
	return p
}

// serve makes p serve the adapter of version, and returns the kit as GET
// /api/v1/kits lists it.
func (p *platform) serve(t *testing.T, version string) kits.Kit {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.zip = adapterZip(t, version)
	return wowKit(version, sum(p.zip))
}

func (p *platform) setHeader(h string) {
	p.mu.Lock()
	p.header = h
	p.mu.Unlock()
}

func (p *platform) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.downloads
}

func wowKit(version, sha string) kits.Kit {
	return kits.Kit{
		Entry: kits.Entry{Kit: "wow", Adapter: &kits.Adapter{Version: version, SHA256: sha}},
		Manifest: &manifest.Manifest{Kit: "wow", Adapter: &manifest.Adapter{
			Install: "_*_/Interface/AddOns/" + folderName,
			Process: []string{"Wow*.exe", "World of Warcraft*"},
		}},
	}
}

// procs is a process list the test sets.
type procs struct {
	mu    sync.Mutex
	names []string
}

func (p *procs) Processes() ([]string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.names, nil
}

func (p *procs) set(names ...string) {
	p.mu.Lock()
	p.names = names
	p.mu.Unlock()
}

// setup returns a game folder with the flavor folders given, an Updater
// for p, and its process list.
func setup(t *testing.T, p *platform, flavors ...string) (string, *Updater, *procs) {
	t.Helper()
	root := t.TempDir()
	for _, f := range flavors {
		if err := os.MkdirAll(filepath.Join(root, f), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ps := &procs{}
	return root, New(NewClient(p.URL, p.Client()), ps), ps
}

func addOns(root, flavor string) string {
	return filepath.Join(root, flavor, "Interface", "AddOns")
}

// writeAdapter puts an adapter folder of version in the AddOns folder dir.
func writeAdapter(t *testing.T, dir, version string) {
	t.Helper()
	d := filepath.Join(dir, folderName)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(d, folderName+".toc"), []byte("## Version: "+version+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func installed(t *testing.T, dir string) string {
	t.Helper()
	v, err := tocVersion(os.DirFS(dir), folderName)
	if err != nil {
		t.Fatal(err)
	}
	return v.String()
}

// only fails unless dir holds exactly names.
func only(t *testing.T, dir string, names ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, ",") != strings.Join(names, ",") {
		t.Errorf("%s holds %v, want %v", dir, got, names)
	}
}

func one(t *testing.T, list []Status) Status {
	t.Helper()
	if len(list) != 1 {
		t.Fatalf("%d statuses: %+v", len(list), list)
	}
	return list[0]
}

func TestInstallUpdateNeverDowngrade(t *testing.T) {
	ctx := context.Background()
	p := newPlatform(t)
	root, u, _ := setup(t, p, "_classic_era_")
	dir := addOns(root, "_classic_era_")

	// A first install into a game folder without Interface/AddOns.
	st := one(t, u.Sync(ctx, []Target{{Kit: p.serve(t, "0.1.0"), Root: root}}))
	if st.State != StateInstalled || st.Err != nil || st.Path != filepath.Join(dir, folderName) {
		t.Fatalf("first install: %+v", st)
	}
	if v := installed(t, dir); v != "0.1.0" {
		t.Errorf("installed %s", v)
	}

	// The same version again: nothing is downloaded.
	if st := one(t, u.Sync(ctx, []Target{{Kit: p.serve(t, "0.1.0"), Root: root}})); st.State != StateCurrent || p.count() != 1 {
		t.Errorf("same version: %+v, %d downloads", st, p.count())
	}

	// A newer version replaces the folder, and leaves nothing beside it.
	if st := one(t, u.Sync(ctx, []Target{{Kit: p.serve(t, "0.2.0"), Root: root}})); st.State != StateInstalled || st.Installed != "0.2.0" {
		t.Errorf("update: %+v", st)
	}
	if v := installed(t, dir); v != "0.2.0" {
		t.Errorf("installed %s", v)
	}
	only(t, dir, folderName)

	// An older listed version is never installed.
	downloads := p.count()
	if st := one(t, u.Sync(ctx, []Target{{Kit: p.serve(t, "0.1.0"), Root: root}})); st.State != StateCurrent || st.Installed != "0.2.0" || p.count() != downloads {
		t.Errorf("downgrade: %+v", st)
	}
	if v := installed(t, dir); v != "0.2.0" {
		t.Errorf("downgraded to %s", v)
	}
}

func TestStagedWhileGameRuns(t *testing.T) {
	ctx := context.Background()
	p := newPlatform(t)
	root, u, ps := setup(t, p, "_classic_era_", "_classic_")
	era, classic := addOns(root, "_classic_era_"), addOns(root, "_classic_")
	writeAdapter(t, era, "0.1.0")
	ps.set("explorer.exe", `C:\Games\World of Warcraft\_classic_era_\wowclassic.exe`)

	// The installed adapter waits for the game to exit; a first install does
	// not.
	list := u.Sync(ctx, []Target{{Kit: p.serve(t, "0.2.0"), Root: root}})
	if len(list) != 2 || list[0].State != StateRestart || list[1].State != StateWaiting {
		t.Fatalf("while the game runs: %+v", list)
	}
	if v := installed(t, era); v != "0.1.0" {
		t.Errorf("updated under a running game: %s", v)
	}
	if v := installed(t, classic); v != "0.2.0" {
		t.Errorf("first install: %s", v)
	}
	if st := u.ApplyStaged(ctx); len(st) != 0 {
		t.Errorf("applied while the game runs: %+v", st)
	}

	// Once the game exits, the staged zip is applied without a new download.
	ps.set("explorer.exe")
	list = u.ApplyStaged(ctx)
	if len(list) != 2 || list[1].State != StateInstalled || installed(t, era) != "0.2.0" || p.count() != 1 {
		t.Errorf("after the game exits: %+v, %d downloads", list, p.count())
	}

	// An update staged for a kit the user then disables is dropped, and its
	// adapter stays.
	ps.set("Wow.exe")
	u.Sync(ctx, []Target{{Kit: p.serve(t, "0.3.0"), Root: root}})
	u.Sync(ctx, nil)
	ps.set()
	if st := u.ApplyStaged(ctx); len(st) != 0 || installed(t, era) != "0.2.0" {
		t.Errorf("a disabled kit: %+v", st)
	}
}

func TestChecksumMismatch(t *testing.T) {
	ctx := context.Background()
	p := newPlatform(t)
	root, u, _ := setup(t, p, "_classic_era_")
	k := p.serve(t, "0.1.0")

	// The download's header differs from the list: a deploy came between.
	p.setHeader(strings.Repeat("0", 64))
	if st := one(t, u.Sync(ctx, []Target{{Kit: k, Root: root}})); st.State != StateFailed || !errors.Is(st.Err, ErrChanged) {
		t.Errorf("header: %+v", st)
	}
	// The bytes do not match the header and the list.
	k.Adapter.SHA256 = strings.Repeat("0", 64)
	if st := one(t, u.Sync(ctx, []Target{{Kit: k, Root: root}})); st.State != StateFailed || !errors.Is(st.Err, ErrChecksum) {
		t.Errorf("bytes: %+v", st)
	}
	// Nothing is created before a verified zip is in hand.
	if _, err := os.Stat(filepath.Join(root, "_classic_era_", "Interface")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("Interface was created: %v", err)
	}
}

func TestUnsafeZip(t *testing.T) {
	for name, e := range map[string]entry{
		"outside the folder":  {name: "Other/x.lua"},
		"dot-dot":             {name: folderName + "/../x.lua"},
		"dot-dot at the top":  {name: "../x.lua"},
		"absolute":            {name: "/" + folderName + "/x.lua"},
		"drive letter":        {name: "C:/" + folderName + "/x.lua"},
		"colon":               {name: folderName + "/x.lua:stream"},
		"backslash":           {name: folderName + `/..\..\x.lua`},
		"dot-dot with space":  {name: folderName + "/.. /x.lua"},
		"symbolic link":       {name: folderName + "/link", body: "/etc/passwd", mode: fs.ModeSymlink | 0o777},
		"empty part":          {name: folderName + "//x.lua"},
		"named pipe":          {name: folderName + "/fifo", mode: fs.ModeNamedPipe | 0o644},
		"dot-dot in a folder": {name: folderName + "/a/../../x/", mode: fs.ModeDir | 0o755},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			r, err := os.OpenRoot(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			data := makeZip(t, entry{name: folderName + "/" + folderName + ".toc", body: "## Version: 0.1.0\n"}, e)
			if err := extract(r, data, folderName); !errors.Is(err, ErrUnsafeZip) {
				t.Errorf("extract = %v", err)
			}
			only(t, dir)
		})
	}
}

func TestSwapFailureKeepsOldFolder(t *testing.T) {
	ctx := context.Background()
	p := newPlatform(t)
	root, u, _ := setup(t, p, "_classic_era_")
	dir := addOns(root, "_classic_era_")
	writeAdapter(t, dir, "0.1.0")
	mine := filepath.Join(dir, folderName, "mine.lua")
	if err := os.WriteFile(mine, []byte("--"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The new folder cannot be renamed into place.
	boom := errors.New("boom")
	orig := rename
	rename = func(r *os.Root, from, to string) error {
		if strings.HasPrefix(from, stagePrefix) {
			return boom
		}
		return orig(r, from, to)
	}
	t.Cleanup(func() { rename = orig })

	if st := one(t, u.Sync(ctx, []Target{{Kit: p.serve(t, "0.2.0"), Root: root}})); st.State != StateFailed || !errors.Is(st.Err, boom) {
		t.Errorf("sync: %+v", st)
	}
	if v := installed(t, dir); v != "0.1.0" {
		t.Errorf("installed %s", v)
	}
	if _, err := os.Stat(mine); err != nil {
		t.Error("the old folder lost a file:", err)
	}
	only(t, dir, folderName)
}

func TestLinks(t *testing.T) {
	ctx := context.Background()
	p := newPlatform(t)
	symlink := func(target, link string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Skip("cannot make a symbolic link here:", err)
		}
	}

	// A linked Interface/AddOns is followed: the adapter lands in its target.
	root, u, _ := setup(t, p, "_classic_era_")
	elsewhere := t.TempDir()
	symlink(elsewhere, addOns(root, "_classic_era_"))
	if st := one(t, u.Sync(ctx, []Target{{Kit: p.serve(t, "0.1.0"), Root: root}})); st.State != StateInstalled {
		t.Fatalf("linked AddOns: %+v", st)
	}
	if v := installed(t, elsewhere); v != "0.1.0" {
		t.Errorf("installed %s in the linked folder", v)
	}

	// A linked adapter folder, as a developer setup makes, is never replaced.
	root, u, _ = setup(t, p, "_classic_era_")
	dev := t.TempDir()
	writeAdapter(t, dev, "0.0.1")
	link := filepath.Join(addOns(root, "_classic_era_"), folderName)
	symlink(filepath.Join(dev, folderName), link)
	if st := one(t, u.Sync(ctx, []Target{{Kit: p.serve(t, "0.2.0"), Root: root}})); st.State != StateLinked {
		t.Errorf("linked adapter folder: %+v", st)
	}
	if info, err := os.Lstat(link); err != nil || info.Mode()&fs.ModeSymlink == 0 {
		t.Errorf("the link was replaced: %v", err)
	}
	if v := installed(t, dev); v != "0.0.1" {
		t.Errorf("the developer's folder holds %s", v)
	}
}
