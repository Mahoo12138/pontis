package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"pontis/internal/auth"
)

// ResetPasswordTx consumes a reset token, writes the new password and drops the
// user's web sessions in one transaction.
//
// The three steps used to be separate calls from the service layer, which left
// two windows. Two requests that both read `used_at IS NULL` before either wrote
// would both be accepted against a single-use link; and a failure after the
// token was marked used burned the only link the user had, with the password
// still the old one. Here the guarded UPDATE decides whether this call won the
// token, and nothing commits unless all three writes land.
//
// It returns the user whose password changed, so the caller can log or audit it.
func (s *AccountStore) ResetPasswordTx(ctx context.Context, tokenHash, passwordHash string, at time.Time) (string, error) {
	return resetPasswordTx(ctx, s.db, tokenHash, passwordHash, at)
}

// ResetPasswordTx is the same transaction through the auth store, which the
// HTTP layer hands the service.
func (s *AuthStore) ResetPasswordTx(ctx context.Context, tokenHash, passwordHash string, at time.Time) (string, error) {
	return resetPasswordTx(ctx, s.db, tokenHash, passwordHash, at)
}

func resetPasswordTx(ctx context.Context, db *sql.DB, tokenHash, passwordHash string, at time.Time) (string, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback() //nolint:errcheck // after Commit it is a no-op

	var userID string
	var tokenID string
	err = tx.QueryRowContext(ctx, `
		SELECT id, user_id FROM password_reset_tokens
		WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
		tokenHash, formatTime(at)).Scan(&tokenID, &userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", auth.ErrResetTokenInvalid
	}
	if err != nil {
		return "", err
	}

	// The read above is only a lookup; this write is the decision. Rows
	// affected is 0 when another request consumed the token between them.
	res, err := tx.ExecContext(ctx,
		`UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
		formatTime(at), tokenID)
	if err != nil {
		return "", err
	}
	if won, err := res.RowsAffected(); err != nil {
		return "", err
	} else if won == 0 {
		return "", auth.ErrResetTokenInvalid
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ?
		WHERE id = ?`, passwordHash, formatTime(at), formatTime(at), userID); err != nil {
		return "", err
	}
	// A new password invalidates every existing web session (doc 09 §15). The
	// reset flow has no "keep this browser" case: nobody is logged in.
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID); err != nil {
		return "", err
	}

	if err := tx.Commit(); err != nil {
		return "", err
	}
	return userID, nil
}
