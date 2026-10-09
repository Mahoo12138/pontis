package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/device"
	"pontis/internal/reconcile"
)

// ReconcileStore implements reconcile.Store on top of SQLite.
type ReconcileStore struct {
	db      *sql.DB
	devices *DeviceStore
}

// NewReconcileStore wraps an opened database as a reconciliation store.
func NewReconcileStore(db *sql.DB) *ReconcileStore {
	return &ReconcileStore{db: db, devices: NewDeviceStore(db)}
}

// BeginTx starts a reconciliation transaction: canonical plan execution,
// session updates and binding finalization share one atomic unit.
func (s *ReconcileStore) BeginTx(ctx context.Context) (reconcile.Tx, error) {
	sqlTx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin reconcile tx: %w", err)
	}
	return &reconcileTx{canonTx: &canonTx{tx: sqlTx}}, nil
}

// --- sessions ---

const sessionColumns = `
	SELECT id, binding_id, space_id, type, reason, state, phase,
	       source_epoch, source_revision, target_epoch, target_revision,
	       client_snapshot_artifact_id, server_snapshot_artifact_id,
	       plan_artifact_id, steps_artifact_id, plan_hash,
	       server_committed, commit_revision, created_at, updated_at, completed_at
	FROM reconciliations`

func scanSession(row interface{ Scan(dest ...any) error }) (reconcile.Session, error) {
	var s reconcile.Session
	var targetEpoch, targetRevision, commitRevision sql.NullInt64
	var clientArt, serverArt, planArt, stepsArt, planHash sql.NullString
	var serverCommitted int
	var createdAt, updatedAt string
	var completedAt sql.NullString
	err := row.Scan(&s.ID, &s.BindingID, &s.SpaceID, &s.Type, &s.Reason, &s.State, &s.Phase,
		&s.SourceEpoch, &s.SourceRevision, &targetEpoch, &targetRevision,
		&clientArt, &serverArt, &planArt, &stepsArt, &planHash,
		&serverCommitted, &commitRevision, &createdAt, &updatedAt, &completedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return reconcile.Session{}, reconcile.ErrSessionNotFound
	}
	if err != nil {
		return reconcile.Session{}, err
	}
	s.TargetEpoch = targetEpoch.Int64
	s.TargetRevision = targetRevision.Int64
	s.CommitRevision = commitRevision.Int64
	s.ClientSnapshotArtifact = clientArt.String
	s.ServerSnapshotArtifact = serverArt.String
	s.PlanArtifact = planArt.String
	s.StepsArtifact = stepsArt.String
	s.PlanHash = planHash.String
	s.ServerCommitted = serverCommitted == 1
	s.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	s.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	if completedAt.Valid {
		s.CompletedAt, _ = time.Parse(time.RFC3339Nano, completedAt.String)
	}
	return s, nil
}

// InsertSession creates the session row. The partial unique index on
// active sessions is the concurrency safety net behind the service
// check.
func (s *ReconcileStore) InsertSession(ctx context.Context, sess reconcile.Session) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO reconciliations
			(id, binding_id, space_id, type, reason, state, phase,
			 source_epoch, source_revision, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, sess.BindingID, string(sess.SpaceID), string(sess.Type), sess.Reason,
		string(sess.State), sess.Phase, sess.SourceEpoch, sess.SourceRevision,
		formatTime(sess.CreatedAt), formatTime(sess.UpdatedAt))
	return err
}

// GetSession loads one session.
func (s *ReconcileStore) GetSession(ctx context.Context, id string) (reconcile.Session, error) {
	return scanSession(s.db.QueryRowContext(ctx, sessionColumns+` WHERE id = ?`, id))
}

// GetActiveSession returns the binding's open reconciliation, if any.
func (s *ReconcileStore) GetActiveSession(ctx context.Context, bindingID string) (reconcile.Session, bool, error) {
	sess, err := scanSession(s.db.QueryRowContext(ctx, sessionColumns+`
		WHERE binding_id = ? AND state IN ('running', 'waiting_user')`, bindingID))
	if errors.Is(err, reconcile.ErrSessionNotFound) {
		return reconcile.Session{}, false, nil
	}
	if err != nil {
		return reconcile.Session{}, false, err
	}
	return sess, true, nil
}

// UpdateSessionSnapshot records the client snapshot artifact.
func (s *ReconcileStore) UpdateSessionSnapshot(ctx context.Context, id, phase string, clientArtifactID string, sourceEpoch, sourceRevision int64, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE reconciliations SET phase = ?, client_snapshot_artifact_id = ?,
		       source_epoch = ?, source_revision = ?, updated_at = ?
		WHERE id = ?`, phase, clientArtifactID, sourceEpoch, sourceRevision, formatTime(at), id)
	return err
}

// UpdateSessionPlan records the computed plan and steps artifacts.
func (s *ReconcileStore) UpdateSessionPlan(ctx context.Context, id, state, phase, planArtifactID, stepsArtifactID, planHash string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE reconciliations SET state = ?, phase = ?, plan_artifact_id = ?,
		       steps_artifact_id = ?, plan_hash = ?, updated_at = ?
		WHERE id = ?`, state, phase, planArtifactID, stepsArtifactID, planHash, formatTime(at), id)
	return err
}

// FailOpenSessions closes every session a binding still has open. A device
// that unbound lost the replica its session was building, so the session can
// no longer be resumed by anything.
func (s *ReconcileStore) FailOpenSessions(ctx context.Context, bindingID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE reconciliations SET state = ?, phase = '', completed_at = ?, updated_at = ?
		WHERE binding_id = ? AND state IN (?, ?)`,
		string(reconcile.StateFailed), formatTime(at), formatTime(at), bindingID,
		string(reconcile.StateRunning), string(reconcile.StateWaitingUser))
	return err
}

// MarkSessionCommitted flips server_committed inside the commit
// transaction.
func (t *reconcileTx) MarkSessionCommitted(ctx context.Context, id string, commitRevision int64, at time.Time) error {
	_, err := t.tx.ExecContext(ctx, `
		UPDATE reconciliations SET server_committed = 1, commit_revision = ?,
		       phase = ?, updated_at = ?
		WHERE id = ?`, commitRevision, reconcile.PhaseCommitted, formatTime(at), id)
	return err
}

// CompleteSession closes the session inside the completion transaction.
func (t *reconcileTx) CompleteSession(ctx context.Context, id string, at time.Time) error {
	_, err := t.tx.ExecContext(ctx, `
		UPDATE reconciliations SET state = ?, phase = '', completed_at = ?, updated_at = ?
		WHERE id = ?`, string(reconcile.StateCompleted), formatTime(at), formatTime(at), id)
	return err
}

// --- artifacts ---

// InsertArtifact stores an artifact payload.
func (s *ReconcileStore) InsertArtifact(ctx context.Context, a reconcile.Artifact) error {
	var content any
	if len(a.Content) > 0 {
		content = a.Content
	}
	var expiresAt any
	if !a.ExpiresAt.IsZero() {
		expiresAt = formatTime(a.ExpiresAt)
	}
	var epoch, revision any
	if a.Epoch > 0 {
		epoch = a.Epoch
	}
	if a.Revision > 0 {
		revision = a.Revision
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO sync_artifacts
			(id, binding_id, kind, epoch, revision, storage_key, content, checksum, size_bytes, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.BindingID, a.Kind, epoch, revision, a.StorageKey, content,
		a.Checksum, a.SizeBytes, expiresAt, formatTime(a.CreatedAt))
	return err
}

func (t *reconcileTx) InsertArtifact(ctx context.Context, a reconcile.Artifact) error {
	var content any
	if len(a.Content) > 0 {
		content = a.Content
	}
	var expiresAt any
	if !a.ExpiresAt.IsZero() {
		expiresAt = formatTime(a.ExpiresAt)
	}
	var epoch, revision any
	if a.Epoch > 0 {
		epoch = a.Epoch
	}
	if a.Revision > 0 {
		revision = a.Revision
	}
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO sync_artifacts
			(id, binding_id, kind, epoch, revision, storage_key, content, checksum, size_bytes, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.BindingID, a.Kind, epoch, revision, a.StorageKey, content,
		a.Checksum, a.SizeBytes, expiresAt, formatTime(a.CreatedAt))
	return err
}

// GetArtifact loads one artifact.
func (s *ReconcileStore) GetArtifact(ctx context.Context, id string) (reconcile.Artifact, error) {
	return scanArtifact(s.db.QueryRowContext(ctx, `
		SELECT id, binding_id, kind, epoch, revision, storage_key, content, checksum, size_bytes, expires_at, created_at
		FROM sync_artifacts WHERE id = ?`, id))
}

func scanArtifact(row interface{ Scan(dest ...any) error }) (reconcile.Artifact, error) {
	var a reconcile.Artifact
	var epoch, revision, size sql.NullInt64
	var content []byte
	var checksum, storageKey, createdAt sql.NullString
	var expiresAt sql.NullString
	err := row.Scan(&a.ID, &a.BindingID, &a.Kind, &epoch, &revision, &storageKey, &content,
		&checksum, &size, &expiresAt, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return reconcile.Artifact{}, fmt.Errorf("reconcile: artifact not found")
	}
	if err != nil {
		return reconcile.Artifact{}, err
	}
	a.Epoch = epoch.Int64
	a.Revision = revision.Int64
	a.StorageKey = storageKey.String
	a.Content = content
	a.Checksum = checksum.String
	a.SizeBytes = int(size.Int64)
	if expiresAt.Valid {
		a.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expiresAt.String)
	}
	if createdAt.Valid {
		a.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt.String)
	}
	return a, nil
}

// --- server snapshots ---

// InsertServerSnapshot stores the frozen snapshot with its node set.
func (t *reconcileTx) InsertServerSnapshot(ctx context.Context, snap reconcile.ServerSnapshot, nodes []reconcile.SnapshotNode) error {
	if _, err := t.tx.ExecContext(ctx, `
		INSERT INTO server_snapshots (id, binding_id, space_id, epoch, revision, node_count, checksum, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		snap.ID, snap.BindingID, string(snap.SpaceID), snap.Epoch, snap.Revision,
		snap.NodeCount, snap.Checksum, formatTime(snap.ExpiresAt), formatTime(snap.CreatedAt)); err != nil {
		return err
	}
	for _, n := range nodes {
		if _, err := t.tx.ExecContext(ctx, `
			INSERT INTO server_snapshot_nodes (snapshot_id, node_ref, parent_ref, type, title, url, root_key, position)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			snap.ID, n.NodeRef, n.ParentRef, n.Type, n.Title, n.URL, n.RootKey, n.Position); err != nil {
			return err
		}
	}
	return nil
}

// GetServerSnapshotByArtifact loads the snapshot bound to an artifact id
// (snapshot rows and their artifact rows share the same id).
func (s *ReconcileStore) GetServerSnapshotByArtifact(ctx context.Context, artifactID string) (reconcile.ServerSnapshot, error) {
	return scanSnapshot(s.db.QueryRowContext(ctx, `
		SELECT id, binding_id, space_id, epoch, revision, node_count, checksum, expires_at, created_at
		FROM server_snapshots WHERE id = ?`, artifactID))
}

func scanSnapshot(row interface{ Scan(dest ...any) error }) (reconcile.ServerSnapshot, error) {
	var snap reconcile.ServerSnapshot
	var expiresAt sql.NullString
	var createdAt string
	err := row.Scan(&snap.ID, &snap.BindingID, &snap.SpaceID, &snap.Epoch, &snap.Revision,
		&snap.NodeCount, &snap.Checksum, &expiresAt, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return reconcile.ServerSnapshot{}, fmt.Errorf("reconcile: server snapshot not found")
	}
	if err != nil {
		return reconcile.ServerSnapshot{}, err
	}
	if expiresAt.Valid {
		snap.ExpiresAt, _ = time.Parse(time.RFC3339Nano, expiresAt.String)
	}
	snap.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return snap, nil
}

// ListSnapshotNodes reads a page of the frozen node set; pagination over
// a snapshot always observes the same point in time (doc 08 §9).
func (s *ReconcileStore) ListSnapshotNodes(ctx context.Context, snapshotID string, offset, limit int) ([]reconcile.SnapshotNode, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT node_ref, parent_ref, type, title, url, root_key, position
		FROM server_snapshot_nodes WHERE snapshot_id = ?
		ORDER BY position, node_ref LIMIT ? OFFSET ?`,
		snapshotID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var nodes []reconcile.SnapshotNode
	for rows.Next() {
		var n reconcile.SnapshotNode
		if err := rows.Scan(&n.NodeRef, &n.ParentRef, &n.Type, &n.Title, &n.URL, &n.RootKey, &n.Position); err != nil {
			return nil, err
		}
		nodes = append(nodes, n)
	}
	return nodes, rows.Err()
}

// --- issues ---

// ReplaceIssues swaps the issue set of a session after a (re)plan.
func (s *ReconcileStore) ReplaceIssues(ctx context.Context, sessionID string, issues []reconcile.Issue) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if _, err := tx.ExecContext(ctx, `DELETE FROM reconciliation_issues WHERE reconciliation_id = ?`, sessionID); err != nil {
		return err
	}
	for _, issue := range issues {
		payload, err := json.Marshal(issue.Payload)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO reconciliation_issues (id, reconciliation_id, type, payload, default_choice, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
			issue.ID, issue.ReconciliationID, issue.Type, string(payload), issue.DefaultChoice, formatTime(issue.CreatedAt)); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// ListIssues returns the session's issues.
func (s *ReconcileStore) ListIssues(ctx context.Context, sessionID string) ([]reconcile.Issue, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, reconciliation_id, type, payload, default_choice, selected_choice, created_at
		FROM reconciliation_issues WHERE reconciliation_id = ? ORDER BY created_at, id`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var issues []reconcile.Issue
	for rows.Next() {
		var issue reconcile.Issue
		var payload string
		var selected sql.NullString
		var createdAt string
		if err := rows.Scan(&issue.ID, &issue.ReconciliationID, &issue.Type, &payload,
			&issue.DefaultChoice, &selected, &createdAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(payload), &issue.Payload); err != nil {
			return nil, err
		}
		if selected.Valid {
			issue.SelectedChoice = &selected.String
		}
		issue.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		issues = append(issues, issue)
	}
	return issues, rows.Err()
}

// ResolveIssue records the user's choice for one issue.
func (s *ReconcileStore) ResolveIssue(ctx context.Context, issueID, choice string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE reconciliation_issues SET selected_choice = ? WHERE id = ?`, choice, issueID)
	return err
}

// --- binding / space ---

// LoadBinding loads a binding by id.
func (s *ReconcileStore) LoadBinding(ctx context.Context, bindingID string) (device.Binding, error) {
	return s.devices.GetBindingByID(ctx, bindingID)
}

// LoadSpace loads a sync space.
func (s *ReconcileStore) LoadSpace(ctx context.Context, spaceID canonical.SpaceID) (canonical.SyncSpace, error) {
	return scanSpace(s.db.QueryRowContext(ctx, spaceColumns, string(spaceID)))
}

// FinalizeBinding activates the binding and stamps the baseline
// watermarks (doc 06 §8).
func (t *reconcileTx) FinalizeBinding(ctx context.Context, bindingID string, epoch, appliedRevision, receivedRevision int64, at time.Time) error {
	_, err := t.tx.ExecContext(ctx, `
		UPDATE device_space_bindings SET state = 'active', epoch = ?,
		       applied_revision = ?, received_revision = ?, initialized_at = ?,
		       last_sync_at = ?, updated_at = ?
		WHERE id = ?`,
		epoch, appliedRevision, receivedRevision, formatTime(at), formatTime(at), formatTime(at), bindingID)
	return err
}

// --- transaction ---

// reconcileTx extends the canonical transaction with reconciliation
// reads and writes.
type reconcileTx struct {
	*canonTx
}

// ListRootSlots returns the space's root slots ordered by position.
func (t *reconcileTx) ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error) {
	rows, err := t.tx.QueryContext(ctx, `
		SELECT space_id, key, display_name, position, created_at
		FROM root_slots WHERE space_id = ? ORDER BY position, key`, string(space))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var slots []canonical.RootSlot
	for rows.Next() {
		var slot canonical.RootSlot
		var createdAt string
		if err := rows.Scan(&slot.SpaceID, &slot.Key, &slot.DisplayName, &slot.Position, &createdAt); err != nil {
			return nil, err
		}
		slot.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		slots = append(slots, slot)
	}
	return slots, rows.Err()
}

// UpdateSessionServerSnapshot records the frozen snapshot inside the
// snapshot transaction.
func (t *reconcileTx) UpdateSessionServerSnapshot(ctx context.Context, id, phase, serverArtifactID string, targetEpoch, targetRevision int64, at time.Time) error {
	_, err := t.tx.ExecContext(ctx, `
		UPDATE reconciliations SET phase = ?, server_snapshot_artifact_id = ?,
		       target_epoch = ?, target_revision = ?, updated_at = ?
		WHERE id = ?`, phase, serverArtifactID, targetEpoch, targetRevision, formatTime(at), id)
	return err
}
