package selfupdate

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
)

var hexSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// verify checks that sig, checksums.txt.sig, is a signature of sums, the
// bytes of checksums.txt, by key. The release job writes the 64-byte Ed25519
// signature as base64 and a newline (scripts/sign).
func verify(key ed25519.PublicKey, sums, sig []byte) error {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || len(raw) != ed25519.SignatureSize {
		return fmt.Errorf("%w: the signature is not 64 bytes of base64", ErrSignature)
	}
	if !ed25519.Verify(key, sums, raw) {
		return ErrSignature
	}
	return nil
}

// checksum returns the sha256 that sums, a checksums.txt, lists for the file
// name: lines of a sha256 in lower-case hex, two spaces, and a file name.
func checksum(sums []byte, name string) (string, error) {
	lines := bufio.NewScanner(bytes.NewReader(sums))
	for lines.Scan() {
		sum, file, ok := strings.Cut(lines.Text(), "  ")
		if ok && file == name && hexSHA256.MatchString(sum) {
			return sum, nil
		}
	}
	return "", fmt.Errorf("checksums.txt lists no sha256 for %s", name)
}
