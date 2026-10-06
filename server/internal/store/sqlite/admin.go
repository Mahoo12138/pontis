package sqlite

import (
	"context"
	"database/sql"
	"time"

	"github.com/google/uuid"

	"pontis/internal/auth"
)

// AdminUserRow is one account row for the admin listing.
type AdminUserRow struct {
	ID          string
	Username    string
	DisplayName string
	Email       string
	Role        string
	Status      string
	SpaceCount  int64
	CreatedAt   string
	LastSeenAt  *string
}

// ListUsersWithStats returns all accounts with their space count and the
// most recent session activity.
func (s *AccountStore) ListUsersWithStats(ctx context.Context) ([]AdminUserRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.username, u.display_name, COALESCE(u.email, ''), u.role, u.status,
		       (SELECT COUNT(*) FROM sync_spaces sp WHERE sp.owner_user_id = u.id),
		       u.created_at,
		       (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id)
		FROM users u
		ORDER BY u.created_at, u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminUserRow
	for rows.Next() {
		var r AdminUserRow
		if err := rows.Scan(&r.ID, &r.Username, &r.DisplayName, &r.Email, &r.Role, &r.Status,
			&r.SpaceCount, &r.CreatedAt, &r.LastSeenAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetUserStatus enables or disables an account.
func (s *AccountStore) SetUserStatus(ctx context.Context, userID, status string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`, status, formatTime(at), userID)
	return err
}

// SetUserRole promotes or demotes an account.
func (s *AccountStore) SetUserRole(ctx context.Context, userID, role string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, role, formatTime(at), userID)
	return err
}

// InsertResetToken stores a hashed single-use reset token.
func (s *AccountStore) InsertResetToken(ctx context.Context, userID, hash string, expiresAt, at time.Time) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?)`, id, userID, hash, formatTime(expiresAt), formatTime(at))
	return err
}

// ConsumeResetToken validates a raw reset token and marks it used,
// returning the owning user id. Expired or already-used tokens fail.
func (s *AccountStore) ConsumeResetToken(ctx context.Context, hash string) (string, error) {
	var userID string
	var id string
	var expiresAt string
	var usedAt *string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
		hash).Scan(&id, &userID, &expiresAt, &usedAt)
	if err == sql.ErrNoRows {
		return "", auth.ErrResetTokenInvalid
	}
	if err != nil {
		return "", err
	}
	if usedAt != nil {
		return "", auth.ErrResetTokenInvalid
	}
	exp, _ := time.Parse(time.RFC3339Nano, expiresAt)
	if time.Now().UTC().After(exp) {
		return "", auth.ErrResetTokenInvalid
	}
	if _, err := s.db.ExecContext(ctx,
		`UPDATE password_reset_tokens SET used_at = ? WHERE id = ?`, formatTime(time.Now().UTC()), id); err != nil {
		return "", err
	}
	return userID, nil
}

// --- AuthStore reset/password support (ResetStore + PasswordChanger) ---

// InsertResetToken stores a hashed single-use reset token.
func (s *AuthStore) InsertResetToken(ctx context.Context, userID, hash string, expiresAt, at time.Time) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?)`, id.String(), userID, hash, formatTime(expiresAt), formatTime(at))
	return err
}

// ConsumeResetToken validates a raw reset token and marks it used.
func (s *AuthStore) ConsumeResetToken(ctx context.Context, hash string) (string, error) {
	var userID string
	var id string
	var expiresAt string
	var usedAt *string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
		hash).Scan(&id, &userID, &expiresAt, &usedAt)
	if err == sql.ErrNoRows {
		return "", auth.ErrResetTokenInvalid
	}
	if err != nil {
		return "", err
	}
	if usedAt != nil {
		return "", auth.ErrResetTokenInvalid
	}
	exp, _ := time.Parse(time.RFC3339Nano, expiresAt)
	if time.Now().UTC().After(exp) {
		return "", auth.ErrResetTokenInvalid
	}
	if _, err := s.db.ExecContext(ctx,
		`UPDATE password_reset_tokens SET used_at = ? WHERE id = ?`, formatTime(time.Now().UTC()), id); err != nil {
		return "", err
	}
	return userID, nil
}

// UpdatePassword rewrites the password hash.
func (s *AuthStore) UpdatePassword(ctx context.Context, userID, hash string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ?
		WHERE id = ?`, hash, formatTime(at), formatTime(at), userID)
	return err
}

// DeleteUserSessions invalidates every session of the user.
func (s *AccountStore) DeleteUserSessions(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
	return err
}

// PurgeExpiredResetTokens removes consumed and expired reset tokens.
func (s *AccountStore) PurgeExpiredResetTokens(ctx context.Context, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM password_reset_tokens
		WHERE used_at IS NOT NULL OR expires_at < ?`, formatTime(at))
	return err
}

// UserName returns the account's display name, empty when unknown.
func (s *AccountStore) UserName(ctx context.Context, id string) (string, error) {
	if id == "" {
		return "", nil
	}
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT display_name FROM users WHERE id = ?`, id).Scan(&name)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return name, err
}
