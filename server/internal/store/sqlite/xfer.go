package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/spacetransfer"
)

// --- cross-space transfer records (doc 18 §8) ---

// InsertTransferTx persists a completed transfer record inside the
// caller's canonical transaction (the sqlite implementation of Tx is
// always *canonTx) so the record commits atomically with the moved
// subtree.
func (s *Store) InsertTransferTx(ctx context.Context, tx canonical.Tx, t spacetransfer.TransferRecord) error {
	ct, ok := tx.(*canonTx)
	if !ok {
		return fmt.Errorf("insert transfer: unexpected tx type %T", tx)
	}
	var sourceBinding, targetBinding, sourceCS, targetCS, completedAt any
	if t.SourceBindingID != "" {
		sourceBinding = t.SourceBindingID
	}
	if t.TargetBindingID != "" {
		targetBinding = t.TargetBindingID
	}
	if t.SourceChangeSetID != "" {
		sourceCS = t.SourceChangeSetID
	}
	if t.TargetChangeSetID != "" {
		targetCS = t.TargetChangeSetID
	}
	if t.CompletedAt != nil {
		completedAt = formatTime(*t.CompletedAt)
	}
	_, err := ct.tx.ExecContext(ctx, `
		INSERT INTO cross_space_transfers (
			id, owner_user_id, source_space_id, target_space_id,
			source_binding_id, target_binding_id, state, request_hash,
			mapping_json, source_change_set_id, target_change_set_id,
			created_at, completed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, string(t.OwnerUserID), string(t.SourceSpaceID), string(t.TargetSpaceID),
		sourceBinding, targetBinding, t.State, t.RequestHash,
		t.MappingJSON, sourceCS, targetCS,
		formatTime(t.CreatedAt), completedAt,
	)
	if err != nil {
		return fmt.Errorf("insert transfer: %w", err)
	}
	return nil
}

// GetTransfer loads a transfer by id; returns the zero record (with an
// empty ID) when absent.
func (s *Store) GetTransfer(ctx context.Context, id string) (spacetransfer.TransferRecord, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT owner_user_id, source_space_id, target_space_id,
		       source_binding_id, target_binding_id, state, request_hash,
		       mapping_json, source_change_set_id, target_change_set_id,
		       created_at, completed_at
		FROM cross_space_transfers
		WHERE id = ?`, id)
	var (
		t                            spacetransfer.TransferRecord
		owner, src, tgt              string
		sourceBinding, targetBinding sql.NullString
		state, hash, mapping         string
		sourceCS, targetCS           sql.NullString
		createdAt, completedAt       sql.NullString
	)
	if err := row.Scan(&owner, &src, &tgt, &sourceBinding, &targetBinding,
		&state, &hash, &mapping, &sourceCS, &targetCS, &createdAt, &completedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return spacetransfer.TransferRecord{}, nil
		}
		return spacetransfer.TransferRecord{}, fmt.Errorf("get transfer: %w", err)
	}
	t = spacetransfer.TransferRecord{
		ID:                id,
		OwnerUserID:       canonical.UserID(owner),
		SourceSpaceID:     canonical.SpaceID(src),
		TargetSpaceID:     canonical.SpaceID(tgt),
		SourceBindingID:   sourceBinding.String,
		TargetBindingID:   targetBinding.String,
		State:             state,
		RequestHash:       hash,
		MappingJSON:       mapping,
		SourceChangeSetID: sourceCS.String,
		TargetChangeSetID: targetCS.String,
	}
	if createdAt.Valid {
		if ts, err := time.Parse(time.RFC3339Nano, createdAt.String); err == nil {
			t.CreatedAt = ts
		}
	}
	if completedAt.Valid {
		if ts, err := time.Parse(time.RFC3339Nano, completedAt.String); err == nil {
			t.CompletedAt = &ts
		}
	}
	return t, nil
}
