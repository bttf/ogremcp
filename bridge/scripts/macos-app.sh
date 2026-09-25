#!/usr/bin/env bash
# Wrap the universal macOS binary in an .app and zip it. GoReleaser runs this
# as the universal_binaries post hook (.goreleaser.yaml): app bundles are a
# Pro feature (docs/releases.md).
#
# Usage: scripts/macos-app.sh BINARY VERSION APP OUT.zip SIGNING
#
# SIGNING is one of:
#   adhoc          an ad hoc signature only, which seals the bundle. Not
#                  signed with a Developer ID or notarized. Snapshot builds
#                  (`make dist`, the dev build, the release dry run).
#   developer-id   Developer ID signed, notarized, and stapled by
#                  scripts/macos-sign.sh (§7 Signing, D6), which fails when a
#                  credential is missing. Every release build.
#
# Adapted from bttf/wow-guide@df80260: the tray-app target in bridge/Makefile
# (bundle layout, version, ad hoc signature) and bridge/scripts/macos-dmg.sh
# (argument checks, zipping the app with ditto).

set -euo pipefail

log() { printf 'macos-app: %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }

[ $# -eq 5 ] || die "usage: macos-app.sh BINARY VERSION APP OUT.zip adhoc|developer-id"
bin=$1
version=$2
app=$3
out=$4
signing=$5
scripts="$(cd "$(dirname "$0")" && pwd)"
plist="$(cd "$scripts/.." && pwd)/macos/Info.plist"
case $signing in
adhoc | developer-id) ;;
*) die "SIGNING must be adhoc or developer-id, not $signing" ;;
esac
[ -f "$bin" ] || die "no binary at $bin"
[ -f "$plist" ] || die "no Info.plist at $plist"

# §7: one binary for Apple Silicon and Intel.
lipo "$bin" -verify_arch arm64 x86_64 || die "$bin does not hold both arm64 and x86_64"

exe=$(plutil -extract CFBundleExecutable raw -o - "$plist")
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/$exe"

# CFBundleShortVersionString takes the X.Y.Z of the version, or 0.0.0.
short=$(printf '%s\n' "$version" | sed -nE 's/^v?([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')
sed "s/@VERSION@/${short:-0.0.0}/g" "$plist" > "$app/Contents/Info.plist"
plutil -lint -s "$app/Contents/Info.plist"

codesign --force --sign - "$app"
codesign --verify --strict "$app"

if [ "$signing" = developer-id ]; then
	bash "$scripts/macos-sign.sh" sign "$app"
fi

# ditto keeps the executable bit and the bundle layout. Extended attributes
# would become ._ files, which break the bundle's seal when an unzip tool
# extracts them as files.
rm -f "$out"
ditto -c -k --norsrc --noextattr --noacl --keepParent "$app" "$out"

if [ "$signing" = adhoc ]; then
	log "built $out (unsigned: ad hoc signature, not notarized)"
	exit 0
fi

# The zip is what ships, so check the app it holds, not only the one on disk.
check=$(mktemp -d)
trap 'rm -rf "$check"' EXIT
ditto -x -k "$out" "$check"
bash "$scripts/macos-sign.sh" check "$check/$(basename "$app")"
log "built $out (Developer ID signed, notarized, stapled)"
