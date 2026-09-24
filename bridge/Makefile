# Bridge builds (docs/architecture.md §7, docs/releases.md). Output goes to
# dist/, which is git-ignored.
#
#   make dist    unsigned dev builds: the Windows binary and the macOS
#                universal binary as a zipped .app
#   make clean   remove dist/
#
# `make dist` needs GoReleaser v2 and a Mac with Xcode's command line tools:
# the macOS build uses cgo, and scripts/macos-app.sh uses lipo, codesign, and
# ditto. Nothing is signed with an identity or notarized; that is P9.
#
# Adapted from bttf/wow-guide@df80260, bridge/Makefile. GoReleaser replaces
# its dist and tray-app targets: universal_binaries does the lipo step, and
# scripts/macos-app.sh builds the .app.

GORELEASER ?= goreleaser

# The nearest bridge-v tag without its prefix, for example 1.2.3-4-gabc1234,
# or the short commit hash when there is no bridge-v tag. GoReleaser's own
# version would keep the prefix (docs/releases.md).
BRIDGE_VERSION ?= $(shell git describe --tags --match 'bridge-v*' --always --dirty | sed 's/^bridge-v//')
export BRIDGE_VERSION

.PHONY: dist clean

dist:
	$(GORELEASER) release --snapshot --clean

clean:
	rm -rf dist
