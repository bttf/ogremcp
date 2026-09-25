package lock

import (
	"errors"
	"path/filepath"
	"testing"
)

// Adapted from bttf/wow-guide@df80260, bridge/internal/state/lock_test.go.
func TestOneBridgePerLockFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "bridge.lock")
	first, err := Acquire(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Acquire = %v, want ErrLocked", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	if err := first.Release(); err != nil {
		t.Errorf("second Release = %v", err)
	}
	again, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire after Release = %v", err)
	}
	again.Release()
}
