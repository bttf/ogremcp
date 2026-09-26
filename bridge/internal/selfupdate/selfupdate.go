// Package selfupdate updates the bridge to its newest release
// (docs/architecture.md §7 Self-update, §5 Releases).
//
// The bridge and the addon share the repo's one Releases page, split by tag
// prefix (§5). Latest lists the releases through the GitHub API and keeps the
// published, stable bridge releases only: a bridge-v tag whose version is
// X.Y.Z, neither a draft nor a pre-release. It returns the newest of them when
// it is newer than the running bridge, and never an older one.
//
// Install downloads the release's checksums.txt, its detached signature
// checksums.txt.sig, and this system's asset. The signature must verify with
// PublicKey, the Ed25519 key embedded here, whose private half signs each
// release (docs/releases.md). The asset's sha256 must then be the one
// checksums.txt lists. Only then is anything installed:
//
//   - Windows: the new .exe is written beside the running one. The running
//     one is renamed aside, and the new one renamed into its place.
//   - macOS: the new .app is unpacked beside the running one and replaces the
//     whole bundle, because swapping the binary inside a signed, notarized
//     bundle breaks its signature. The running bundle is renamed aside.
//
// Cleanup removes what an update renamed aside, at the next start. Every file
// is written in the folder the bridge runs from, so an update never needs
// admin rights. When that folder is read-only, as for an app run from a disk
// image, Install fails with ErrReadOnly before it downloads anything.
// Relaunch starts the new version with EnvUpdatedFrom set; the caller then
// quits.
//
// Only a release build updates itself. The caller creates no Updater for a
// dev or snapshot build.
package selfupdate

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/bttf/ogremcp/bridge/internal/adapter"
)

// Repo is the GitHub repository whose Releases page holds the bridge
// releases (§5). GitHub redirects a renamed or transferred repository.
const Repo = "bttf/ogremcp"

// TagPrefix starts the tag of each bridge release.
const TagPrefix = "bridge-v"

// PublicKey is the Ed25519 public key, raw and base64, whose private half
// signs each release's checksums.txt: the secret BRIDGE_UPDATE_SIGNING_KEY of
// the release environment (docs/releases.md). It is not secret.
const PublicKey = "7ogv3lNq/FOv6Oe54hqhVomjWJCwpHin96Dk1qq67P0="

// EnvUpdatedFrom is set, to the version it replaced, in the environment of a
// bridge that Relaunch started.
const EnvUpdatedFrom = "OGREMCP_UPDATED_FROM"

// DefaultAPI is the GitHub REST API.
const DefaultAPI = "https://api.github.com"

// project starts the name of each release asset: GoReleaser's project_name
// (.goreleaser.yaml).
const project = "ogremcp-bridge"

// The release's checksums and their detached signature (.goreleaser.yaml).
const (
	checksumsName = "checksums.txt"
	signatureName = checksumsName + ".sig"
)

// stagePrefix starts the name of each file or folder an update writes or
// renames aside, beside the running bridge. Cleanup removes them.
const stagePrefix = ".ogremcp-update-"

// The most bytes each download may have.
const (
	maxList      = 16 << 20
	maxChecksums = 64 << 10
	maxSignature = 1 << 10
	maxAsset     = 256 << 20
)

var (
	// ErrReadOnly means the folder the bridge runs from is read-only for this
	// user, as for an app run from a disk image or from the copy macOS runs
	// when an app is opened where it was downloaded. The update is skipped.
	ErrReadOnly = errors.New("the app's folder is read-only")
	// ErrUnsupported means no release asset runs on this system.
	ErrUnsupported = errors.New("the bridge does not update itself on this system")
	// ErrSignature means checksums.txt.sig is not a signature of
	// checksums.txt by PublicKey.
	ErrSignature = errors.New("the release's checksums.txt does not match its signature")
	// ErrChecksum means the downloaded asset does not have the sha256 that
	// checksums.txt lists.
	ErrChecksum = errors.New("the download does not match its sha256 in checksums.txt")
)

// Release is a published, stable bridge release.
type Release struct {
	// Tag is the release's tag, such as bridge-v1.2.3, and Version its
	// version.
	Tag     string
	Version adapter.Version
	// Assets maps the name of each file of the release to its download URL.
	Assets map[string]string
}

// Updater finds and installs the bridge's newest release.
type Updater struct {
	current adapter.Version
	api     string
	http    *http.Client
	key     ed25519.PublicKey
	// path is the running bridge: the .app bundle on macOS, the .exe on
	// Windows.
	path string
}

// New returns the Updater of a release build of version, the running
// bridge's. It fails when version is not X.Y.Z or X.Y.Z-pre, when no release
// asset runs on this system, and when the bridge's path is not a release's
// layout, such as a macOS binary outside an .app.
func New(version string) (*Updater, error) {
	current, err := adapter.ParseVersion(version)
	if err != nil || current.String() != version {
		return nil, fmt.Errorf("%q is not a release version", version)
	}
	if _, err := assetName(current.String()); err != nil {
		return nil, err
	}
	path, err := installPath()
	if err != nil {
		return nil, err
	}
	key, err := publicKey()
	if err != nil {
		return nil, err
	}
	return &Updater{
		current: current,
		api:     DefaultAPI,
		http:    &http.Client{Timeout: 10 * time.Minute},
		key:     key,
		path:    path,
	}, nil
}

// publicKey decodes PublicKey.
func publicKey() (ed25519.PublicKey, error) {
	key, err := base64.StdEncoding.DecodeString(PublicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("the embedded update key is not an Ed25519 public key")
	}
	return ed25519.PublicKey(key), nil
}

// ghRelease is a release as GET /repos/{owner}/{repo}/releases lists it.
type ghRelease struct {
	TagName    string `json:"tag_name"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
	Assets     []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

// Latest returns the newest published, stable bridge release when it is
// newer than the running bridge, or nil. It reads the newest 100 releases of
// either prefix. GitHub allows 60 such calls an hour from one IP address
// without a token.
func (u *Updater) Latest(ctx context.Context) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.api+"/repos/"+Repo+"/releases?per_page=100", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := u.do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered the release list with status %d", res.StatusCode)
	}
	var list []ghRelease
	if err := json.NewDecoder(io.LimitReader(res.Body, maxList)).Decode(&list); err != nil {
		return nil, fmt.Errorf("could not read the release list: %w", err)
	}
	return newest(list, u.current), nil
}

// newest returns the newest published, stable bridge release in list that is
// newer than current, or nil.
func newest(list []ghRelease, current adapter.Version) *Release {
	var best *Release
	for _, r := range list {
		v, ok := tagVersion(r.TagName)
		if !ok || r.Draft || r.Prerelease || v.Compare(current) <= 0 {
			continue
		}
		if best != nil && v.Compare(best.Version) <= 0 {
			continue
		}
		assets := map[string]string{}
		for _, a := range r.Assets {
			assets[a.Name] = a.URL
		}
		best = &Release{Tag: r.TagName, Version: v, Assets: assets}
	}
	return best
}

// tagVersion returns the version of a stable bridge release's tag: bridge-v
// and X.Y.Z, as ParseVersion writes it. It returns false for any other tag,
// such as addon-v1.2.3 or bridge-v1.2.3-rc.1.
func tagVersion(tag string) (adapter.Version, bool) {
	s, ok := strings.CutPrefix(tag, TagPrefix)
	if !ok {
		return adapter.Version{}, false
	}
	v, err := adapter.ParseVersion(s)
	if err != nil || v.Pre != "" || v.String() != s {
		return adapter.Version{}, false
	}
	return v, true
}

// Install downloads r's asset for this system, verifies it (§7), and puts it
// in place of the running bridge. It fails with ErrReadOnly, before any
// download, when the bridge's folder is read-only. Once it has started to
// swap the files, it finishes without looking at ctx.
func (u *Updater) Install(ctx context.Context, r *Release) error {
	name, err := assetName(r.Version.String())
	if err != nil {
		return err
	}
	stage, err := newStage(u.path)
	if readOnly(err) {
		return fmt.Errorf("%w: %w", ErrReadOnly, err)
	}
	if err != nil {
		return err
	}
	done := false
	defer func() {
		if !done {
			os.RemoveAll(stage)
		}
	}()
	data, err := u.fetch(ctx, r, name)
	if err != nil {
		return err
	}
	if err := put(ctx, stage, u.path, data); err != nil {
		return err
	}
	done = true
	return nil
}

// fetch downloads r's file name and verifies it: checksums.txt.sig must be a
// signature of checksums.txt by the embedded key (ErrSignature), and the
// file must have the sha256 that checksums.txt lists (ErrChecksum).
func (u *Updater) fetch(ctx context.Context, r *Release, name string) ([]byte, error) {
	sums, err := u.download(ctx, r, checksumsName, maxChecksums)
	if err != nil {
		return nil, err
	}
	sig, err := u.download(ctx, r, signatureName, maxSignature)
	if err != nil {
		return nil, err
	}
	if err := verify(u.key, sums, sig); err != nil {
		return nil, err
	}
	want, err := checksum(sums, name)
	if err != nil {
		return nil, err
	}
	data, err := u.download(ctx, r, name, maxAsset)
	if err != nil {
		return nil, err
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != want {
		return nil, ErrChecksum
	}
	return data, nil
}

// download returns the release's file name, of at most limit bytes.
func (u *Updater) download(ctx context.Context, r *Release, name string, limit int64) ([]byte, error) {
	link, ok := r.Assets[name]
	if !ok {
		return nil, fmt.Errorf("release %s has no file %s", r.Tag, name)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, err
	}
	res, err := u.do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered the download of %s with status %d", name, res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("could not download %s: %w", name, err)
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%s of release %s is over %d bytes", name, r.Tag, limit)
	}
	return data, nil
}

func (u *Updater) do(req *http.Request) (*http.Response, error) {
	req.Header.Set("User-Agent", project+"/"+u.current.String())
	return u.http.Do(req)
}

// Relaunch starts the version Install put in place, with EnvUpdatedFrom set
// to the running version. The caller quits once it returns nil; the new
// version waits for the caller's lock.
func (u *Updater) Relaunch() error {
	return relaunch(u.path, u.current.String())
}

// Cleanup removes what an earlier update left beside the running bridge: the
// version it replaced, and the files of an update that did not finish. The
// version an update replaced may still be quitting, and Windows removes no
// program while it runs, so Cleanup tries up to five times, a few seconds
// apart, until ctx ends.
func (u *Updater) Cleanup(ctx context.Context) error {
	var err error
	for try := 0; try < 5; try++ {
		if err = removeStages(filepath.Dir(u.path)); err == nil {
			return nil
		}
		t := time.NewTimer(3 * time.Second)
		select {
		case <-ctx.Done():
			t.Stop()
			return err
		case <-t.C:
		}
	}
	return err
}

// removeStages removes each file or folder in dir whose name starts with
// stagePrefix.
func removeStages(dir string) error {
	matches, err := filepath.Glob(filepath.Join(dir, stagePrefix+"*"))
	if err != nil {
		return err
	}
	var errs []error
	for _, m := range matches {
		errs = append(errs, os.RemoveAll(m))
	}
	return errors.Join(errs...)
}

// readOnly reports whether err means the folder may not be written: no
// permission, or a read-only volume.
func readOnly(err error) bool {
	return errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS)
}

// executable is the running program's path, with symbolic links resolved.
func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}
