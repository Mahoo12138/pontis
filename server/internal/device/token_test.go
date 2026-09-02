package device

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

func TestNewDeviceTokenFormat(t *testing.T) {
	token, prefix, hash, err := newDeviceToken()
	if err != nil {
		t.Fatalf("newDeviceToken error: %v", err)
	}
	if !strings.HasPrefix(token, "pdv_") {
		t.Errorf("token = %q, want pdv_ prefix", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, "pdv_"))
	if err != nil {
		t.Fatalf("token suffix is not valid raw-url base64: %v", err)
	}
	if len(raw) != 32 {
		t.Errorf("token entropy length = %d bytes, want 32", len(raw))
	}
	if prefix != tokenPrefixFor(token) {
		t.Errorf("prefix = %q, want tokenPrefixFor(token) = %q", prefix, tokenPrefixFor(token))
	}
	sum := sha256.Sum256([]byte(token))
	if hash != hex.EncodeToString(sum[:]) {
		t.Error("hash is not the sha256 hex of the token")
	}
}

func TestNewDeviceTokenUnique(t *testing.T) {
	t1, _, h1, err := newDeviceToken()
	if err != nil {
		t.Fatalf("newDeviceToken error: %v", err)
	}
	t2, _, h2, err := newDeviceToken()
	if err != nil {
		t.Fatalf("newDeviceToken error: %v", err)
	}
	if t1 == t2 || h1 == h2 {
		t.Error("two device tokens collide")
	}
}

func TestTokenPrefixFor(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"pdv_AbC123xyz45", "pdv_AbC123xy"},
		{"pdv_verylongtoken", "pdv_verylong"},
		{"short", "short"},
		{"1234567890123", "123456789012"}, // 13 chars -> first 12
		{"123456789012", "123456789012"}, // exactly 12 returned whole
	}
	for _, c := range cases {
		if got := tokenPrefixFor(c.in); got != c.want {
			t.Errorf("tokenPrefixFor(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestHashTokenDeterministic(t *testing.T) {
	a := hashToken("pdv_fixed-input")
	b := hashToken("pdv_fixed-input")
	c := hashToken("pdv_other-input")
	if a != b {
		t.Error("hashToken not deterministic for the same input")
	}
	if a == c {
		t.Error("hashToken produced identical hashes for different inputs")
	}
	if len(a) != 64 {
		t.Errorf("hash length = %d, want 64 hex chars", len(a))
	}
}
