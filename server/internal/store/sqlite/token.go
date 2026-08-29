package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

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

func scanToken(row interface{ Scan(dest ...any) error }) (token.Token, error) {
	var t token.Token
	var scopes, spaceScope, createdAt string
	var lastUsed, revoked *string
	if err := row.Scan(&t.ID, &t.UserID, &t.Name, &scopes, &spaceScope, &createdAt, &lastUsed, &revoked); err != nil {
		return t, err
	}
	_ = json.Unmarshal([]byte(scopes), &t.Scopes)
	t.SpaceScope = spaceScope
	t.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	if lastUsed != nil {
		v, _ := time.Parse(time.RFC3339Nano, *lastUsed)
		t.LastUsedAt = &v
	}
	if revoked != nil {
		v, _ := time.Parse(time.RFC3339Nano, *revoked)
		t.RevokedAt = &v
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
