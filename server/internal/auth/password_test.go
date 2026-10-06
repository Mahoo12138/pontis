package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

func TestHashPasswordVerifyRoundTrip(t *testing.T) {
	passwords := []string{
		"correct horse battery staple",
		"p@ssw0rd-中文-🔐",
		strings.Repeat("x", 200),
	}
	for _, pw := range passwords {
		encoded, err := HashPassword(pw)
		if err != nil {
			t.Fatalf("HashPassword(%q) error: %v", pw, err)
		}
		ok, err := VerifyPassword(pw, encoded)
		if err != nil {
			t.Fatalf("VerifyPassword(%q) error: %v", pw, err)
		}
		if !ok {
			t.Errorf("VerifyPassword(%q) = false, want true", pw)
		}
	}
}

func TestVerifyPasswordWrongPassword(t *testing.T) {
	encoded, err := HashPassword("right password")
	if err != nil {
		t.Fatalf("HashPassword error: %v", err)
	}
	ok, err := VerifyPassword("wrong password", encoded)
	if err != nil {
		t.Fatalf("VerifyPassword error: %v", err)
	}
	if ok {
		t.Error("VerifyPassword with wrong password = true, want false")
	}
}

func TestHashPasswordUniqueSalts(t *testing.T) {
	a, err := HashPassword("same password")
	if err != nil {
		t.Fatalf("HashPassword error: %v", err)
	}
	b, err := HashPassword("same password")
	if err != nil {
		t.Fatalf("HashPassword error: %v", err)
	}
	if a == b {
		t.Error("two hashes of the same password are identical; salt must be random")
	}
}

func TestHashPasswordPHCFormat(t *testing.T) {
	encoded, err := HashPassword("hunter2")
	if err != nil {
		t.Fatalf("HashPassword error: %v", err)
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 {
		t.Fatalf("hash has %d $-separated parts, want 6: %q", len(parts), encoded)
	}
	if parts[1] != "argon2id" {
		t.Errorf("algo = %q, want argon2id", parts[1])
	}
	if parts[2] != "v=19" {
		t.Errorf("version segment = %q, want v=19", parts[2])
	}
	if parts[3] != "m=65536,t=1,p=4" {
		t.Errorf("params segment = %q, want m=65536,t=1,p=4", parts[3])
	}
	for i, seg := range parts[4:] {
		if _, err := base64.RawStdEncoding.DecodeString(seg); err != nil {
			t.Errorf("segment %d is not valid raw-std base64: %v", i+4, err)
		}
	}
	salt, _ := base64.RawStdEncoding.DecodeString(parts[4])
	if len(salt) != argonSaltLen {
		t.Errorf("decoded salt length = %d, want %d", len(salt), argonSaltLen)
	}
}

func TestVerifyPasswordMalformedHashes(t *testing.T) {
	valid, err := HashPassword("pw")
	if err != nil {
		t.Fatalf("HashPassword error: %v", err)
	}
	parts := strings.Split(valid, "$")
	broken := map[string]string{
		"empty":            "",
		"too few parts":    "$argon2id$v=19",
		"wrong algo":       "$bcrypt$v=19$m=65536,t=1,p=4$" + parts[4] + "$" + parts[5],
		"bad version":      "$argon2id$v=abc$m=65536,t=1,p=4$" + parts[4] + "$" + parts[5],
		"bad params":       "$argon2id$v=19$m=65536$" + parts[4] + "$" + parts[5],
		"bad salt base64":  "$argon2id$v=19$m=65536,t=1,p=4$!!!$" + parts[5],
		"bad hash base64":  "$argon2id$v=19$m=65536,t=1,p=4$" + parts[4] + "$@@@",
		"missing algo":     "$v=19$m=65536,t=1,p=4$" + parts[4] + "$" + parts[5],
	}
	for name, encoded := range broken {
		ok, err := VerifyPassword("pw", encoded)
		if ok {
			t.Errorf("%s: VerifyPassword = true, want false", name)
		}
		if err == nil {
			t.Errorf("%s: VerifyPassword err = nil, want error", name)
		}
	}
}

func TestNewSessionToken(t *testing.T) {
	tok, hash, err := newSessionToken()
	if err != nil {
		t.Fatalf("newSessionToken error: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	if err != nil {
		t.Fatalf("token is not valid raw-url base64: %v", err)
	}
	if len(raw) != 32 {
		t.Errorf("token entropy length = %d bytes, want 32", len(raw))
	}
	sum := sha256.Sum256([]byte(tok))
	if hash != hex.EncodeToString(sum[:]) {
		t.Error("returned token hash is not the sha256 hex of the token")
	}

	tok2, _, err := newSessionToken()
	if err != nil {
		t.Fatalf("newSessionToken error: %v", err)
	}
	if tok == tok2 {
		t.Error("two session tokens are identical")
	}
}
