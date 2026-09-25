#!/usr/bin/env bash
# Addon release tag check (§5 Releases, docs/releases.md). An addon-v tag
# names the adapter version it releases: addon-v0.2.0 releases the adapter
# whose TOC says `## Version: 0.2.0`. This fails unless every .toc at the top
# of kits/wow/adapter, as committed at TAG, has one `## Version` line equal to
# the tag's version. On success it prints the version.
#
# It compares text only. The platform build and the adapter-version CI check
# already require the TOC version to be semver (§8.2), so a tag that equals it
# is one too.
#
# Usage: scripts/check-addon-tag.sh TAG

set -euo pipefail

log() { printf 'check-addon-tag: %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }

[ $# -eq 1 ] || die "usage: check-addon-tag.sh TAG"
tag=$1
dir=kits/wow/adapter
version=${tag#addon-v}
if [ "$version" = "$tag" ] || [ -z "$version" ]; then
	die "$tag is not addon-v followed by a version"
fi
git rev-parse --verify --quiet "$tag^{commit}" > /dev/null || die "no tag or commit $tag"

# The .toc files at the top of the adapter, skipping dotfiles, as the
# platform's readAdapterVersion does.
tocs=$(git ls-tree --name-only "$tag" -- "$dir/" | grep -i "^$dir/[^./][^/]*\.toc\$" || true)
[ -n "$tocs" ] || die "$dir holds no .toc file at $tag"

while IFS= read -r toc; do
	# Strip a byte order mark and carriage returns, then take the value of
	# each `## Version:` line with surrounding space trimmed. The C locale
	# makes sed match bytes, the same way in BSD and GNU sed.
	found=$(git show "$tag:$toc" | LC_ALL=C sed $'1s/^\xef\xbb\xbf//' | tr -d '\r' |
		LC_ALL=C sed -nE 's/^[[:space:]]*##[[:space:]]*Version:[[:space:]]*(.*[^[:space:]])?[[:space:]]*$/\1/p')
	count=$(printf '%s' "$found" | grep -c '^' || true)
	[ "$count" -eq 1 ] || die "$toc at $tag must have one \"## Version:\" line; it has $count"
	[ "$found" = "$version" ] || die "$toc at $tag says \"## Version: $found\", but the tag $tag names $version"
done <<< "$tocs"

printf '%s\n' "$version"
