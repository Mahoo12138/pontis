package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"pontis/internal/canonical"
)

// ChangeSet persistence (doc 18 §7).

// InsertChangeSet stores one ChangeSet row.
func (t *canonTx) InsertChangeSet(ctx context.Context, cs canonical.ChangeSet) error {
	var userID, deviceID, inverseOf any
	if cs.ActorUserID != "" {
		userID = string(cs.ActorUserID)
	}
	if cs.ActorDeviceID != "" {
		deviceID = string(cs.ActorDeviceID)
	}
	if cs.InverseOf != "" {
		inverseOf = cs.InverseOf
	}
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO change_sets
			(id, space_id, actor_type, actor_user_id, actor_device_id, kind, summary,
			 first_revision, last_revision, inverse_of_change_set_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		cs.ID, string(cs.SpaceID), string(cs.ActorType), userID, deviceID,
		cs.Kind, cs.Summary, cs.FirstRevision, cs.LastRevision, inverseOf, formatTime(cs.CreatedAt))
	return err
}

// InsertUndoData stores the atomic before-image of a ChangeSet.
func (t *canonTx) InsertUndoData(ctx context.Context, data canonical.UndoData) error {
	var expiresAt any
	if !data.ExpiresAt.IsZero() {
		expiresAt = formatTime(data.ExpiresAt)
	}
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO change_set_undo_data (change_set_id, format_version, codec, payload, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		data.ChangeSetID, data.FormatVersion, data.Codec, data.Payload, expiresAt, formatTime(data.CreatedAt))
	return err
}

// UpdateUndoData rewrites a stored before-image (retention management).
func (t *canonTx) UpdateUndoData(ctx context.Context, data canonical.UndoData) error {
	var expiresAt any
	if !data.ExpiresAt.IsZero() {
		expiresAt = formatTime(data.ExpiresAt)
	}
	_, err := t.tx.ExecContext(ctx, `
		UPDATE change_set_undo_data SET format_version = ?, codec = ?, payload = ?, expires_at = ?
		WHERE change_set_id = ?`,
		data.FormatVersion, data.Codec, data.Payload, expiresAt, data.ChangeSetID)
	return err
}

// LoadChangeSet loads one ChangeSet of a space.
func (t *canonTx) LoadChangeSet(ctx context.Context, space canonical.SpaceID, id string) (canonical.ChangeSet, error) {
	return scanChangeSet(t.tx.QueryRowContext(ctx, changeSetColumns+` WHERE space_id = ? AND id = ?`, string(space), id))
}

// LoadUndoData loads the before-image of a ChangeSet.
func (t *canonTx) LoadUndoData(ctx context.Context, changeSetID string) (canonical.UndoData, bool, error) {
	var data canonical.UndoData
	var formatVersion int
	var codec string
	var payload []byte
	var expiresAt, createdAt sql.NullString
	err := t.tx.QueryRowContext(ctx, `
		SELECT change_set_id, format_version, codec, payload, expires_at, created_at
		FROM change_set_undo_data WHERE change_set_id = ?`, changeSetID).
		Scan(&data.ChangeSetID, &formatVersion, &codec, &payload, &expiresAt, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return canonical.UndoData{}, false, nil
	}
	if err != nil {
		return canonical.UndoData{}, false, err
	}
	data.FormatVersion = formatVersion
	data.Codec = codec
	data.Payload = payload
	if expiresAt.Valid {
		data.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expiresAt.String)
	}
	if createdAt.Valid {
		data.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt.String)
	}
	return data, true, nil
}

// ListChangeSets returns the newest ChangeSets of a space, newest
// first, and whether more remain.
func (t *canonTx) ListChangeSets(ctx context.Context, space canonical.SpaceID, limit int) ([]canonical.ChangeSet, bool, error) {
	rows, err := t.tx.QueryContext(ctx, changeSetColumns+`
		WHERE space_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, string(space), limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var out []canonical.ChangeSet
	for rows.Next() {
		cs, err := scanChangeSet(rows)
		if err != nil {
			return nil, false, err
		}
		out = append(out, cs)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(out) > limit
	if hasMore {
		out = out[:limit]
	}
	return out, hasMore, nil
}

const changeSetColumns = `
	SELECT id, space_id, actor_type, COALESCE(actor_user_id, ''), COALESCE(actor_device_id, ''),
	       kind, summary, first_revision, last_revision, COALESCE(inverse_of_change_set_id, ''), created_at
	FROM change_sets`

func scanChangeSet(row interface{ Scan(dest ...any) error }) (canonical.ChangeSet, error) {
	var cs canonical.ChangeSet
	var createdAt string
	err := row.Scan(&cs.ID, &cs.SpaceID, &cs.ActorType, &cs.ActorUserID, &cs.ActorDeviceID,
		&cs.Kind, &cs.Summary, &cs.FirstRevision, &cs.LastRevision, &cs.InverseOf, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return canonical.ChangeSet{}, canonical.ErrChangeSetNotFound
	}
	if err != nil {
		return canonical.ChangeSet{}, err
	}
	cs.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return cs, nil
}
