# Releases

Spec: §5 (Releases), §7. Decided in RED-287 (P0.7). RED-323 (P5.7) and
RED-344 (P9.3) build on this.

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

A local build stamps the version from the nearest `bridge-v` tag:

```sh
BRIDGE_VERSION=$(git describe --tags --match 'bridge-v*' --always --dirty | sed 's/^bridge-v//') \
  goreleaser release --snapshot --clean
```

The config lives in `bridge/.goreleaser.yaml` and runs from `bridge/`. The core
keys, all OSS. The two platforms are separate build ids because their env and
ldflags differ. macOS needs `CGO_ENABLED=1` for the tray code. On an arm64
macOS runner, the darwin/amd64 build is a cross-compile, and Go turns cgo off
for cross-compiles unless `CGO_ENABLED=1` is set.

```yaml
version: 2
project_name: ogmcp-bridge
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
  is not a template, so its value is fixed in the config. To change it for one
  release, run `gh release edit "$TAG" --prerelease` (or `--prerelease=false`)
  after publishing.
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

- Add `bridge/.goreleaser.yaml` with the keys above. `make -C bridge dist`
  runs the local build command. It is the one local command that builds both
  platforms, and it needs GoReleaser v2 installed.
- The `.app` is not an OSS feature. A `universal_binaries` post hook runs a
  script adapted from the prototype's `tray-app` target
  (`bttf/wow-guide@df80260`, `bridge/Makefile`), without its `lipo` step. Add
  the zipped `.app` to `checksum.extra_files` and `release.extra_files`.
- Build on macOS: the prototype's tray app needs cgo on macOS. The
  `bridge-darwin` build sets `CGO_ENABLED=1` for both architectures. The
  `bridge-windows` build sets `CGO_ENABLED=0` and adds `-H windowsgui` to its
  ldflags.
- Unsigned dev builds are either CI artifacts from `--snapshot` or releases
  with `release.prerelease: true` fixed in the config.

## How P9.3 (RED-344) uses it

- A workflow on `push: tags: ['bridge-v*']` on a macOS runner. Check out with
  `fetch-depth: 0` so `git describe` sees the tags. Run
  `goreleaser/goreleaser-action` with `distribution: goreleaser`, pinned by
  commit SHA, with the guard, the env vars, and `--skip=validate`.
- The detached signature is a `signs` entry over `checksums.txt`. It runs any
  command, so the §7 ed25519 signer fits. Key material comes from CI secrets.
- macOS signing, notarization, and the `.dmg` run in the post hook script (the
  prototype's `bridge/scripts/macos-dmg.sh`), because GoReleaser's versions
  are Pro.
- Windows code signing (Azure Trusted Signing) signs the `.exe` in place, so it
  runs from `hooks.post` on the `bridge-windows` build. That hook runs before
  the checksums are written. `binary_signs` does not fit: it expects a
  detached signature file (`${artifact}.sig`), an in-place signer writes none,
  and the upload of that missing file then fails. Inno Setup needs Windows,
  and OSS has no split and merge. If the installer is built in a Windows job,
  run GoReleaser with `--skip=publish`, build the installer, then write
  checksums, sign, and run `gh release create "$TAG" --verify-tag` in a final
  job.
- `addon-v` tags do not use GoReleaser. That workflow zips `kits/wow/adapter`
  and publishes with `gh release create`.
- Self-update lists releases and keeps `bridge-v` tags (§7). GitHub's
  `releases/latest` endpoint returns the newest non-draft, non-prerelease
  release whatever its tag, which can be an `addon-v` release.

## Alternative considered

Plain `go build` for each target, `lipo`, `shasum -a 256`, a signing command,
and `gh release create "$TAG" --verify-tag`. It produces the same artifacts
for free and needs no tag-prefix settings. It is not chosen because §7 names
GoReleaser and the free GoReleaser path works. If P9 moves checksums, signing,
and publishing into a final job, GoReleaser only builds the binaries, and this
alternative is simpler.
