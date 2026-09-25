//go:build darwin || linux || freebsd || netbsd || openbsd || dragonfly

package lock

import (
	"errors"
	"os"
	"syscall"
)

// lockFile takes an exclusive flock. Two opens of one file conflict even in
// one process.
func lockFile(f *os.File) error {
	err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) {
		return ErrLocked
	}
	return err
}

func unlockFile(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
