//go:build !darwin

package main

import "log/slog"

// offerMove does nothing: only the macOS app moves itself (§7 Installer). The
// Windows installer installs the bridge per user.
func offerMove(*slog.Logger, string) bool {
	return false
}
