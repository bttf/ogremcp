//go:build !darwin && !windows

package selfupdate

import "context"

// No release asset runs on other systems.

func assetName(string) (string, error) { return "", ErrUnsupported }

func installPath() (string, error) { return "", ErrUnsupported }

func newStage(string) (string, error) { return "", ErrUnsupported }

func put(context.Context, string, string, []byte) error { return ErrUnsupported }

func relaunch(string, string) error { return ErrUnsupported }
