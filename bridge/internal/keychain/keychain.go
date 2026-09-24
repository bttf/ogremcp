// Package keychain keeps the bridge's refresh token in the OS keychain
// (docs/architecture.md §7): the macOS Keychain or the Windows Credential
// Manager, through github.com/zalando/go-keyring. The token is never written
// to a plain file.
package keychain

import (
	"errors"

	"github.com/zalando/go-keyring"
)

// Service names the bridge's keychain entries. Each server base URL has an
// entry of its own, with the URL as its account.
const Service = "ogmcp-bridge"

// Entry is the keychain entry of one server. It is an auth.Store.
type Entry struct {
	// Account is the server's base URL, as auth.ParseBaseURL returns it.
	Account string
}

// Get returns the refresh token, or "" when the entry does not exist.
func (e Entry) Get() (string, error) {
	token, err := keyring.Get(Service, e.Account)
	if errors.Is(err, keyring.ErrNotFound) {
		return "", nil
	}
	return token, err
}

// Set creates the entry or replaces its refresh token.
func (e Entry) Set(token string) error {
	return keyring.Set(Service, e.Account, token)
}

// Delete removes the entry. An entry that does not exist is not an error.
func (e Entry) Delete() error {
	err := keyring.Delete(Service, e.Account)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil
	}
	return err
}
