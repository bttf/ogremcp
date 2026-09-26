// Command sign writes the detached Ed25519 signature of a bridge release's
// checksums.txt, which each bridge verifies before it updates itself
// (docs/architecture.md §7 Self-update, docs/releases.md). It is not part of
// the bridge. GoReleaser runs it from bridge/ as the signs entry of
// .goreleaser.yaml, in a release build only:
//
//	go run ./scripts/sign FILE SIGNATURE
//
// It reads the private key, PKCS#8 PEM, from the file that
// BRIDGE_UPDATE_SIGNING_KEY_PATH names, and writes to SIGNATURE the 64-byte
// signature of FILE's bytes as base64 and a newline. It prints the key's
// public half, which is not secret, and never the private key.
package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
)

// envKeyPath names the file that holds the private key.
const envKeyPath = "BRIDGE_UPDATE_SIGNING_KEY_PATH"

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: go run ./scripts/sign FILE SIGNATURE")
		os.Exit(2)
	}
	if err := sign(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, "sign:", err)
		os.Exit(1)
	}
}

func sign(file, signature string) error {
	keyPath := os.Getenv(envKeyPath)
	if keyPath == "" {
		return errors.New(envKeyPath + " is not set. A release is never published without its signature (docs/releases.md).")
	}
	key, err := readKey(keyPath)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	sig := ed25519.Sign(key, data)
	pub := key.Public().(ed25519.PublicKey)
	if !ed25519.Verify(pub, data, sig) {
		return errors.New("the signature does not verify")
	}
	if err := os.WriteFile(signature, []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "sign: signed %s with the key whose public half is %s\n", file, base64.StdEncoding.EncodeToString(pub))
	return nil
}

// readKey reads an Ed25519 private key in PKCS#8 PEM. Its errors do not quote
// the file.
func readKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("could not read the signing key: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "PRIVATE KEY" {
		return nil, fmt.Errorf("%s does not hold a PKCS#8 PEM private key", envKeyPath)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("%s does not hold a PKCS#8 private key", envKeyPath)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("%s holds a private key that is not Ed25519", envKeyPath)
	}
	return key, nil
}
