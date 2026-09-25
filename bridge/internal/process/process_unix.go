//go:build !windows

package process

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// System is the Lister of this machine. On macOS and Linux it runs ps, which
// lists every process of every user with its executable path (macOS) or name
// (Linux).
type System struct{}

func (System) Processes() ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-axo", "comm=").Output()
	if err != nil {
		return nil, err
	}
	var list []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			list = append(list, line)
		}
	}
	return list, nil
}
