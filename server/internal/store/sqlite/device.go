package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/device"
)

// DeviceStore implements device.Store.
type DeviceStore struct {
	db *sql.DB
}

// NewDeviceStore wraps an opened database as a device store.
func NewDeviceStore(db *sql.DB) *DeviceStore { return &DeviceStore{db: db} }

// InsertDevice stores a device and its initial credential atomically.
func (s *DeviceStore) InsertDevice(ctx context.Context, d device.Device, cred device.Credential) error {
	credID, err := uuid.NewV7()
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO devices (id, owner_user_id, name, client_type, browser, platform, sync_mode, created_at)
		VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
		d.ID, string(d.OwnerUserID), d.Name, d.ClientType, d.Browser, d.Platform,
		formatTime(d.CreatedAt)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO device_credentials (id, device_id, token_prefix, token_hash, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		credID.String(), d.ID, cred.TokenPrefix, cred.TokenHash, formatTime(cred.CreatedAt)); err != nil {
		return err
	}
	return tx.Commit()
}

const deviceColumns = `
	SELECT d.id, d.owner_user_id, d.name, d.client_type, d.browser, d.platform,
	       COALESCE(d.sync_mode, ''), d.created_at, d.last_seen_at, d.revoked_at`

func scanDevice(row interface{ Scan(dest ...any) error }) (device.Device, error) {
	var d device.Device
	var mode, createdAt string
	var lastSeen, revoked sql.NullString
	err := row.Scan(&d.ID, &d.OwnerUserID, &d.Name, &d.ClientType, &d.Browser, &d.Platform,
		&mode, &createdAt, &lastSeen, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return device.Device{}, device.ErrDeviceNotFound
	}
	if err != nil {
		return device.Device{}, err
	}
	d.SyncMode = device.SyncMode(mode)
	d.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	if lastSeen.Valid {
		d.LastSeenAt, _ = time.Parse(time.RFC3339Nano, lastSeen.String)
	}
	if revoked.Valid {
		d.RevokedAt, _ = time.Parse(time.RFC3339Nano, revoked.String)
	}
	return d, nil
}

// GetDevice loads a device by id.
func (s *DeviceStore) GetDevice(ctx context.Context, id string) (device.Device, error) {
	return scanDevice(s.db.QueryRowContext(ctx, deviceColumns+` FROM devices d WHERE d.id = ?`, id))
}

// GetCredentialByTokenHash loads a credential with its device.
func (s *DeviceStore) GetCredentialByTokenHash(ctx context.Context, tokenHash string) (device.Credential, device.Device, error) {
	var cred device.Credential
	var createdAt string
	var lastUsed, revoked sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT c.id, c.device_id, c.token_prefix, c.token_hash, c.created_at, c.last_used_at, c.revoked_at
		FROM device_credentials c WHERE c.token_hash = ?`, tokenHash).
		Scan(&cred.ID, &cred.DeviceID, &cred.TokenPrefix, &cred.TokenHash, &createdAt, &lastUsed, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return device.Credential{}, device.Device{}, device.ErrCredentialInvalid
	}
	if err != nil {
		return device.Credential{}, device.Device{}, err
	}
	cred.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	if lastUsed.Valid {
		cred.LastUsedAt, _ = time.Parse(time.RFC3339Nano, lastUsed.String)
	}
	if revoked.Valid {
		cred.RevokedAt, _ = time.Parse(time.RFC3339Nano, revoked.String)
	}

	dev, err := s.GetDevice(ctx, cred.DeviceID)
	if err != nil {
		return device.Credential{}, device.Device{}, err
	}
	return cred, dev, nil
}

// TouchCredential updates credential last_used_at.
func (s *DeviceStore) TouchCredential(ctx context.Context, credID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE device_credentials SET last_used_at = ? WHERE id = ?`, formatTime(at), credID)
	return err
}

// RevokeDevice marks the device and all its credentials revoked.
func (s *DeviceStore) RevokeDevice(ctx context.Context, deviceID string, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`UPDATE devices SET revoked_at = ? WHERE id = ?`, formatTime(at), deviceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE device_credentials SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL`,
		formatTime(at), deviceID); err != nil {
		return err
	}
	return tx.Commit()
}

// CountBindings returns the number of bindings of a device.
func (s *DeviceStore) CountBindings(ctx context.Context, deviceID string) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM device_space_bindings WHERE device_id = ?`, deviceID).Scan(&n)
	return n, err
}

// SetDeviceSyncMode records the device sync mode.
func (s *DeviceStore) SetDeviceSyncMode(ctx context.Context, deviceID string, mode device.SyncMode) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE devices SET sync_mode = ? WHERE id = ?`, string(mode), deviceID)
	return err
}

// InsertBinding creates a binding after verifying the space exists and is
// owned by the device owner. The space epoch is copied onto the binding.
func (s *DeviceStore) InsertBinding(ctx context.Context, b device.Binding) error {
	var spaceOwner canonical.UserID
	var epoch int64
	err := s.db.QueryRowContext(ctx,
		`SELECT owner_user_id, epoch FROM sync_spaces WHERE id = ?`, string(b.SpaceID)).
		Scan(&spaceOwner, &epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return device.ErrSpaceNotFound
	}
	if err != nil {
		return err
	}

	dev, err := s.GetDevice(ctx, b.DeviceID)
	if err != nil {
		return err
	}
	if spaceOwner != dev.OwnerUserID {
		return device.ErrNotSpaceOwner
	}

	var exists bool
	if err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM device_space_bindings WHERE device_id = ? AND space_id = ?)`,
		b.DeviceID, string(b.SpaceID)).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return device.ErrBindingExists
	}

	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO device_space_bindings
			(id, device_id, space_id, state, epoch, applied_revision, received_revision, max_client_seq, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
		id.String(), b.DeviceID, string(b.SpaceID), string(b.State), epoch,
		formatTime(b.CreatedAt), formatTime(b.UpdatedAt))
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return device.ErrBindingExists
	}
	return err
}

// GetBinding loads the binding of a device for a space.
func (s *DeviceStore) GetBinding(ctx context.Context, deviceID string, space canonical.SpaceID) (device.Binding, error) {
	var b device.Binding
	var state string
	var initialized, lastSync sql.NullString
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, device_id, space_id, state, epoch, applied_revision, received_revision,
		       max_client_seq, initialized_at, last_sync_at, created_at, updated_at
		FROM device_space_bindings WHERE device_id = ? AND space_id = ?`,
		deviceID, string(space)).
		Scan(&b.ID, &b.DeviceID, &b.SpaceID, &state, &b.Epoch, &b.AppliedRevision, &b.ReceivedRevision,
			&b.MaxClientSeq, &initialized, &lastSync, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return device.Binding{}, device.ErrBindingNotFound
	}
	if err != nil {
		return device.Binding{}, err
	}
	b.State = device.BindingState(state)
	if initialized.Valid {
		b.InitializedAt, _ = time.Parse(time.RFC3339Nano, initialized.String)
	}
	if lastSync.Valid {
		b.LastSyncAt, _ = time.Parse(time.RFC3339Nano, lastSync.String)
	}
	b.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	b.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	return b, nil
}

// GetBindingByID loads a binding by its id.
func (s *DeviceStore) GetBindingByID(ctx context.Context, bindingID string) (device.Binding, error) {
	var b device.Binding
	var state string
	var initialized, lastSync sql.NullString
	var createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, device_id, space_id, state, epoch, applied_revision, received_revision,
		       max_client_seq, initialized_at, last_sync_at, created_at, updated_at
		FROM device_space_bindings WHERE id = ?`, bindingID).
		Scan(&b.ID, &b.DeviceID, &b.SpaceID, &state, &b.Epoch, &b.AppliedRevision, &b.ReceivedRevision,
			&b.MaxClientSeq, &initialized, &lastSync, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return device.Binding{}, device.ErrBindingNotFound
	}
	if err != nil {
		return device.Binding{}, err
	}
	b.State = device.BindingState(state)
	if initialized.Valid {
		b.InitializedAt, _ = time.Parse(time.RFC3339Nano, initialized.String)
	}
	if lastSync.Valid {
		b.LastSyncAt, _ = time.Parse(time.RFC3339Nano, lastSync.String)
	}
	b.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	b.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	return b, nil
}

// ListBindingsByDevice returns all bindings of a device.
func (s *DeviceStore) ListBindingsByDevice(ctx context.Context, deviceID string) ([]device.Binding, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, device_id, space_id, state, epoch, applied_revision, received_revision,
		       max_client_seq, initialized_at, last_sync_at, created_at, updated_at
		FROM device_space_bindings WHERE device_id = ? ORDER BY created_at`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []device.Binding
	for rows.Next() {
		var b device.Binding
		var state string
		var initialized, lastSync sql.NullString
		var createdAt, updatedAt string
		if err := rows.Scan(&b.ID, &b.DeviceID, &b.SpaceID, &state, &b.Epoch, &b.AppliedRevision, &b.ReceivedRevision,
			&b.MaxClientSeq, &initialized, &lastSync, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		b.State = device.BindingState(state)
		if initialized.Valid {
			b.InitializedAt, _ = time.Parse(time.RFC3339Nano, initialized.String)
		}
		if lastSync.Valid {
			b.LastSyncAt, _ = time.Parse(time.RFC3339Nano, lastSync.String)
		}
		b.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		b.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
		out = append(out, b)
	}
	return out, rows.Err()
}

// ActivateBinding moves a pending binding to active.
func (s *DeviceStore) ActivateBinding(ctx context.Context, bindingID string, at time.Time) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE device_space_bindings
		SET state = 'active', initialized_at = ?, updated_at = ?
		WHERE id = ?`, formatTime(at), formatTime(at), bindingID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return device.ErrBindingNotFound
	}
	return nil
}

// UpdateBindingSync advances the binding watermarks.
func (s *DeviceStore) UpdateBindingSync(ctx context.Context, bindingID string, appliedRevision, receivedRevision, maxClientSeq int64, lastSyncAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE device_space_bindings
		SET applied_revision = ?, received_revision = ?, max_client_seq = ?, last_sync_at = ?, updated_at = ?
		WHERE id = ?`,
		appliedRevision, receivedRevision, maxClientSeq, formatTime(lastSyncAt), formatTime(lastSyncAt), bindingID)
	return err
}
