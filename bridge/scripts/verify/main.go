// Command verify checks a file of a published bridge release as self-update
// does before it installs one (docs/architecture.md §7 Self-update,
// docs/releases.md): the release's checksums.txt.sig must be a signature of
// its checksums.txt by the key embedded in the bridge (selfupdate.PublicKey),
// and the file must have the sha256 that checksums.txt lists. It is not part
// of the bridge. The release workflow runs it from bridge/ before it builds
// the Windows installer:
//
//	go run ./scripts/verify CHECKSUMS FILE
//
// CHECKSUMS is a release's checksums.txt, with its signature beside it as
// CHECKSUMS.sig. checksums.txt lists FILE by its base name.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/bttf/ogremcp/bridge/internal/selfupdate"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: go run ./scripts/verify CHECKSUMS FILE")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "verify:", err)
		os.Exit(1)
	}
}

func run(checksums, file string) error {
	sums, err := os.ReadFile(checksums)
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(checksums + ".sig")
	if err != nil {
		return err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	name := filepath.Base(file)
	if err := selfupdate.VerifyFile(sums, sig, name, data); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "verify: %s has the sha256 that checksums.txt lists, and checksums.txt has the release signature\n", name)
	return nil
}
