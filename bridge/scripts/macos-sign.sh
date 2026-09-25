#!/usr/bin/env bash
# Sign a macOS .app or .dmg with a Developer ID identity, notarize it, and
# staple the ticket (§7 Signing, D6). A release never ships an unsigned macOS
# build, so a missing credential is an error, never a fallback to ad hoc.
#
# Usage: scripts/macos-sign.sh sign PATH    sign, notarize, staple, then check
#        scripts/macos-sign.sh check PATH   check that PATH is signed with a
#                                           Developer ID, carries a stapled
#                                           ticket, and passes Gatekeeper
#
# PATH is an .app bundle or a .dmg. `sign` reads:
#   MACOS_SIGN_IDENTITY   Developer ID Application identity: its SHA-1 hash or
#                         its full name
#   MACOS_KEYCHAIN        optional: the keychain that holds it. Default: the
#                         search list.
#   APPLE_API_KEY_PATH    App Store Connect API key (.p8 file) for notarytool
#   APPLE_API_KEY_ID      its key ID
#   APPLE_API_ISSUER_ID   its issuer ID
# The release workflow (.github/workflows/bridge-release.yml) sets them from CI
# secrets (docs/releases.md). The script prints none of them.
#
# Adapted from bttf/wow-guide@df80260, bridge/scripts/macos-dmg.sh: the
# Developer ID signature with hardened runtime, the notarization, and the
# staple.

set -euo pipefail

log() { printf 'macos-sign: %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }

[ $# -eq 2 ] || die "usage: macos-sign.sh sign|check PATH"
action=$1
path=${2%/}
name=$(basename "$path")
case $path in
	*.app) [ -d "$path" ] || die "no app at $path" ;;
	*.dmg) [ -f "$path" ] || die "no disk image at $path" ;;
	*) die "$path is neither an .app nor a .dmg" ;;
esac

# Gatekeeper accepts only a Developer ID signature with a notarization ticket,
# so spctl fails for an ad hoc or unnotarized build.
check() {
	case $path in
		*.app)
			codesign --verify --strict --verbose=2 "$path"
			xcrun stapler validate "$path"
			spctl --assess --type execute --verbose=2 "$path"
			;;
		*.dmg)
			codesign --verify --verbose=2 "$path"
			xcrun stapler validate "$path"
			spctl --assess --type open --context context:primary-signature --verbose=2 "$path"
			;;
	esac
	log "$name is signed with a Developer ID, notarized, and stapled"
}

# notarytool can exit 0 for a rejected submission, so the status is read from
# its JSON output. On rejection the log names the files and the reasons.
notarize() {
	local file=$1 result="$work/notary.json" status id
	log "notarizing $(basename "$file"); this waits for Apple, often several minutes"
	xcrun notarytool submit "$file" \
		--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" \
		--wait --timeout 30m --output-format json >"$result" || true
	status=$(plutil -extract status raw -o - "$result" 2>/dev/null || echo "unknown")
	id=$(plutil -extract id raw -o - "$result" 2>/dev/null || echo "")
	if [ "$status" != "Accepted" ]; then
		log "notarization of $(basename "$file") ended with status $status${id:+ (submission $id)}"
		if [ -n "$id" ]; then
			xcrun notarytool log "$id" \
				--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" >&2 || true
		fi
		exit 1
	fi
	log "notarization accepted (submission $id)"
}

sign() {
	local missing="" var
	for var in MACOS_SIGN_IDENTITY APPLE_API_KEY_PATH APPLE_API_KEY_ID APPLE_API_ISSUER_ID; do
		[ -n "${!var:-}" ] || missing="$missing $var"
	done
	[ -z "$missing" ] || die "cannot sign $name:$missing not set. A release never ships an unsigned macOS build (docs/releases.md)."
	[ -f "$APPLE_API_KEY_PATH" ] || die "cannot notarize $name: APPLE_API_KEY_PATH names no file"

	local keychain_args=()
	if [ -n "${MACOS_KEYCHAIN:-}" ]; then
		keychain_args=(--keychain "$MACOS_KEYCHAIN")
	fi

	# Hardened runtime and a secure timestamp: notarization requires both for
	# code. The app needs no entitlements: it is not sandboxed, Go generates no
	# code at run time, and it loads only system frameworks.
	log "signing $name with a Developer ID identity"
	case $path in
		*.app)
			codesign --force --options runtime --timestamp \
				${keychain_args[@]+"${keychain_args[@]}"} --sign "$MACOS_SIGN_IDENTITY" "$path"
			;;
		*.dmg)
			codesign --force --timestamp \
				${keychain_args[@]+"${keychain_args[@]}"} --sign "$MACOS_SIGN_IDENTITY" "$path"
			;;
	esac

	work=$(mktemp -d)
	trap 'rm -rf "$work"' EXIT
	# notarytool takes a zip, a .dmg, or a .pkg, so an app goes up as a zip.
	# The ticket is then stapled to the app itself, so it opens without a
	# network check.
	case $path in
		*.app)
			ditto -c -k --keepParent "$path" "$work/$name.zip"
			notarize "$work/$name.zip"
			;;
		*.dmg)
			notarize "$path"
			;;
	esac
	xcrun stapler staple "$path"
	check
}

case $action in
	sign) sign ;;
	check) check ;;
	*) die "usage: macos-sign.sh sign|check PATH" ;;
esac
