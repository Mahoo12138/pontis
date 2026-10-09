package reconcile

import (
	"context"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/device"
)

// Store is the persistence contract required by the reconciliation
// service, defined on the consumer side. The sqlite package implements
// it on top of the shared migration schema.
type Store interface {
	BeginTx(ctx context.Context) (Tx, error)

	InsertSession(ctx context.Context, s Session) error
	GetSession(ctx context.Context, id string) (Session, error)
	GetActiveSession(ctx context.Context, bindingID string) (Session, bool, error)
	UpdateSessionSnapshot(ctx context.Context, id, phase string, clientArtifactID string, sourceEpoch, sourceRevision int64, at time.Time) error
	UpdateSessionPlan(ctx context.Context, id, state, phase, planArtifactID, stepsArtifactID, planHash string, at time.Time) error

	// FailOpenSessions closes the sessions a binding still has open, so a
	// revoked binding cannot leave a reconciliation nobody can resume.
	FailOpenSessions(ctx context.Context, bindingID string, at time.Time) error

	InsertArtifact(ctx context.Context, a Artifact) error
	GetArtifact(ctx context.Context, id string) (Artifact, error)

	GetServerSnapshotByArtifact(ctx context.Context, artifactID string) (ServerSnapshot, error)
	ListSnapshotNodes(ctx context.Context, snapshotID string, offset, limit int) ([]SnapshotNode, error)

	ReplaceIssues(ctx context.Context, sessionID string, issues []Issue) error
	ListIssues(ctx context.Context, sessionID string) ([]Issue, error)
	ResolveIssue(ctx context.Context, issueID, choice string, at time.Time) error

	LoadBinding(ctx context.Context, bindingID string) (device.Binding, error)
	LoadSpace(ctx context.Context, spaceID canonical.SpaceID) (canonical.SyncSpace, error)
}

// Tx is a reconciliation transaction. It extends the canonical
// transaction so plan commits, session updates and binding finalization
// share one atomic unit.
type Tx interface {
	canonical.Tx

	// ListRootSlots returns the space's root slots ordered by position.
	ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error)

	InsertServerSnapshot(ctx context.Context, snap ServerSnapshot, nodes []SnapshotNode) error
	InsertArtifact(ctx context.Context, a Artifact) error
	UpdateSessionServerSnapshot(ctx context.Context, id, phase, serverArtifactID string, targetEpoch, targetRevision int64, at time.Time) error
	MarkSessionCommitted(ctx context.Context, id string, commitRevision int64, at time.Time) error
	CompleteSession(ctx context.Context, id string, at time.Time) error
	FinalizeBinding(ctx context.Context, bindingID string, epoch, appliedRevision, receivedRevision int64, at time.Time) error
}
