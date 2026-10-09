package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"pontis/internal/auth"
	"pontis/internal/canonical"
	"pontis/internal/token"
)

// TokenStore persists API tokens and their hashed secrets.
type TokenStore struct {
	db *sql.DB
}

// NewTokenStore returns a token store.
func NewTokenStore(db *sql.DB) *TokenStore { return &TokenStore{db: db} }

// InsertToken writes the token and its hashed secret.
func (s *TokenStore) InsertToken(ctx context.Context, t token.Token, prefix, hash string) error {
	scopes, err := json.Marshal(t.Scopes)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO api_tokens (id, user_id, name, scopes, space_scope, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		t.ID, t.UserID, t.Name, string(scopes), t.SpaceScope, formatTime(t.CreatedAt)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO api_token_secrets (token_id, token_prefix, token_hash, created_at)
		VALUES (?, ?, ?, ?)`, t.ID, prefix, hash, formatTime(t.CreatedAt)); err != nil {
		return err
	}
	return tx.Commit()
}

// GetByHash loads the token a secret belongs to, together with the state of
// the owning account. A disabled account has no authority for its token to
// be a subset of, so the credential is refused here rather than upstream.
func (s *TokenStore) GetByHash(ctx context.Context, hash string) (token.Token, error) {
	const cols = `
		SELECT t.id, t.user_id, t.name, t.scopes, t.space_scope, t.created_at,
		       t.last_used_at, t.revoked_at, u.status`
	var t token.Token
	var scopes, spaceScope, createdAt, ownerStatus string
	var lastUsed, revoked sql.NullString
	err := s.db.QueryRowContext(ctx, cols+`
		FROM api_tokens t
		JOIN api_token_secrets sec ON sec.token_id = t.id
		JOIN users u ON u.id = t.user_id
		WHERE sec.token_hash = ?`, hash).
		Scan(&t.ID, &t.UserID, &t.Name, &scopes, &spaceScope, &createdAt,
			&lastUsed, &revoked, &ownerStatus)
	if errors.Is(err, sql.ErrNoRows) {
		return token.Token{}, token.ErrTokenInvalid
	}
	if err != nil {
		return token.Token{}, err
	}
	if ownerStatus != string(auth.StatusActive) {
		return token.Token{}, token.ErrTokenInvalid
	}
	if err := fillToken(&t, scopes, spaceScope, createdAt, lastUsed, revoked); err != nil {
		return token.Token{}, err
	}
	return t, nil
}

// TouchLastUsed stamps the credential's activity time.
func (s *TokenStore) TouchLastUsed(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, formatTime(at), id)
	return err
}

func fillToken(t *token.Token, scopes, spaceScope, createdAt string, lastUsed, revoked sql.NullString) error {
	if err := json.Unmarshal([]byte(scopes), &t.Scopes); err != nil {
		return fmt.Errorf("token: bad scope row %s: %w", t.ID, err)
	}
	t.SpaceScope = spaceScope
	t.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	if lastUsed.Valid {
		v, err := time.Parse(time.RFC3339Nano, lastUsed.String)
		if err != nil {
			return fmt.Errorf("token: bad last_used_at on %s: %w", t.ID, err)
		}
		t.LastUsedAt = &v
	}
	if revoked.Valid {
		v, err := time.Parse(time.RFC3339Nano, revoked.String)
		if err != nil {
			return fmt.Errorf("token: bad revoked_at on %s: %w", t.ID, err)
		}
		t.RevokedAt = &v
	}
	return nil
}

func scanToken(row interface{ Scan(dest ...any) error }) (token.Token, error) {
	var t token.Token
	var scopes, spaceScope, createdAt string
	var lastUsed, revoked sql.NullString
	if err := row.Scan(&t.ID, &t.UserID, &t.Name, &scopes, &spaceScope, &createdAt, &lastUsed, &revoked); err != nil {
		return t, err
	}
	if err := fillToken(&t, scopes, spaceScope, createdAt, lastUsed, revoked); err != nil {
		return token.Token{}, err
	}
	return t, nil
}

// ListByUser returns the user's tokens ordered by creation.
func (s *TokenStore) ListByUser(ctx context.Context, user canonical.UserID) ([]token.Token, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, name, scopes, space_scope, created_at, last_used_at, revoked_at
		FROM api_tokens WHERE user_id = ? ORDER BY created_at, id`, string(user))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []token.Token
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// Get loads one token.
func (s *TokenStore) Get(ctx context.Context, id string) (token.Token, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, name, scopes, space_scope, created_at, last_used_at, revoked_at
		FROM api_tokens WHERE id = ?`, id)
	t, err := scanToken(row)
	if err == sql.ErrNoRows {
		return t, token.ErrTokenNotFound
	}
	return t, err
}

// Revoke marks a token revoked.
func (s *TokenStore) Revoke(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE api_tokens SET revoked_at = ? WHERE id = ?`, formatTime(at), id)
	return err
}
