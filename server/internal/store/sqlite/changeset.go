package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
)

// ChangeSetStore implements changeset.Store. The in-transaction methods
// downcast the caller's canonical.Tx (always *canonTx in this package) so
// ChangeSet rows commit atomically with the canonical mutation.
type ChangeSetStore struct {
	db *sql.DB
}

// NewChangeSetStore wraps an opened database as a changeset store.
func NewChangeSetStore(db *sql.DB) *ChangeSetStore { return &ChangeSetStore{db: db} }

// BeginTx starts a canonical transaction (undo execution scope).
func (s *ChangeSetStore) BeginTx(ctx context.Context) (canonical.Tx, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin changeset tx: %w", err)
	}
	return &canonTx{tx: tx}, nil
}

// raw exposes the underlying *sql.Tx; implemented on canonTx so wrapped
// transactions (e.g. *syncTxImpl embedding *canonTx) satisfy it too.
func (t *canonTx) raw() *sql.Tx { return t.tx }

// changesetTx unwraps the caller's transaction down to the raw *sql.Tx.
// Every canonical transaction in this package is (or wraps) a *canonTx.
func changesetTx(tx canonical.Tx) (*sql.Tx, error) {
	r, ok := tx.(interface{ raw() *sql.Tx })
	if !ok {
		return nil, fmt.Errorf("changeset: unexpected tx type %T", tx)
	}
	return r.raw(), nil
}

// InsertChangeSetTx persists one ChangeSet row inside the caller's
// transaction.
func (s *ChangeSetStore) InsertChangeSetTx(ctx context.Context, tx canonical.Tx, cs changeset.ChangeSet) error {
	rt, err := changesetTx(tx)
	if err != nil {
		return err
	}
	var actorUser, actorDevice, inverseOf any
	if cs.ActorUserID != "" {
		actorUser = string(cs.ActorUserID)
	}
	if cs.ActorDeviceID != "" {
		actorDevice = string(cs.ActorDeviceID)
	}
	if cs.InverseOf != "" {
		inverseOf = cs.InverseOf
	}
	var undoData any
	if cs.UndoDataJSON != "" {
		undoData = cs.UndoDataJSON
	}
	_, err = rt.ExecContext(ctx, `
		INSERT INTO changesets (
			id, space_id, epoch, kind, summary, origin_type,
			actor_user_id, actor_device_id, first_revision, last_revision,
			inverse_of, undo_data, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		cs.ID, string(cs.SpaceID), cs.Epoch, string(cs.Kind), cs.Summary, string(cs.OriginType),
		actorUser, actorDevice, cs.FirstRevision, cs.LastRevision,
		inverseOf, undoData, formatTime(cs.CreatedAt))
	return err
}

// ChangeSetJournalRangeTx returns the revision range and row count of the
// journal entries linked to one ChangeSet.
func (s *ChangeSetStore) ChangeSetJournalRangeTx(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, epoch int64, changeSetID string) (int64, int64, int64, error) {
	rt, err := changesetTx(tx)
	if err != nil {
		return 0, 0, 0, err
	}
	var first, last, count int64
	err = rt.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(MIN(revision), 0), COALESCE(MAX(revision), 0)
		FROM journal
		WHERE space_id = ? AND epoch = ? AND change_set_id = ?`,
		string(space), epoch, changeSetID).Scan(&count, &first, &last)
	return first, last, count, err
}

// MarkChangeSetUndoneTx flags a ChangeSet as undone inside the caller's
// transaction. undoneBy may be empty when the inverse produced no journal
// entries (nothing left to invert).
func (s *ChangeSetStore) MarkChangeSetUndoneTx(ctx context.Context, tx canonical.Tx, id, undoneBy string, at time.Time) error {
	rt, err := changesetTx(tx)
	if err != nil {
		return err
	}
	var by any
	if undoneBy != "" {
		by = undoneBy
	}
	_, err = rt.ExecContext(ctx, `
		UPDATE changesets
		SET undone_by_changeset = ?, undone_at = ?
		WHERE id = ?`, by, formatTime(at), id)
	return err
}

// DeleteTombstonesTx clears the deletion records of restored nodes.
func (s *ChangeSetStore) DeleteTombstonesTx(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, ids []canonical.NodeID) error {
	rt, err := changesetTx(tx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := rt.ExecContext(ctx, `
			DELETE FROM tombstones WHERE space_id = ? AND node_id = ?`,
			string(space), string(id)); err != nil {
			return err
		}
	}
	return nil
}

// EnsureRootSlotTx creates a root slot if missing (undo recovery fallback).
func (s *ChangeSetStore) EnsureRootSlotTx(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, key, displayName string) error {
	rt, err := changesetTx(tx)
	if err != nil {
		return err
	}
	_, err = rt.ExecContext(ctx, `
		INSERT OR IGNORE INTO root_slots (space_id, key, display_name, position, created_at)
		SELECT ?, ?, ?, COALESCE(MAX(position) + 1, 0), ?
		FROM root_slots WHERE space_id = ?`,
		string(space), key, displayName, formatTime(time.Now().UTC()), string(space))
	return err
}

const changeSetColumns = `
	SELECT id, space_id, epoch, kind, summary, origin_type,
	       COALESCE(actor_user_id, ''), COALESCE(actor_device_id, ''),
	       first_revision, last_revision,
	       COALESCE(inverse_of, ''), COALESCE(undo_data, ''),
	       COALESCE(undone_by_changeset, ''), COALESCE(undone_at, ''),
	       created_at
	FROM changesets`

func scanChangeSet(row interface{ Scan(dest ...any) error }) (changeset.ChangeSet, error) {
	var cs changeset.ChangeSet
	var createdAt string
	err := row.Scan(&cs.ID, &cs.SpaceID, &cs.Epoch, &cs.Kind, &cs.Summary, &cs.OriginType,
		&cs.ActorUserID, &cs.ActorDeviceID,
		&cs.FirstRevision, &cs.LastRevision,
		&cs.InverseOf, &cs.UndoDataJSON,
		&cs.UndoneByChangeSet, &cs.UndoneAt,
		&createdAt)
	if err != nil {
		return changeset.ChangeSet{}, err
	}
	cs.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return cs, nil
}

// GetChangeSet loads one ChangeSet by id.
func (s *ChangeSetStore) GetChangeSet(ctx context.Context, id string) (changeset.ChangeSet, bool, error) {
	cs, err := scanChangeSet(s.db.QueryRowContext(ctx, changeSetColumns+` WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return changeset.ChangeSet{}, false, nil
	}
	if err != nil {
		return changeset.ChangeSet{}, false, err
	}
	return cs, true, nil
}

// ListChangeSets returns the space's newest ChangeSets (current epoch
// first, then older epochs) ordered by descending last revision.
func (s *ChangeSetStore) ListChangeSets(ctx context.Context, space canonical.SpaceID, limit int) ([]changeset.ChangeSet, error) {
	rows, err := s.db.QueryContext(ctx, changeSetColumns+`
		WHERE space_id = ?
		ORDER BY last_revision DESC, created_at DESC
		LIMIT ?`, string(space), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []changeset.ChangeSet
	for rows.Next() {
		cs, err := scanChangeSet(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cs)
	}
	return out, rows.Err()
}
