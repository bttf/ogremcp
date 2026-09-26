# Releases

Spec: §5 (Releases), §7. Decided in RED-287 (P0.7). RED-323 (P5.7),
RED-344 (P9.3), and RED-273 (the Windows installer) build on this.

## Cutting a release

Pushing a `bridge-v` or `addon-v` tag publishes a release. There is no
approval step after the push. Tag a commit on `main` that passed CI: both
workflows fail when the tagged commit is not on `main`. Both kinds of release
go to the repo's one Releases page (§5).

### Bridge

1. Check that the six signing secrets are set in the `release` environment
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
Only after that does GoReleaser write `checksums.txt` and publish. The
release, named "Bridge 1.2.3", holds:

- `ogremcp-bridge_1.2.3_windows_amd64.exe`, unsigned (§7, D6)
- `ogremcp-bridge_1.2.3_darwin_all.app.zip`, signed and notarized
- `checksums.txt`
- `ogremcp-bridge_1.2.3_windows_amd64_setup.exe`, the Windows installer,
  unsigned and untested, added after publishing ("Windows installer" below)

The release notes start with a note that the Windows build is unsigned and
untested and that Windows SmartScreen warns on first run (`release.header`
in `bridge/.goreleaser.yaml`).

Every GoReleaser run that is not a snapshot signs the app or fails: the hook
passes `developer-id` unless `.IsSnapshot` is set (`bridge/.goreleaser.yaml`),
and `macos-sign.sh` has no unsigned fallback. Snapshots (`make -C bridge
dist`, the dev build, the dry run) get an ad hoc signature only.

The version is the tag without `bridge-v`, such as `1.2.3` or `1.2.3-rc.1`.
The job fails on a tag with any other form. A version with a `-`, such as
`1.2.3-rc.1`, is published as a pre-release and is never marked Latest.

Bridge releases run one at a time. A second tag waits for the first release
to finish. GitHub keeps only one waiting run, so a third tag pushed while one
runs and one waits cancels the waiting one. Push one `bridge-v` tag at a time.

When the job fails, fix the cause and re-run it from the Actions tab. A
failure during upload leaves a draft release, because GoReleaser publishes
the release only after every upload. Delete that draft before the re-run.

### Windows installer

Spec: §7 (Installer, Signing), D6. Built in RED-273.

`bridge/windows/ogremcp-bridge.iss` is the Inno Setup script. The installer
installs the bridge only, for the current user, as
`%LOCALAPPDATA%\Programs\Ogre MCP\ogremcp-bridge.exe`. It needs no admin
rights (`PrivilegesRequired=lowest`), so self-update can replace the program
in place. It adds a Start menu shortcut and starts the bridge when it
finishes. An upgrade closes a running bridge first. Start at login stays the
tray's setting, and the bridge installs the addon, so the installer does
neither. The uninstaller ends a running bridge, then removes the program,
the shortcut, the files a self-update leaves beside the program, and the
tray's start-at-login value. It leaves the settings, the logs, and the
refresh token in Windows Credential Manager.

The installer is unsigned (D6) and untested: nobody has run it, or the bridge
it installs, on Windows 10 or 11 (RED-347). The dry run only installs and
uninstalls it silently on a Windows Server runner. Windows SmartScreen warns
on first run; choose More info, then Run anyway.

`bridge/scripts/windows-installer.ps1` builds it on Windows, with Inno Setup
6.3 or later. GitHub's `windows-latest` image has it (6.7.1 in September
2026). The script takes the version from the binary's name:

    pwsh -File bridge/scripts/windows-installer.ps1 -Exe ogremcp-bridge_1.2.3_windows_amd64.exe -OutDir out

That writes `out/ogremcp-bridge_1.2.3_windows_amd64_setup.exe`. The raw
binary stays in each release too, because self-update downloads it (§7).

Inno Setup runs only on Windows, and GoReleaser OSS publishes from the one
macOS job. So the `windows-installer` job of the `Bridge release` workflow
runs on a Windows runner after the `release` job passes. It downloads the
published Windows binary and `checksums.txt`, checks the binary against
them, builds the installer, and adds it to the release with
`gh release upload`. It does not run when the `release` job fails, so it
never adds to a release without the signed macOS app. Because the installer
is added after publishing:

- The release is public for a few minutes before the installer is added.
- `checksums.txt` does not list the installer.
- When the job fails, the release stays published without the installer. Fix
  the cause and re-run the failed job from the Actions tab.
- The repo's immutable releases setting must stay off (it is off). An
  immutable release takes no new files after it is published.

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
A manual run runs only the dry-run jobs and never publishes, even on a tag.
The `dry-run` job builds a snapshot, as `make -C bridge dist` does, and lists
the files a release would publish. The `dry-run-windows-installer` job builds
the Windows installer from the snapshot's Windows binary, installs and
uninstalls it silently on a Windows runner, and keeps it as a workflow
artifact for 14 days. Both have a read-only token and no access to the
`release` environment, so they neither sign nor check the secrets. The first
tag is the first run that uses them.

The `Bridge dev build` workflow runs on pushes to `main` that touch `bridge/`,
not on PRs, to save macOS minutes. Start it for a branch with
`gh workflow run bridge-dev-build.yml --ref <branch>`.

### Signing secrets

D6: macOS builds are Developer ID signed and notarized. The bridge release
job reads six secrets from a GitHub environment named `release`. Only that
job uses the environment. The dry run does not.

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

The job writes the certificate and the key under `RUNNER_TEMP` and deletes
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
  goreleaser release --snapshot --clean
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
  Windows binary and the zipped `.app` and publishes no release.

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
  prototype's `bridge/scripts/macos-dmg.sh`. The `.dmg` (RED-342) reuses it.
- `addon-v` tags do not use GoReleaser. `.github/workflows/addon-release.yml`
  zips `kits/wow/adapter` with `git archive` and publishes with
  `gh release create`.

Left for later issues:

- The detached signature (RED-343) is a `signs` entry over `checksums.txt`.
  It runs any command, so the §7 ed25519 signer fits. Key material comes from
  CI secrets.
- Self-update (RED-343) lists releases and keeps `bridge-v` tags (§7).
  GitHub's `releases/latest` endpoint is not a safe source for it: it returns
  a release whatever its tag.
- The Windows installer (RED-273) needs Windows, and OSS has no split and
  merge. A Windows job adds it after the release is published ("Windows
  installer" above), so `checksums.txt` does not list it. To list it, run
  GoReleaser with `--skip=publish`, build the installer, then write
  checksums, sign, and run `gh release create "$TAG" --verify-tag` in a final
  job.
- Windows code signing is `[later]` (§7, D6). Azure Trusted Signing signs the
  `.exe` in place, so it would run from `hooks.post` on the `bridge-windows`
  build, which runs before the checksums are written. `binary_signs` does not
  fit: it expects a detached signature file (`${artifact}.sig`), an in-place
  signer writes none, and the upload of that missing file then fails.

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
