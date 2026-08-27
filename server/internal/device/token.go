package device

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// deviceTokenPrefix is the fixed prefix of device secrets, e.g.
// "pdv_AbC123...".
const deviceTokenPrefix = "pdv_"

// newDeviceToken returns (raw token, display prefix, sha256 hash). The
// raw token is shown to the user exactly once.
func newDeviceToken() (token, prefix, hash string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", "", fmt.Errorf("device: read token entropy: %w", err)
	}
	token = deviceTokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	return token, tokenPrefixFor(token), hashToken(token), nil
}

// tokenPrefixFor returns the short human-identifiable prefix of a token.
func tokenPrefixFor(token string) string {
	if len(token) >= 12 {
		return token[:12]
	}
	return token
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
