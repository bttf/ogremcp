# Releases

Spec: §5 (Releases), §7. Decided in RED-287 (P0.7). RED-323 (P5.7),
RED-344 (P9.3), RED-343 (P9, self-update), and RED-342 build on this.

## Cutting a release

Pushing a `bridge-v` or `addon-v` tag publishes a release. There is no
approval step after the push. Tag a commit on `main` that passed CI: both
workflows fail when the tagged commit is not on `main`. Both kinds of release
go to the repo's one Releases page (§5).

### Bridge

1. Check that the seven signing secrets are set in the `release` environment
   ("Signing secrets" below). Without them the job fails at its first step,
   and nothing is published.
2. Optionally, run the dry run on `main` (below).
3. Tag the commit and push the tag:

       git fetch origin
       git tag -a bridge-v1.2.3 -m "Bridge 1.2.3" origin/main
       git push origin bridge-v1.2.3

The `Bridge release` workflow (`.github/workflows/bridge-release.yml`) runs
its `release` job on a macOS runner, in the `release` environment. It checks
the secrets and the tag, imports the certificate into a temporary keychain,
then runs "A tag build" (below). GoReleaser's `universal_binaries` post hook
(`bridge/scripts/macos-app.sh`) builds `Ogre MCP.app`, and
`bridge/scripts/macos-sign.sh` signs it with the Developer ID identity
(hardened runtime, secure timestamp), notarizes it, and staples the ticket.
The hook then zips the app and checks the app in the zip with Gatekeeper.
A second post hook, `bridge/scripts/macos-dmg.sh`, checks that the app is
notarized, puts it in a disk image, and has `macos-sign.sh` sign, notarize,
and staple the image. It then checks the app in the image with Gatekeeper.
Only after that does GoReleaser write `checksums.txt`, sign it with
`bridge/scripts/sign` (the `signs` entry), and publish. The release, named
"Bridge 1.2.3", holds:

- `ogremcp-bridge_1.2.3_windows_amd64.exe`, unsigned (§7, D6)
- `ogremcp-bridge_1.2.3_darwin_all.dmg`, the macOS download: the app in a
  disk image, both signed and notarized ("macOS installer" below)
- `ogremcp-bridge_1.2.3_darwin_all.app.zip`, signed and notarized, the app
  that self-update installs (§7)
- `checksums.txt`
- `checksums.txt.sig`, the detached Ed25519 signature of `checksums.txt`,
  as base64 and a newline

Every GoReleaser run that is not a snapshot signs the app, the disk image,
and the checksums or fails: both hooks pass `developer-id` unless
`.IsSnapshot` is set (`bridge/.goreleaser.yaml`), `macos-sign.sh` has no
unsigned fallback, and `scripts/sign` fails without its key. Snapshots
(`make -C bridge dist`, the dev build, the dry run) get an ad hoc signature
only, their disk image is not signed, and they run with `--skip=sign`, so
they have no `checksums.txt.sig`.

The version is the tag without `bridge-v`, such as `1.2.3` or `1.2.3-rc.1`.
The job fails on a tag with any other form. A version with a `-`, such as
`1.2.3-rc.1`, is published as a pre-release and is never marked Latest.

Bridge releases run one at a time. A second tag waits for the first release
to finish. GitHub keeps only one waiting run, so a third tag pushed while one
runs and one waits cancels the waiting one. Push one `bridge-v` tag at a time.

When the job fails, fix the cause and re-run it from the Actions tab. A
failure during upload leaves a draft release, because GoReleaser publishes
the release only after every upload. Delete that draft before the re-run.

### Addon

1. Raise the TOC `## Version` in `kits/wow/adapter/OgreMCP.toc` in a PR, as
   every adapter change must (the `adapter-version` CI check), and merge it.
2. Tag the merge commit with that version and push the tag:

       git fetch origin
       git tag -a addon-v0.2.0 -m "Addon 0.2.0" origin/main
       git push origin addon-v0.2.0

The `Addon release` workflow (`.github/workflows/addon-release.yml`) runs
`scripts/check-addon-tag.sh`, which fails unless the tag's version equals the
`## Version` of every `.toc` in `kits/wow/adapter` at the tag. The job zips
the adapter's committed files under `OgreMCP/`, the folder that the manifest's
`adapter.install` names and that players have in `Interface/AddOns`. It
publishes `OgreMCP-0.2.0.zip` as "Addon 0.2.0", with GitHub's generated notes
since the previous `addon-v` tag. Those notes list every PR merged in
between, not only adapter changes. An addon release is never marked Latest,
so the Releases page's Latest label stays on the newest bridge release.

If the check fails, nothing is published. Delete the tag
(`git push origin :refs/tags/addon-v0.2.0` and `git tag -d addon-v0.2.0`),
then tag the right commit.

The bridge installs the adapter from the platform (§8.2), so an adapter change
reaches players with the platform deploy, whether or not it is tagged. The
tag makes the GitHub release and, from P9.5, feeds the CurseForge and Wago
packagers (§7 Listings).

### Dry run

Run the `Bridge release` workflow by hand on `main`: Actions, "Bridge
release", "Run workflow", or `gh workflow run bridge-release.yml --ref main`.
A manual run runs only the `dry-run` job and never publishes, even on a tag.
It builds a snapshot, as `make -C bridge dist` does, and lists the files a
release would publish. It has a read-only token and no access to the
`release` environment, so it neither signs nor checks the secrets. The first
tag is the first run that uses them. It is also the first run that
notarizes and staples the disk image: the dry run and `make -C bridge dist`
build it with the ad hoc app, unsigned.

The `Bridge dev build` workflow runs on pushes to `main` that touch `bridge/`,
not on PRs, to save macOS minutes. Start it for a branch with
`gh workflow run bridge-dev-build.yml --ref <branch>`.

### Signing secrets

D6: macOS builds are Developer ID signed and notarized. §7: each release's
`checksums.txt` is signed for self-update. The bridge release job reads
seven secrets from a GitHub environment named `release`. Only that job uses
the environment. The dry run does not.

The owner creates the environment once and limits it to `bridge-v*` tags, so
no other branch or tag can deploy to it or read its secrets: Settings,
Environments, New environment, `release`; then under "Deployment branches and
tags", choose "Selected branches and tags" and add the tag rule `bridge-v*`.
The same from a terminal:

    gh api -X PUT 'repos/{owner}/{repo}/environments/release' \
      -F 'deployment_branch_policy[protected_branches]=false' \
      -F 'deployment_branch_policy[custom_branch_policies]=true'
    gh api -X POST 'repos/{owner}/{repo}/environments/release/deployment-branch-policies' \
      -f name='bridge-v*' -f type=tag

In a private repo, environment secrets and deployment rules need GitHub Pro,
Team, or Enterprise. On GitHub Free they work once the repo is public (P9).

`gh secret set NAME --env release` sets one secret in the environment and
reads the value from standard input.

| Secret | What it holds |
| ------ | ------------- |
| `MACOS_CERT_P12_BASE64` | The Developer ID Application certificate and its private key, as a `.p12` file, base64-encoded. |
| `MACOS_CERT_PASSWORD` | The password set when the `.p12` was exported. |
| `APPLE_TEAM_ID` | The 10-character team ID. The job signs only with an identity of this team. |
| `APPLE_API_KEY_ID` | The App Store Connect API key's ID. |
| `APPLE_API_ISSUER_ID` | The App Store Connect API issuer ID (a UUID). |
| `APPLE_API_KEY_P8_BASE64` | The API key's `.p8` file, base64-encoded. |
| `BRIDGE_UPDATE_SIGNING_KEY` | The Ed25519 private key that signs `checksums.txt`, as PKCS#8 PEM. |

To obtain them (this needs the Apple Developer Program; creating the
certificate needs the Account Holder role):

- **Team ID.** developer.apple.com/account, Membership details, "Team ID".
- **Certificate.** In Keychain Access on a Mac, choose Certificate Assistant,
  "Request a Certificate From a Certificate Authority", and save the request
  to disk. At developer.apple.com/account, Certificates, IDs & Profiles,
  Certificates, add a "Developer ID Application" certificate (G2 Sub-CA) and
  upload the request. Download the `.cer` and open it, which adds it to the
  login keychain. In Keychain Access, My Certificates, export
  "Developer ID Application: … (TEAM ID)" as a `.p12` with a password. Then:

      base64 -i DeveloperID.p12 | gh secret set MACOS_CERT_P12_BASE64 --env release
      gh secret set MACOS_CERT_PASSWORD --env release
      gh secret set APPLE_TEAM_ID --env release

- **API key.** appstoreconnect.apple.com, Users and Access, Integrations, App
  Store Connect API, Team Keys. Generate a key with the Developer role. The
  page shows the Issuer ID above the list and the Key ID in the list. The
  `.p8` file can be downloaded once only. Then:

      base64 -i AuthKey_<key id>.p8 | gh secret set APPLE_API_KEY_P8_BASE64 --env release
      gh secret set APPLE_API_KEY_ID --env release
      gh secret set APPLE_API_ISSUER_ID --env release

Keep the `.p12` and `.p8` files outside the repo, and delete them once they
are stored somewhere safe. `.gitignore` lists both extensions.

- **Update signing key.** `BRIDGE_UPDATE_SIGNING_KEY` was set on 2026-09-25,
  with the owner's approval. The owner keeps the only other copy, in their
  password manager. Its public half is not secret: `PublicKey` in
  `bridge/internal/selfupdate/selfupdate.go`, raw and base64. Every bridge
  verifies `checksums.txt.sig` with that key before it updates itself, and
  refuses a release whose signature does not verify.
- **Rotating it.** Generate a new key pair, put the new public key in
  `PublicKey`, and release that bridge, still signed with the old key. Then
  set the new private key as the secret. A bridge that has not updated to
  that release by then cannot verify later releases, and needs a manual
  install.

The job writes the certificate and the keys under `RUNNER_TEMP` and deletes
them and the keychain at the end, whether it passes or fails. It prints no
secret. Its actions are pinned by commit SHA, and it builds without the Go
cache.

The steps above are adapted from `bttf/wow-guide@df80260`,
`docs/DEVELOPMENT.md` ("Release").

## Decision

The bridge is built and released with GoReleaser OSS (the free edition), v2.
The Pro-only `monorepo` key is not used. Four settings make `bridge-v` tags
work in OSS:

| Setting | Why |
|---|---|
| `GORELEASER_CURRENT_TAG=$TAG` | Names the tag directly, so another tag on the same commit is never picked. |
| `GORELEASER_PREVIOUS_TAG` from `git describe --match 'bridge-v*'` | Without it, the previous tag is the nearest tag of any prefix, often an `addon-v` tag. |
| `--skip=validate` | OSS parses the whole tag as semver and fails on `bridge-v1.2.3`. |
| `BRIDGE_VERSION=${TAG#bridge-v}` | OSS sets `.Version` to `bridge-v1.2.3`. Templates use `{{ .Env.BRIDGE_VERSION }}` instead of `.Version`. |

`--skip=validate` also turns off GoReleaser's dirty-tree check and its check
that HEAD is the tagged commit. The release job runs both checks itself.

A tag build:

```sh
set -eu
TAG=bridge-v1.2.3
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse "$TAG^{commit}")"
export GORELEASER_CURRENT_TAG=$TAG
export GORELEASER_PREVIOUS_TAG=$(git describe --tags --abbrev=0 --match 'bridge-v*' "$TAG^" 2>/dev/null || true)
export BRIDGE_VERSION=${TAG#bridge-v}
goreleaser release --clean --skip=validate
```

A local build (`make -C bridge dist`) stamps the version from the nearest
`bridge-v` tag without its prefix. With no `bridge-v` tag it stamps
`0.0.0-<short hash>`, because a bare hash can be all digits and read as a
large version:

```sh
BRIDGE_VERSION=$(git describe --tags --match 'bridge-v*' --dirty 2>/dev/null | sed 's/^bridge-v//' | grep . \
  || echo "0.0.0-$(git describe --always --dirty --exclude '*')") \
  goreleaser release --snapshot --clean --skip=sign
```

The config lives in `bridge/.goreleaser.yaml` and runs from `bridge/`. The core
keys, all OSS. The two platforms are separate build ids because their env and
ldflags differ. macOS needs `CGO_ENABLED=1` for the tray code. On an arm64
macOS runner, the darwin/amd64 build is a cross-compile, and Go turns cgo off
for cross-compiles unless `CGO_ENABLED=1` is set.

```yaml
version: 2
project_name: ogremcp-bridge
builds:
  - id: bridge-darwin
    goos: [darwin]
    goarch: [amd64, arm64]
    env: [CGO_ENABLED=1]
    flags: [-trimpath]
    ldflags: ["-s -w -X main.version={{ .Env.BRIDGE_VERSION }}"]
  - id: bridge-windows
    goos: [windows]
    goarch: [amd64]
    env: [CGO_ENABLED=0]
    flags: [-trimpath]
    ldflags: ["-s -w -H windowsgui -X main.version={{ .Env.BRIDGE_VERSION }}"]
universal_binaries:
  - ids: [bridge-darwin]
    replace: true
archives:
  - formats: [binary]
    name_template: "{{ .Binary }}_{{ .Env.BRIDGE_VERSION }}_{{ .Os }}_{{ .Arch }}"
checksum:
  name_template: checksums.txt
```

## Known limits in OSS

- The changelog lists every commit between two `bridge-v` tags, including
  addon and platform commits. Filtering by path (`changelog.paths`) is Pro.
- `release.prerelease: auto` does not work, because `--skip=validate` leaves the
  semver fields empty. The key accepts only the literals `auto` and `true` and
  is not a template. For a pre-release version, the release job pipes the
  config to `goreleaser release -f -` with `prerelease: "true"` added.
  `release.make_latest` is a template, so the config itself keeps a
  pre-release off Latest.
- The first bridge release has no previous `bridge-v` tag. Its changelog starts
  at the nearest tag of any prefix.
- Pro-only features this project would otherwise use: `app_bundles`, `dmg`,
  native notarization, `nsis`, `msi`, split and merge, `release.tag`, glob
  patterns in `git.ignore_tags`, `git.ignore_tag_prefixes`. GoReleaser does not
  support Inno Setup.

## Evidence

Sources: GoReleaser v2.18.2 source (commit `25a52e5`) and its docs
(`customization/monorepo`, `customization/general/git`,
`customization/publish/changelog`, `customization/publish/scm`,
`resources/limitations/semver`). The free-edition behavior comes from
`internal/pipe/git/git.go` (current and previous tags from env vars;
`ctx.Version` strips only a leading `v`), `internal/pipe/semver/semver.go`
(non-semver tags fail unless validation is skipped), and
`internal/client/github.go` (the release uses the current tag as its tag name).
Issues: goreleaser#1948 (tag prefixes shipped as Pro), goreleaser#4011
(`release.tag` shipped as Pro).

Experiment: a scratch repo with a Go module in `bridge/` and tags
`bridge-v0.1.0`, `addon-v0.1.0`, `addon-v0.2.0`, `bridge-v0.2.0`, run with the
OSS binary v2.18.2.

| Run | Result |
|---|---|
| No workaround | Fails: `failed to parse tag 'bridge-v0.2.0' as semver`. Previous tag resolves to `addon-v0.2.0`. |
| `--skip=validate` only | Builds. Version is `bridge-v0.2.0`. Previous tag `addon-v0.2.0`, so the changelog misses the bridge commit before it. |
| All four settings | Previous tag `bridge-v0.1.0`. The binary prints `0.2.0`. `lipo` reports a universal binary (x86_64, arm64). `checksums.txt` is written, and a `signs` entry wrote `checksums.txt.sig`, which verified. |
| `--skip=validate`, dirty tree or HEAD past the tag | Succeeds. The guard in the release job is required. |
| Stripped local tag `v0.2.0` plus `GORELEASER_CURRENT_TAG=v0.2.0` | Passes validation, but the GitHub release would be created on tag `v0.2.0`. Changing the release tag is Pro. Rejected. |
| `--snapshot` with `.Tag` templates | Stamps the nearest tag of any prefix, e.g. `addon-v0.4.0`. This is why the version comes from `BRIDGE_VERSION`. |
| `universal_binaries` post hook | A script wrapped the universal binary in an `.app` and zipped it. `checksum.extra_files` included the zip in `checksums.txt`. |
| Two build ids, with a cgo file for darwin, on an arm64 Mac | darwin/amd64 built with cgo and linked `libSystem`. The `bridge-windows` post hook ran before the checksum step. |

## How P5.7 (RED-323) uses it

- `bridge/.goreleaser.yaml` has the keys above. `make -C bridge dist` runs the
  local build command. It is the one local command that builds both
  platforms. It needs GoReleaser v2 and a Mac with Xcode's command line tools.
- The `.app` is not an OSS feature. The `universal_binaries` post hook runs
  `bridge/scripts/macos-app.sh`, adapted from the prototype's `tray-app`
  target (`bttf/wow-guide@df80260`, `bridge/Makefile`) without its `lipo`
  step. The script builds `Ogre MCP.app` from `bridge/macos/Info.plist`,
  gives it an ad hoc signature, and zips it. The zip is in
  `checksum.extra_files` and `release.extra_files`.
- Build on macOS: the prototype's tray app needs cgo on macOS. The
  `bridge-darwin` build sets `CGO_ENABLED=1` for both architectures and
  passes `-mmacosx-version-min=13.0` to clang in `CGO_CFLAGS` and
  `CGO_LDFLAGS`. Without that flag, a build with cgo code targets the build
  machine's macOS version. The `bridge-windows` build sets `CGO_ENABLED=0` and
  adds `-H windowsgui` to its ldflags.
- Unsigned dev builds are CI artifacts from `--snapshot`. The `Bridge dev
  build` workflow (`.github/workflows/bridge-dev-build.yml`) runs on pushes
  to `main` that touch `bridge/` and on `workflow_dispatch`. It uploads the
  Windows binary, the zipped `.app`, and the disk image, and publishes no
  release.

## How P9.3 (RED-344) uses it

- `.github/workflows/bridge-release.yml` runs on `push: tags: ['bridge-v*']`
  on a macOS runner, in the `release` environment, one release at a time. It
  checks out with `fetch-depth: 0` so `git describe` sees the tags and
  `origin/main` exists. It checks the tag's form and that the tagged commit is
  on `main`, then runs "A tag build" above.
  It installs GoReleaser with `.github/actions/install-goreleaser`, which the
  dev build shares: the pinned OSS release, checked against its SHA-256. It
  does not use `goreleaser/goreleaser-action`.
- macOS signing and notarization run in the `universal_binaries` post hook,
  because GoReleaser's versions are Pro. `bridge/scripts/macos-sign.sh`
  signs, notarizes, and staples an `.app` or a `.dmg`, adapted from the
  prototype's `bridge/scripts/macos-dmg.sh`. The disk image (RED-342) reuses
  it ("macOS installer" below).
- `addon-v` tags do not use GoReleaser. `.github/workflows/addon-release.yml`
  zips `kits/wow/adapter` with `git archive` and publishes with
  `gh release create`.

Left for later issues:

- The Windows installer (RED-273) needs Windows, and OSS has no split and
  merge. If it is built in a Windows job, run GoReleaser with
  `--skip=publish`, build the installer, then write checksums, sign, and run
  `gh release create "$TAG" --verify-tag` in a final job.
- Windows code signing is `[later]` (§7, D6). Azure Trusted Signing signs the
  `.exe` in place, so it would run from `hooks.post` on the `bridge-windows`
  build, which runs before the checksums are written. `binary_signs` does not
  fit: it expects a detached signature file (`${artifact}.sig`), an in-place
  signer writes none, and the upload of that missing file then fails.

## How P9 (RED-343) uses it

- The detached signature is a `signs` entry over `checksums.txt`. It runs
  `go run ./scripts/sign`, a Go program in `bridge/` that is not part of the
  bridge binary. It reads the key from the file `BRIDGE_UPDATE_SIGNING_KEY_PATH`
  names, which the release job writes from the secret. The runner's
  `/usr/bin/openssl` is LibreSSL, so it is not used for Ed25519.
- The release build sets `main.release` to `true` through ldflags
  (`{{ not .IsSnapshot }}`). Only such a build updates itself. A dev or
  snapshot build never does, even when its version is a release's.
- The tray app (`bridge/internal/selfupdate`) lists the newest 100 releases
  through the GitHub API at start and every `update_interval` (default 6
  hours, in the settings file). GitHub's `releases/latest` endpoint is not
  used: it returns a release whatever its tag. The bridge keeps published,
  stable `bridge-v` releases (no drafts, no pre-releases) and installs the
  newest one only when it is newer than itself.
- It verifies `checksums.txt.sig` with the embedded public key, then the
  asset's sha256 against `checksums.txt`, then installs without asking and
  starts the new version. Windows: the `.exe` is swapped by rename. macOS:
  the whole `.app` is replaced, beside the running one; when that folder is
  read-only, as in a mounted disk image, the tray says the update is skipped.
- The bridge downloads the assets by name: `checksums.txt`,
  `checksums.txt.sig`, `ogremcp-bridge_<v>_windows_amd64.exe`, and
  `ogremcp-bridge_<v>_darwin_all.app.zip`. Renaming any of them stops
  self-update for every bridge released before the change.
- The `.app` bundle in the zip must contain no symbolic links, such as an
  embedded framework's `Versions/Current`. The bridge rejects a zip with one,
  so every bridge released before the change would reject every later release.

## macOS installer

Spec: §7 (Installer, Signing). Built in RED-342.

The macOS download is `ogremcp-bridge_<version>_darwin_all.dmg`, an HFS+
disk image named "Ogre MCP" that holds `Ogre MCP.app` and nothing else.
`bridge/scripts/macos-dmg.sh` builds it from the app that
`bridge/scripts/macos-app.sh` built, adapted from the prototype's
`bridge/scripts/macos-dmg.sh` (`bttf/wow-guide@df80260`). The prototype's
link to `/Applications` is dropped: the app is installed per user in
`~/Applications`, so that self-update never needs admin rights (§7).

At each start from outside `~/Applications`, such as from the disk image or
Downloads, the tray app asks whether to move itself there
(`bridge/move_darwin.go`, `bridge/internal/macapp`). An app anywhere inside
`~/Applications` counts as installed. The check compares folders as files,
not path text, because on a case-insensitive disk or through a symbolic link
one folder has more than one path. When the user accepts, the app:

1. copies itself to `~/Applications/Ogre MCP.app`, creating the folder if
   needed. The copy is staged in a hidden folder beside it and renamed into
   place, replacing the copy there. The copy has no quarantine flag, so macOS
   does not run the installed app from a temporary copy (App Translocation).
2. points start at login at the new place, when it is on.
3. starts the app from `~/Applications` as a new instance, the way
   self-update does (`open -n`), with `OGREMCP_WAIT_FOR_LOCK` set, so that
   it waits for this one to release the single-instance lock. When the new
   app does not start, this one keeps running from where it is and removes
   nothing.
4. removes the app the user opened, and quits. On the read-only disk image,
   or in a folder the user may not change, that app stays. The bridge never
   removes a path that is the same file as `~/Applications/Ogre MCP.app`.

When the user declines, the app keeps running from where it is and asks again
at the next start. A binary that is not in an app bundle is never moved.

When the copy in `~/Applications` has a newer `CFBundleShortVersionString`
than the running app, nothing is replaced. The app asks whether to open that
copy instead; if the user accepts, it starts that copy the same way and
quits.

macOS runs a quarantined app that was not moved in Finder, such as one opened
from Downloads, from a read-only copy at a random path. To find the app the
user opened, the bridge calls `SecTranslocateCreateOriginalPathForURL` in
Security.framework, which is exported but not in the public headers. When the
call fails, the bridge copies the running app and removes nothing.

The dry run and snapshots build the disk image with an ad hoc app and do not
sign it. The first `bridge-v` tag is the first run that signs, notarizes, and
staples the image.

## Alternative considered

Plain `go build` for each target, `lipo`, `shasum -a 256`, a signing command,
and `gh release create "$TAG" --verify-tag`. It produces the same artifacts
for free and needs no tag-prefix settings. It is not chosen because §7 names
GoReleaser and the free GoReleaser path works. If P9 moves checksums, signing,
and publishing into a final job, GoReleaser only builds the binaries, and this
alternative is simpler.

## Self-host image

Spec: §13.3. Built in RED-361. `docker/Dockerfile` builds the platform image,
and `docker-compose.yml` runs it with Postgres (`docs/self-host.md`). The
`Self-host image` workflow (`.github/workflows/self-host-image.yml`) builds the
image on PRs that can change it, starts it with Compose, and checks that it
answers. It pushes the image nowhere.

Publishing the image is not set up. It waits on:

- The registry and the image name, which follow the org decision (§19.1 D4,
  RED-356).
- The repo going public (RED-345). The image holds the platform, which is
  AGPL-3.0-or-later, so it is published only from a commit whose source is
  public.

A publish job then needs a trigger, registry credentials in CI secrets, and
the published image name in `docker-compose.yml` next to `build`. None of
these exist yet.
