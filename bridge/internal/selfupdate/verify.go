package selfupdate

import (
	"bufio"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
)

var hexSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// VerifyFile checks a release's file as Install does before it installs
// one: sig, checksums.txt.sig, must be a signature of sums, checksums.txt, by
// PublicKey (ErrSignature), and data, the file called name, must have the
// sha256 that sums lists (ErrChecksum). The release workflow runs it through
// scripts/verify before it builds the Windows installer.
func VerifyFile(sums, sig []byte, name string, data []byte) error {
	key, err := publicKey()
	if err != nil {
		return err
	}
	return verifyFile(key, sums, sig, name, data)
}

func verifyFile(key ed25519.PublicKey, sums, sig []byte, name string, data []byte) error {
	if err := verify(key, sums, sig); err != nil {
		return err
	}
	want, err := checksum(sums, name)
	if err != nil {
		return err
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != want {
		return ErrChecksum
	}
	return nil
}

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
