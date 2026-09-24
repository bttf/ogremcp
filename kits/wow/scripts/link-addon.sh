#!/usr/bin/env bash
# Symlink kits/wow/adapter into a WoW client's AddOns directory as
# Interface/AddOns/OpenGamerMCP. For development only; players get the addon
# from the bridge.
#
# Usage: kits/wow/scripts/link-addon.sh [era|forever|all|client-path]
#
#   era          Classic Era, $WOW_INSTALL_PATH/_classic_era_
#   forever      WoW Forever, $WOW_INSTALL_PATH/_classic_beta_
#   all          every named client that is installed; a missing one is skipped.
#                Every installed client is tried even when one fails, and the
#                script exits non-zero at the end if any failed.
#   client-path  a flavor directory, not the "World of Warcraft" folder above it
#
# With no argument the target is $WOW_CLIENT_PATH if it is set, else `all`.
# WOW_INSTALL_PATH defaults to "/Applications/World of Warcraft".
# Running it twice is a no-op.

set -euo pipefail

install_path="${WOW_INSTALL_PATH:-/Applications/World of Warcraft}"
era_path="$install_path/_classic_era_"
forever_path="$install_path/_classic_beta_"

kit_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$kit_root/adapter"
addon_name="OpenGamerMCP"

die() {
	printf 'link-addon: %s\n' "$1" >&2
	exit 1
}

# fail prints why one client could not be linked and returns 1. The caller
# decides whether to stop.
fail() {
	printf 'link-addon: %s\n' "$1" >&2
	return 1
}

# link_client links the addon into one client directory. It returns non-zero
# on failure instead of exiting, so `all` can go on to the next client. set -e
# does not apply inside a function called from `if` or `||`, so every step
# that can fail is checked.
link_client() {
	local client_path="$1"
	local addons_dir="$client_path/Interface/AddOns"
	local link_path="$addons_dir/$addon_name"
	local current

	[ -d "$client_path" ] || {
		fail "no WoW client at $client_path
pass era, forever, all, or a client path, or set WOW_CLIENT_PATH"
		return 1
	}

	mkdir -p "$addons_dir" || {
		fail "cannot create $addons_dir"
		return 1
	}

	if [ -L "$link_path" ]; then
		current="$(readlink "$link_path")"
		if [ "$current" = "$source_dir" ]; then
			printf 'link-addon: already linked: %s -> %s\n' "$link_path" "$source_dir"
			return 0
		fi
		printf 'link-addon: relinking (was -> %s)\n' "$current"
		rm "$link_path" || {
			fail "cannot remove $link_path"
			return 1
		}
	elif [ -e "$link_path" ]; then
		fail "$link_path exists and is not a symlink; remove it by hand first"
		return 1
	fi

	ln -s "$source_dir" "$link_path" || {
		fail "cannot link $link_path"
		return 1
	}
	printf 'link-addon: linked %s -> %s\n' "$link_path" "$source_dir"
	linked_any=1
}

# link_all tries every installed client and prints one result line per
# client. It sets any_failed when a client failed; the script exits non-zero
# at the end.
link_all() {
	local found=0
	local failed=0
	local client_path
	local results=()
	for client_path in "$era_path" "$forever_path"; do
		if [ ! -d "$client_path" ]; then
			printf 'link-addon: skipping %s (not installed)\n' "$client_path"
			results+=("skipped $client_path")
			continue
		fi
		found=1
		if link_client "$client_path"; then
			results+=("ok      $client_path")
		else
			failed=1
			results+=("FAILED  $client_path")
		fi
	done
	[ "$found" -eq 1 ] || die "no WoW client under $install_path
pass a client path as an argument or set WOW_CLIENT_PATH or WOW_INSTALL_PATH"
	printf 'link-addon: %s\n' "${results[@]}"
	any_failed=$failed
}

[ "$#" -le 1 ] || die "usage: kits/wow/scripts/link-addon.sh [era|forever|all|client-path]"
[ -d "$source_dir" ] || die "no adapter directory at $source_dir"

linked_any=0
any_failed=0
target="${1:-${WOW_CLIENT_PATH:-all}}"
case "$target" in
	era) link_client "$era_path" || exit 1 ;;
	forever) link_client "$forever_path" || exit 1 ;;
	all) link_all ;;
	*) link_client "$target" || exit 1 ;;
esac

if [ "$linked_any" -eq 1 ]; then
	printf 'link-addon: restart the client to pick up TOC changes; /reload is enough for Lua.\n'
fi
[ "$any_failed" -eq 0 ] || die "at least one client failed to link"
