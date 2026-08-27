package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/device"
	"pontis/internal/sync"
)

// SyncStore implements sync.Store.
type SyncStore struct {
	db      *sql.DB
	devices *DeviceStore
}

// NewSyncStore wraps an opened database as a sync store.
func NewSyncStore(db *sql.DB) *SyncStore {
	return &SyncStore{db: db, devices: NewDeviceStore(db)}
}

// BeginTx starts a sync round transaction.
func (s *SyncStore) BeginTx(ctx context.Context) (sync.Tx, error) {
	sqlTx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	return &syncTxImpl{canonTx: &canonTx{tx: sqlTx}}, nil
}

// LoadBinding loads the device-space binding.
func (s *SyncStore) LoadBinding(ctx context.Context, deviceID canonical.DeviceID, space canonical.SpaceID) (device.Binding, error) {
	return s.devices.GetBinding(ctx, string(deviceID), space)
}

// LoadSpace loads a sync space.
func (s *SyncStore) LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	return scanSpace(s.db.QueryRowContext(ctx, spaceColumns, string(id)))
}

// LoadJournalChanges returns journal rows of one epoch ordered by revision.
func (s *SyncStore) LoadJournalChanges(ctx context.Context, space canonical.SpaceID, epoch, fromRevision int64, limit int) ([]sync.JournalChange, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT revision, change_type, COALESCE(node_id, ''), payload
		FROM journal
		WHERE space_id = ? AND epoch = ? AND revision >= ?
		ORDER BY revision
		LIMIT ?`,
		string(space), epoch, fromRevision, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var changes []sync.JournalChange
	for rows.Next() {
		var c sync.JournalChange
		if err := rows.Scan(&c.Revision, &c.Type, &c.NodeID, &c.PayloadJSON); err != nil {
			return nil, err
		}
		changes = append(changes, c)
	}
	return changes, rows.Err()
}

// UpdateBindingSync persists the binding watermarks.
func (s *SyncStore) UpdateBindingSync(ctx context.Context, bindingID string, appliedRevision, receivedRevision, maxClientSeq int64, lastSyncAt time.Time) error {
	return s.devices.UpdateBindingSync(ctx, bindingID, appliedRevision, receivedRevision, maxClientSeq, lastSyncAt)
}

// syncTxImpl implements sync.Tx by extending the canonical transaction.
type syncTxImpl struct {
	*canonTx
}

// LoadTombstone reads the deletion record of a node, if any.
func (t *syncTxImpl) LoadTombstone(ctx context.Context, space canonical.SpaceID, node canonical.NodeID) (sync.Tombstone, bool, error) {
	var tomb sync.Tombstone
	err := t.canonTx.tx.QueryRowContext(ctx, `
		SELECT deleted_epoch, deleted_revision
		FROM tombstones WHERE space_id = ? AND node_id = ?`,
		string(space), string(node)).Scan(&tomb.Epoch, &tomb.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return sync.Tombstone{}, false, nil
	}
	if err != nil {
		return sync.Tombstone{}, false, err
	}
	return tomb, true, nil
}

// LoadReceipt reads an operation receipt by op_id.
func (t *syncTxImpl) LoadReceipt(ctx context.Context, bindingID, opID string) (sync.Receipt, bool, error) {
	var r sync.Receipt
	var status, createdAt string
	var resultRev, settleRev sql.NullInt64
	err := t.canonTx.tx.QueryRowContext(ctx, `
		SELECT binding_id, op_id, client_seq, request_epoch, base_revision, request_hash,
		       status, reason, result_revision, settle_after_revision, processed_at_revision, created_at
		FROM client_operation_receipts
		WHERE binding_id = ? AND op_id = ?`, bindingID, opID).
		Scan(&r.BindingID, &r.OpID, &r.ClientSeq, &r.RequestEpoch, &r.BaseRevision, &r.RequestHash,
			&status, &r.Reason, &resultRev, &settleRev, &r.ProcessedAtRevision, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return sync.Receipt{}, false, nil
	}
	if err != nil {
		return sync.Receipt{}, false, err
	}
	r.Status = sync.OpStatus(status)
	r.ResultRevision = resultRev.Int64
	r.SettleAfterRevision = settleRev.Int64
	r.CreatedAt = createdAt
	return r, true, nil
}

// InsertReceipt records the idempotency result of a processed operation.
func (t *syncTxImpl) InsertReceipt(ctx context.Context, r sync.Receipt) error {
	var resultRev, settleRev any
	if r.ResultRevision > 0 {
		resultRev = r.ResultRevision
	}
	if r.SettleAfterRevision > 0 {
		settleRev = r.SettleAfterRevision
	}
	_, err := t.canonTx.tx.ExecContext(ctx, `
		INSERT INTO client_operation_receipts
			(binding_id, op_id, client_seq, request_epoch, base_revision, request_hash,
			 status, reason, result_revision, settle_after_revision, processed_at_revision, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.BindingID, r.OpID, r.ClientSeq, r.RequestEpoch, r.BaseRevision, r.RequestHash,
		string(r.Status), r.Reason, resultRev, settleRev, r.ProcessedAtRevision, r.CreatedAt)
	return err
}

// EnsureRootSlot creates the root slot if it does not exist yet.
func (t *syncTxImpl) EnsureRootSlot(ctx context.Context, space canonical.SpaceID, key, displayName string) error {
	_, err := t.canonTx.tx.ExecContext(ctx, `
		INSERT INTO root_slots (space_id, key, display_name, position, created_at)
		SELECT ?, ?, ?, COALESCE(MAX(position) + 1, 0), ?
		FROM root_slots WHERE space_id = ?`,
		string(space), key, displayName, formatTime(time.Now().UTC()), string(space))
	return err
}

// LoadJournalOrigin returns the origin binding and client seq of the
// journal entry at (epoch, revision).
func (t *syncTxImpl) LoadJournalOrigin(ctx context.Context, space canonical.SpaceID, epoch, revision int64) (string, *int64, bool, error) {
	var bindingID string
	var clientSeq sql.NullInt64
	err := t.canonTx.tx.QueryRowContext(ctx, `
		SELECT origin_binding_id, origin_client_seq
		FROM journal WHERE space_id = ? AND epoch = ? AND revision = ?`,
		string(space), epoch, revision).Scan(&bindingID, &clientSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, false, nil
	}
	if err != nil {
		return "", nil, false, err
	}
	if clientSeq.Valid {
		return bindingID, &clientSeq.Int64, true, nil
	}
	return bindingID, nil, true, nil
}
