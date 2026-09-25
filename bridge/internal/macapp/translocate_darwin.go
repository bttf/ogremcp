//go:build darwin && cgo

package macapp

/*
#cgo LDFLAGS: -framework CoreFoundation
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

// SecTranslocateCreateOriginalPathForURL is exported by Security.framework
// but is not in its public headers, so it is looked up at run time. It
// returns the path it is given when that path is not translocated.
typedef CFURLRef (*originalPathFunc)(CFURLRef, CFErrorRef *);

static int originalPath(const char *path, char *out, long size) {
	void *security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY);
	if (security == NULL) {
		return 0;
	}
	originalPathFunc fn = (originalPathFunc)dlsym(security, "SecTranslocateCreateOriginalPathForURL");
	if (fn == NULL) {
		return 0;
	}
	CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)path, (CFIndex)strlen(path), true);
	if (url == NULL) {
		return 0;
	}
	CFURLRef original = fn(url, NULL);
	CFRelease(url);
	if (original == NULL) {
		return 0;
	}
	Boolean ok = CFURLGetFileSystemRepresentation(original, true, (UInt8 *)out, (CFIndex)size);
	CFRelease(original);
	return ok ? 1 : 0;
}
*/
import "C"

import (
	"path/filepath"
	"unsafe"
)

// Original returns the path of the app the user opened. macOS runs an app
// that is quarantined and was not moved in Finder, such as one opened from
// Downloads, from a read-only copy at a random path (App Translocation), and
// the running program sees only that copy. For an app that is not
// translocated, Original returns app. It returns "" when it cannot tell.
//
// LetsMove and Electron's app.moveToApplicationsFolder look up the original
// path the same way.
func Original(app string) string {
	path := C.CString(app)
	defer C.free(unsafe.Pointer(path))
	const size = 4096
	out := (*C.char)(C.malloc(size))
	defer C.free(unsafe.Pointer(out))
	if C.originalPath(path, out, size) == 0 {
		return ""
	}
	return filepath.Clean(C.GoString(out))
}
