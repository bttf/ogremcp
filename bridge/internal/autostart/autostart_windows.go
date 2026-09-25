package autostart

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

const runKeyPath = `Software\Microsoft\Windows\CurrentVersion\Run`

// New is the login item that runs args, a value under
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run. Windows keeps no
// standard error for it, so stderrPath is not used.
func New(args []string, stderrPath string) (Manager, error) {
	return RunKey{Key: runRegistry{}, Name: RunValueName, Value: RunValue(args)}, nil
}

// runRegistry is the Run key of the current user.
type runRegistry struct{}

func (runRegistry) open(access uint32) (registry.Key, error) {
	return registry.OpenKey(registry.CURRENT_USER, runKeyPath, access)
}

func (r runRegistry) GetString(name string) (string, bool, error) {
	k, err := r.open(registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return "", false, nil
		}
		return "", false, err
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	if errors.Is(err, registry.ErrNotExist) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (r runRegistry) SetString(name, value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(name, value)
}

func (r runRegistry) Delete(name string) error {
	k, err := r.open(registry.SET_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}
