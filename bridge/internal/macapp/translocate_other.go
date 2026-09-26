//go:build !darwin || !cgo

package macapp

// Original returns "": without cgo the bridge cannot ask macOS where a
// translocated app came from, and only macOS translocates apps. A macOS build
// without cgo has no tray app (tray_nocgo.go), so nothing calls it there.
func Original(app string) string {
	return ""
}
