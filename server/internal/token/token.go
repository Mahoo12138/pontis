// Package token manages external API credentials: creation with scoped
// permissions, listing and revocation. Secrets are stored hashed and
// returned to the user exactly once.
package token

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Token is an external API credential.
type Token struct {
	ID         string
	UserID     string
	Name       string
	Scopes     []string
	SpaceScope string // "all" or JSON array of space ids
	CreatedAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// Errors.
var (
	ErrNameRequired  = errors.New("token: name must not be empty")
	ErrInvalidScopes = errors.New("token: unknown scope")
	ErrTokenNotFound = errors.New("token: token not found")

	// ErrTokenInvalid reports a secret that is not one this instance
	// issued, is revoked, or belongs to an account that may not be used.
	ErrTokenInvalid = errors.New("token: credential invalid")
)

// Scope is one capability grant. The allow-list is closed (doc 09 §9).
type Scope string

const (
	ScopeBookmarksRead     Scope = "bookmarks:read"
	ScopeBookmarksWrite    Scope = "bookmarks:write"
	ScopePublicationsRead  Scope = "publications:read"
	ScopePublicationsWrite Scope = "publications:write"
	ScopeBackupsRead       Scope = "backups:read"
	ScopeBackupsWrite      Scope = "backups:write"
)

var allScopes = map[Scope]bool{
	ScopeBookmarksRead: true, ScopeBookmarksWrite: true,
	ScopePublicationsRead: true, ScopePublicationsWrite: true,
	ScopeBackupsRead: true, ScopeBackupsWrite: true,
}

// SpaceAll is the space_scope value meaning "all current and future spaces".
const SpaceAll = "all"

// SecretPrefix marks an API token secret. Bearer credentials are typed by
// prefix, so a session, a device secret and an API token cannot be mistaken
// for one another.
const SecretPrefix = "pnt_"

// Store is the persistence contract required by the token service.
type Store interface {
	InsertToken(ctx context.Context, t Token, prefix, hash string) error
	ListByUser(ctx context.Context, userID canonical.UserID) ([]Token, error)
	Get(ctx context.Context, id string) (Token, error)
	Revoke(ctx context.Context, id string, at time.Time) error

	// GetByHash loads the token a secret belongs to. Implementations carry
	// the owning account into the lookup and return ErrTokenInvalid for a
	// secret whose owner may not be used right now: an API token is a
	// subset of its user's authority, so a disabled account has none.
	GetByHash(ctx context.Context, hash string) (Token, error)

	// TouchLastUsed stamps the credential's activity time.
	TouchLastUsed(ctx context.Context, id string, at time.Time) error
}

// Service implements API token management.
type Service struct {
	store Store
}

// NewService returns a token service.
func NewService(store Store) *Service { return &Service{store: store} }

// CreateParams carries a token creation request.
type CreateParams struct {
	Name       string
	Scopes     []string
	SpaceScope string // "all" or JSON array; empty means "all"
}

// Create mints a token and returns it with the one-time secret.
func (s *Service) Create(ctx context.Context, user canonical.UserID, p CreateParams) (Token, string, error) {
	if p.Name == "" {
		return Token{}, "", ErrNameRequired
	}
	if len(p.Scopes) == 0 {
		return Token{}, "", ErrInvalidScopes
	}
	for _, sc := range p.Scopes {
		if !allScopes[Scope(sc)] {
			return Token{}, "", ErrInvalidScopes
		}
	}
	spaceScope := p.SpaceScope
	if spaceScope == "" {
		spaceScope = SpaceAll
	}
	if spaceScope != SpaceAll {
		var ids []string
		if json.Unmarshal([]byte(spaceScope), &ids) != nil || len(ids) == 0 {
			return Token{}, "", ErrInvalidScopes
		}
	}

	id, err := uuid.NewV7()
	if err != nil {
		return Token{}, "", err
	}
	now := time.Now().UTC()
	t := Token{
		ID:         id.String(),
		UserID:     string(user),
		Name:       p.Name,
		Scopes:     p.Scopes,
		SpaceScope: spaceScope,
		CreatedAt:  now,
	}
	secret, prefix, hash, err := newTokenSecret()
	if err != nil {
		return Token{}, "", err
	}
	if err := s.store.InsertToken(ctx, t, prefix, hash); err != nil {
		return Token{}, "", err
	}
	return t, secret, nil
}

// SecretHash is the lookup key for a raw API token secret.
func SecretHash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// Principal is a resolved API token credential: who may act, and how far.
// It is deliberately not a session. A token can never reach the system
// admin API or the device replica protocol, whatever its user can do.
type Principal struct {
	TokenID  string
	UserID   canonical.UserID
	Scopes   map[Scope]bool
	spaceAll bool
	spaceIDs map[canonical.SpaceID]bool
}

// Allows reports whether the token carries one capability.
func (p Principal) Allows(sc Scope) bool { return p.Scopes[sc] }

// AllowsSpace reports whether the token may act on one space.
func (p Principal) AllowsSpace(space canonical.SpaceID) bool {
	return p.spaceAll || p.spaceIDs[space]
}

// Verify resolves a raw secret into a principal.
func (s *Service) Verify(ctx context.Context, secret string) (Principal, error) {
	if !strings.HasPrefix(secret, SecretPrefix) || len(secret) < 20 {
		return Principal{}, ErrTokenInvalid
	}
	t, err := s.store.GetByHash(ctx, SecretHash(secret))
	if err != nil {
		// Both a foreign secret and a refused account deny the same way:
		// neither says anything about what the caller might try next.
		return Principal{}, ErrTokenInvalid
	}
	if t.RevokedAt != nil {
		return Principal{}, ErrTokenInvalid
	}
	principal := Principal{
		TokenID:  t.ID,
		UserID:   canonical.UserID(t.UserID),
		Scopes:   map[Scope]bool{},
		spaceIDs: map[canonical.SpaceID]bool{},
	}
	for _, raw := range t.Scopes {
		if sc := Scope(raw); allScopes[sc] {
			principal.Scopes[sc] = true
		}
	}
	if t.SpaceScope == SpaceAll || t.SpaceScope == "" {
		principal.spaceAll = true
	} else {
		var ids []string
		// The shape was checked at creation; a row that no longer parses
		// grants nothing rather than everything.
		if json.Unmarshal([]byte(t.SpaceScope), &ids) == nil {
			for _, id := range ids {
				principal.spaceIDs[canonical.SpaceID(id)] = true
			}
		}
	}
	_ = s.store.TouchLastUsed(ctx, t.ID, time.Now().UTC())
	return principal, nil
}

// List returns the user's non-revoked tokens.
func (s *Service) List(ctx context.Context, user canonical.UserID) ([]Token, error) {
	all, err := s.store.ListByUser(ctx, user)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, t := range all {
		if t.RevokedAt == nil {
			out = append(out, t)
		}
	}
	return out, nil
}

// Revoke marks a token revoked. Only the owner may revoke it.
func (s *Service) Revoke(ctx context.Context, user canonical.UserID, id string) error {
	t, err := s.store.Get(ctx, id)
	if err != nil {
		return ErrTokenNotFound
	}
	if t.UserID != string(user) {
		return ErrTokenNotFound // resource ids are not capabilities
	}
	return s.store.Revoke(ctx, id, time.Now().UTC())
}

// newTokenSecret mirrors the device credential scheme with a pnt_ prefix.
func newTokenSecret() (token, prefix, hash string, err error) {
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return "", "", "", fmt.Errorf("token: read entropy: %w", err)
	}
	token = SecretPrefix + base64.RawURLEncoding.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, token[:12], hex.EncodeToString(sum[:]), nil
}
