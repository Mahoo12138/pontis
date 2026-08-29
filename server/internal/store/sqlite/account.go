package sqlite

import (
	"context"
	"database/sql"
	"time"

	"pontis/internal/auth"
	"pontis/internal/canonical"
)

// AccountStore covers profile, password and session lifecycle beyond the
// core auth flows, plus the system_settings key/value bag.
type AccountStore struct {
	db *sql.DB
}

// NewAccountStore returns an account store.
func NewAccountStore(db *sql.DB) *AccountStore { return &AccountStore{db: db} }

// UpdateProfile rewrites display name and email.
func (s *AccountStore) UpdateProfile(ctx context.Context, userID, displayName, email string, at time.Time) error {
	var emailNorm any
	if email != "" {
		emailNorm = auth.NormalizeEmail(email)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET display_name = ?, email = ?, email_normalized = ?, updated_at = ?
		WHERE id = ?`, displayName, email, emailNorm, formatTime(at), userID)
	return err
}

// UpdatePassword rewrites the password hash and bumps password_changed_at.
func (s *AccountStore) UpdatePassword(ctx context.Context, userID, hash string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ?
		WHERE id = ?`, hash, formatTime(at), formatTime(at), userID)
	return err
}

// DeleteUserSessionsExcept invalidates all of the user's sessions except
// keepSessionID (the browser that performed the password change).
func (s *AccountStore) DeleteUserSessionsExcept(ctx context.Context, userID, keepSessionID string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM sessions WHERE user_id = ? AND id <> ?`, userID, keepSessionID)
	return err
}

// GetPasswordHash returns the user's current argon2id encoding.
func (s *AccountStore) GetPasswordHash(ctx context.Context, userID string) (string, error) {
	var hash string
	err := s.db.QueryRowContext(ctx,
		`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash)
	if err == sql.ErrNoRows {
		return "", sql.ErrNoRows
	}
	return hash, err
}

// SettingsRow is one system_settings entry.
type SettingsRow struct {
	Key   string
	Value string
}

// ListSettings returns every system settings entry.
func (s *AccountStore) ListSettings(ctx context.Context) ([]SettingsRow, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM system_settings ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SettingsRow
	for rows.Next() {
		var r SettingsRow
		if err := rows.Scan(&r.Key, &r.Value); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertSettings writes the given settings keys.
func (s *AccountStore) UpsertSettings(ctx context.Context, kv map[string]string, at time.Time) error {
	for k, v := range kv {
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			k, v, formatTime(at)); err != nil {
			return err
		}
	}
	return nil
}

// DeviceBindingRow is one flat Device × Binding × Space row for the
// overview join.
type DeviceBindingRow struct {
	DeviceID         string
	DeviceName       string
	ClientType       string
	Browser          string
	Platform         string
	SyncMode         string
	CreatedAt        string
	LastSeenAt       *string
	RevokedAt        *string
	BindingID        string
	SpaceID          string
	SpaceName        string
	BindingState     string
	Epoch            int64
	SpaceEpoch       int64
	AppliedRevision  int64
	ServerRevision   int64
	LastSyncAt       *string
}

// ListOwnerDeviceBindings returns the owner's devices joined with their
// bindings and space names; devices without bindings appear with empty
// binding fields. Revoked devices are excluded.
func (s *AccountStore) ListOwnerDeviceBindings(ctx context.Context, owner canonical.UserID) ([]DeviceBindingRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT d.id, d.name, d.client_type, d.browser, d.platform,
		       COALESCE(d.sync_mode, ''), d.created_at, d.last_seen_at, d.revoked_at,
		       COALESCE(b.id, ''), COALESCE(b.space_id, ''), COALESCE(sp.name, ''),
		       COALESCE(b.state, ''), COALESCE(b.epoch, 0),
		       COALESCE(sp.epoch, 0), COALESCE(b.applied_revision, 0), COALESCE(sp.current_revision, 0),
		       b.last_sync_at
		FROM devices d
		LEFT JOIN device_space_bindings b ON b.device_id = d.id
		LEFT JOIN sync_spaces sp ON sp.id = b.space_id
		WHERE d.owner_user_id = ? AND d.revoked_at IS NULL
		ORDER BY d.created_at, d.id`, string(owner))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []DeviceBindingRow
	for rows.Next() {
		var r DeviceBindingRow
		var bindingID, spaceID, spaceName, bindingState, lastSyncAt any
		if err := rows.Scan(&r.DeviceID, &r.DeviceName, &r.ClientType, &r.Browser, &r.Platform,
			&r.SyncMode, &r.CreatedAt, &r.LastSeenAt, &r.RevokedAt,
			&bindingID, &spaceID, &spaceName, &bindingState, &r.Epoch,
			&r.SpaceEpoch, &r.AppliedRevision, &r.ServerRevision, &lastSyncAt); err != nil {
			return nil, err
		}
		if bindingID != nil {
			r.BindingID = bindingID.(string)
			r.SpaceID = spaceID.(string)
			r.SpaceName = spaceName.(string)
			r.BindingState = bindingState.(string)
		}
		if lastSyncAt != nil {
			v := lastSyncAt.(string)
			r.LastSyncAt = &v
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteOwnerDevice removes an owner's device. The caller must already have
// removed bindings/credentials (FK constraints are RESTRICT).
func (s *AccountStore) DeleteOwnerDevice(ctx context.Context, owner canonical.UserID, deviceID string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM devices WHERE id = ? AND owner_user_id = ?`, deviceID, string(owner))
	return err
}

// DeleteDeviceChildren removes a device's bindings and credentials.
func (s *AccountStore) DeleteDeviceChildren(ctx context.Context, deviceID string) error {
	for _, stmt := range []string{
		`DELETE FROM device_space_bindings WHERE device_id = ?`,
		`DELETE FROM device_credentials WHERE device_id = ?`,
	} {
		if _, err := s.db.ExecContext(ctx, stmt, deviceID); err != nil {
			return err
		}
	}
	return nil
}
