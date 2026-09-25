//go:build windows

package process

import (
	"errors"
	"unsafe"

	"golang.org/x/sys/windows"
)

// System is the Lister of this machine. On Windows it reads a Toolhelp
// snapshot of the process list, which starts no program and so opens no
// console window.
type System struct{}

func (System) Processes() ([]string, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	var list []string
	err = windows.Process32First(snap, &entry)
	for err == nil {
		list = append(list, windows.UTF16ToString(entry.ExeFile[:]))
		err = windows.Process32Next(snap, &entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	return list, nil
}
