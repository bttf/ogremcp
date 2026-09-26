#!/usr/bin/env bash
# Put the app in a disk image, the macOS download (§7 Installer). GoReleaser
# runs this as the second universal_binaries post hook (.goreleaser.yaml),
# after scripts/macos-app.sh has built the app: disk images are a Pro feature
# (docs/releases.md).
#
# Usage: scripts/macos-dmg.sh APP OUT.dmg SIGNING
#
# SIGNING is one of:
#   adhoc          the image is not signed or notarized, and the app in it has
#                  an ad hoc signature. Snapshot builds (`make dist`, the dev
#                  build, the release dry run).
#   developer-id   the app must be Developer ID signed, notarized, and stapled
#                  already. scripts/macos-sign.sh then signs, notarizes, and
#                  staples the image, and fails when a credential is missing.
#                  Every release build.
#
# The image holds the app only, with no link to /Applications: the app is
# installed per user in ~/Applications, and offers to move itself there when
# it is opened from anywhere else (package macapp).
#
# Adapted from bttf/wow-guide@df80260, bridge/scripts/macos-dmg.sh: the
# staging folder, hdiutil create, and the image's signature and notarization,
# which now run in scripts/macos-sign.sh. The prototype's /Applications link
# and its unsigned fallback are dropped.

set -euo pipefail

log() { printf 'macos-dmg: %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }

[ $# -eq 3 ] || die "usage: macos-dmg.sh APP OUT.dmg adhoc|developer-id"
app=${1%/}
out=$2
signing=$3
scripts="$(cd "$(dirname "$0")" && pwd)"
case $signing in
adhoc | developer-id) ;;
*) die "SIGNING must be adhoc or developer-id, not $signing" ;;
esac
[ -d "$app" ] || die "no app at $app"
case $out in
*.dmg) ;;
*) die "$out does not end in .dmg" ;;
esac
name=$(basename "$app")

# A release puts only a notarized app in the image.
if [ "$signing" = developer-id ]; then
	bash "$scripts/macos-sign.sh" check "$app"
fi

work=$(mktemp -d)
mnt="$work/mnt"
cleanup() {
	if [ -d "$mnt" ]; then
		hdiutil detach -quiet "$mnt" 2>/dev/null || hdiutil detach -quiet -force "$mnt" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

mkdir "$work/stage"
ditto "$app" "$work/stage/$name"
rm -f "$out"
hdiutil create -quiet -volname "Ogre MCP" -srcfolder "$work/stage" -fs HFS+ -format UDZO -ov "$out"

if [ "$signing" = developer-id ]; then
	bash "$scripts/macos-sign.sh" sign "$out"
fi

# The image is what ships, so check the app it holds, not only the one on
# disk.
mkdir "$mnt"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$out"
codesign --verify --strict "$mnt/$name"
if [ "$signing" = developer-id ]; then
	bash "$scripts/macos-sign.sh" check "$mnt/$name"
fi
hdiutil detach -quiet "$mnt"
rmdir "$mnt"

if [ "$signing" = adhoc ]; then
	log "built $out (unsigned: not signed or notarized; the app has an ad hoc signature)"
else
	log "built $out (Developer ID signed, notarized, stapled)"
fi
