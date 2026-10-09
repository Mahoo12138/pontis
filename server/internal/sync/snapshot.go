// Snapshot endpoint domain (doc 06 §8): a read-only full-tree snapshot
// bound to (epoch, snapshot_revision). Clients whose received_revision
// is behind the journal floor (HISTORY_EXPIRED) rebuild their replica
// state from this snapshot instead of replaying a pruned journal.

package sync

import (
	"context"

	"pontis/internal/canonical"
	"pontis/internal/device"
)

// SnapshotNode is one canonical node of the snapshot tree.
type SnapshotNode struct {
	ID       canonical.NodeID
	Type     canonical.NodeType
	Title    string
	URL      string
	Parent   canonical.ParentRef
	Position int64
}

// SnapshotResponse is a server canonical snapshot. After applying it the
// client sets applied_revision = received_revision = snapshot_revision
// and resumes the normal /sync change stream above that revision.
type SnapshotResponse struct {
	ProtocolVersion      int
	Epoch                int64
	SnapshotRevision     int64
	JournalFloorRevision int64
	Nodes                []SnapshotNode
}

// Snapshot returns the canonical tree of the binding's space. Read-only:
// it never mutates journal, binding state or receipts. The snapshot is
// not scoped per binding mode; partial-mode clients filter to their
// mount root client-side (root keys travel in the parent refs).
//
// Binding, head and tree are read in one transaction: a client that sets
// its watermarks to snapshot_revision believes it holds exactly the tree
// labelled with that revision, so a node that arrived between the head read
// and the tree read would be a change the replica never sees.
func (s *Service) Snapshot(ctx context.Context, deviceID canonical.DeviceID, spaceID canonical.SpaceID) (SnapshotResponse, error) {
	read, err := s.store.BeginReadTx(ctx)
	if err != nil {
		return SnapshotResponse{}, err
	}
	defer func() { _ = read.Rollback(ctx) }()

	binding, err := read.LoadBinding(ctx, deviceID, spaceID)
	if err != nil || binding.State != device.StateActive {
		return SnapshotResponse{}, protocolErr(CodeBindingNotActive, "binding is not active")
	}

	space, err := read.LoadSpace(ctx, spaceID)
	if err != nil {
		return SnapshotResponse{}, protocolErr(CodeBindingNotActive, "sync space unavailable")
	}
	if binding.Epoch != space.Epoch {
		return SnapshotResponse{}, protocolErr(CodeEpochMismatch, "canonical epoch changed")
	}

	nodes, err := read.LoadSnapshotNodes(ctx, spaceID)
	if err != nil {
		return SnapshotResponse{}, err
	}

	out := SnapshotResponse{
		ProtocolVersion:      ProtocolVersion,
		Epoch:                space.Epoch,
		SnapshotRevision:     space.CurrentRevision,
		JournalFloorRevision: space.JournalFloorRevision,
		Nodes:                make([]SnapshotNode, 0, len(nodes)),
	}
	for _, n := range nodes {
		out.Nodes = append(out.Nodes, SnapshotNode{
			ID:       n.ID,
			Type:     n.Type,
			Title:    n.Title,
			URL:      n.URL,
			Parent:   n.Parent,
			Position: n.Position,
		})
	}
	return out, nil
}
