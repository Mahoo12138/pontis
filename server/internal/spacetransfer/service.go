// Package spacetransfer implements the atomic Cross-Space Transfer
// protocol (doc 03 §7, doc 08 §15): within ONE SQLite transaction the
// subtree is created in the target space with fresh canonical UUIDs and
// deleted from the source space, both journals advance together, and a
// cross_space_transfers record makes the operation idempotent
// (doc 18 §8). Cross-user transfer stays a Publication Copy (doc 22 §5).
package spacetransfer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
)

// Errors surfaced to the HTTP layer.
var (
	// ErrInvalidRequest covers malformed transfer payloads.
	ErrInvalidRequest = errors.New("spacetransfer: invalid transfer request")
	// ErrTransferIDReused is returned when a client reuses a transfer_id
	// for a different payload.
	ErrTransferIDReused = errors.New("spacetransfer: transfer_id reused with a different request")
	// ErrSameSpace rejects source == target.
	ErrSameSpace = errors.New("spacetransfer: source and target space must differ")
	// ErrNotSpaceOwner rejects transfers across owners (doc 22 §5).
	ErrNotSpaceOwner = errors.New("spacetransfer: space belongs to another user")
	// ErrTargetParentInvalid rejects parents outside the target space.
	ErrTargetParentInvalid = errors.New("spacetransfer: target parent must live in the target space")
)

// TransferRecord is the persisted idempotency record (doc 18 §8).
type TransferRecord struct {
	ID                string
	OwnerUserID       canonical.UserID
	SourceSpaceID     canonical.SpaceID
	TargetSpaceID     canonical.SpaceID
	SourceBindingID   string
	TargetBindingID   string
	State             string
	RequestHash       string
	MappingJSON       string
	SourceChangeSetID string
	TargetChangeSetID string
	CreatedAt         time.Time
	CompletedAt       *time.Time
}

// StateCompleted marks a transfer that committed atomically.
const StateCompleted = "completed"

// Store is the persistence contract. The sqlite canonical store
// implements both this and the canonical.Tx used inside the transaction.
type Store interface {
	canonical.Store // BeginTx

	// InsertTransferTx persists a completed transfer record inside the
	// transaction that moved the subtree (keeps the operation atomic).
	InsertTransferTx(ctx context.Context, tx canonical.Tx, t TransferRecord) error

	// GetTransfer loads a transfer by id; returns the zero record (with
	// an empty ID) when absent.
	GetTransfer(ctx context.Context, id string) (TransferRecord, error)
}

// NodeMapping maps one source node id to its fresh target node id.
type NodeMapping struct {
	SourceNodeID canonical.NodeID `json:"source_node_id"`
	TargetNodeID canonical.NodeID `json:"target_node_id"`
}

// Request describes one transfer.
type Request struct {
	TransferID   string
	SourceSpace  canonical.SpaceID
	TargetSpace  canonical.SpaceID
	NodeID       canonical.NodeID
	TargetParent canonical.ParentRef
	BeforeID     *canonical.NodeID
	// Optional binding attribution for device-initiated transfers.
	SourceBindingID string
	TargetBindingID string
}

// TransferResult is returned on success and on idempotent replay.
type TransferResult struct {
	TransferID     string
	SourceRevision int64
	TargetRevision int64
	Mapping        []NodeMapping
}

// Service executes atomic cross-space transfers.
type Service struct {
	store      Store
	changesets *changeset.Service
}

// NewService builds a transfer service.
func NewService(store Store, changesets *changeset.Service) *Service {
	return &Service{store: store, changesets: changesets}
}

func hashRequest(req Request) string {
	before := ""
	if req.BeforeID != nil {
		before = string(*req.BeforeID)
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s|%s|%s|%s|%s:%s:%s|%s",
		req.TransferID, req.SourceSpace, req.TargetSpace, req.NodeID,
		req.TargetParent.Type, req.TargetParent.NodeID, req.TargetParent.RootKey,
		before)
	return hex.EncodeToString(h.Sum(nil))
}

// Transfer moves a subtree between two spaces of the same owner.
// It is idempotent on TransferID: a replay with the identical payload
// returns the original mapping, a conflicting payload is rejected.
func (s *Service) Transfer(ctx context.Context, owner canonical.UserID, req Request) (TransferResult, error) {
	if req.TransferID == "" || req.SourceSpace == "" || req.TargetSpace == "" || req.NodeID == "" {
		return TransferResult{}, ErrInvalidRequest
	}
	if req.SourceSpace == req.TargetSpace {
		return TransferResult{}, ErrSameSpace
	}
	hash := hashRequest(req)

	if prev, err := s.store.GetTransfer(ctx, req.TransferID); err != nil {
		return TransferResult{}, fmt.Errorf("spacetransfer: load transfer: %w", err)
	} else if prev.ID != "" {
		if prev.RequestHash != hash {
			return TransferResult{}, ErrTransferIDReused
		}
		return replayResult(prev), nil
	}

	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return TransferResult{}, fmt.Errorf("spacetransfer: begin tx: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	// Owner-scoped both spaces (doc 22 §5).
	srcSpace, err := tx.LoadSpace(ctx, req.SourceSpace)
	if err != nil {
		return TransferResult{}, err
	}
	tgtSpace, err := tx.LoadSpace(ctx, req.TargetSpace)
	if err != nil {
		return TransferResult{}, err
	}
	if srcSpace.OwnerUserID != owner || tgtSpace.OwnerUserID != owner {
		return TransferResult{}, ErrNotSpaceOwner
	}

	if err := s.validateTargetParent(ctx, tx, req.TargetSpace, req.TargetParent); err != nil {
		return TransferResult{}, err
	}
	if _, err := tx.LoadNode(ctx, req.SourceSpace, req.NodeID); err != nil {
		return TransferResult{}, fmt.Errorf("spacetransfer: source node: %w", err)
	}

	// Read the source subtree in hierarchical order (parents first).
	subtree, err := readSubtree(ctx, tx, req.SourceSpace, req.NodeID)
	if err != nil {
		return TransferResult{}, err
	}

	// Fresh canonical UUIDs for every node, hierarchy preserved.
	mapping := make(map[canonical.NodeID]canonical.NodeID, len(subtree))
	for _, n := range subtree {
		id, err := uuid.NewV7()
		if err != nil {
			return TransferResult{}, fmt.Errorf("spacetransfer: new id: %w", err)
		}
		mapping[n.ID] = canonical.NodeID(id.String())
	}
	now := time.Now().UTC()
	// Each side of the transfer is its own ChangeSet (activity history,
	// doc 15 §3). Transfers are not undoable in V1: undoing one means a
	// reverse transfer, a separate high-level operation.
	recTarget := s.changesets.BeginBatch(req.TargetSpace, changeset.KindTransferIn,
		canonical.Origin{Type: canonical.OriginTransfer, UserID: owner}, false)
	recSource := s.changesets.BeginBatch(req.SourceSpace, changeset.KindTransferOut,
		canonical.Origin{Type: canonical.OriginTransfer, UserID: owner}, false)

	creates := make([]canonical.Command, 0, len(subtree))
	for _, n := range subtree {
		parent := req.TargetParent
		if n.ID != req.NodeID {
			parent = canonical.NewNodeParent(mapping[n.Parent.NodeID])
		}
		creates = append(creates, canonical.CreateNode{
			SpaceID: req.TargetSpace,
			NodeID:  mapping[n.ID],
			Type:    n.Type,
			Title:   n.Title,
			URL:     n.URL,
			Parent:  parent,
			BeforeID: func() *canonical.NodeID {
				if n.ID == req.NodeID {
					return req.BeforeID
				}
				return nil
			}(),
		})
	}
	for _, cmd := range creates {
		if err := recTarget.Apply(ctx, tx, cmd); err != nil {
			return TransferResult{}, err
		}
	}
	if _, err := recTarget.Finish(ctx, tx, fmt.Sprintf("跨空间转入 %d 个条目", len(subtree))); err != nil {
		return TransferResult{}, err
	}
	if err := recSource.Apply(ctx, tx, canonical.DeleteNode{
		SpaceID: req.SourceSpace,
		NodeID:  req.NodeID,
	}); err != nil {
		return TransferResult{}, err
	}
	if _, err := recSource.Finish(ctx, tx, fmt.Sprintf("跨空间转出 %d 个条目", len(subtree))); err != nil {
		return TransferResult{}, err
	}

	finalSrc, err := tx.LoadSpace(ctx, req.SourceSpace)
	if err != nil {
		return TransferResult{}, err
	}
	finalTgt, err := tx.LoadSpace(ctx, req.TargetSpace)
	if err != nil {
		return TransferResult{}, err
	}

	mappingJSON, err := json.Marshal(mappingSlice(mapping))
	if err != nil {
		return TransferResult{}, fmt.Errorf("spacetransfer: encode mapping: %w", err)
	}
	completed := now
	record := TransferRecord{
		ID:                req.TransferID,
		OwnerUserID:       owner,
		SourceSpaceID:     req.SourceSpace,
		TargetSpaceID:     req.TargetSpace,
		SourceBindingID:   req.SourceBindingID,
		TargetBindingID:   req.TargetBindingID,
		State:             StateCompleted,
		RequestHash:       hash,
		MappingJSON:       string(mappingJSON),
		SourceChangeSetID: recSource.ID(),
		TargetChangeSetID: recTarget.ID(),
		CreatedAt:         now,
		CompletedAt:       &completed,
	}
	if err := s.store.InsertTransferTx(ctx, tx, record); err != nil {
		return TransferResult{}, fmt.Errorf("spacetransfer: insert record: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return TransferResult{}, fmt.Errorf("spacetransfer: commit: %w", err)
	}
	committed = true

	return TransferResult{
		TransferID:     req.TransferID,
		SourceRevision: finalSrc.CurrentRevision,
		TargetRevision: finalTgt.CurrentRevision,
		Mapping:        mappingSlice(mapping),
	}, nil
}

// validateTargetParent ensures the parent reference resolves inside the
// target space (root slot or folder node).
func (s *Service) validateTargetParent(ctx context.Context, tx canonical.Tx, targetSpace canonical.SpaceID, parent canonical.ParentRef) error {
	switch parent.Type {
	case canonical.ParentTypeRoot:
		if _, err := tx.LoadRootSlot(ctx, targetSpace, parent.RootKey); err != nil {
			return ErrTargetParentInvalid
		}
		return nil
	case canonical.ParentTypeNode:
		node, err := tx.LoadNode(ctx, targetSpace, parent.NodeID)
		if err != nil {
			return ErrTargetParentInvalid
		}
		if node.Type != canonical.NodeTypeFolder {
			return ErrTargetParentInvalid
		}
		return nil
	default:
		return ErrInvalidRequest
	}
}

// readSubtree collects the whole subtree (parents before children,
// siblings in canonical order).
func readSubtree(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, root canonical.NodeID) ([]canonical.Node, error) {
	node, err := tx.LoadNode(ctx, space, root)
	if err != nil {
		return nil, fmt.Errorf("spacetransfer: load node: %w", err)
	}
	out := []canonical.Node{node}
	queue := []canonical.NodeID{root}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		children, err := tx.Children(ctx, space, canonical.NewNodeParent(parent))
		if err != nil {
			return nil, fmt.Errorf("spacetransfer: children: %w", err)
		}
		for _, c := range children {
			out = append(out, c)
			queue = append(queue, c.ID)
		}
	}
	return out, nil
}

func mappingSlice(m map[canonical.NodeID]canonical.NodeID) []NodeMapping {
	out := make([]NodeMapping, 0, len(m))
	for src, tgt := range m {
		out = append(out, NodeMapping{SourceNodeID: src, TargetNodeID: tgt})
	}
	return out
}

// replayResult rebuilds the success response from the persisted record:
// the mapping is stored, the revisions have moved on since and are no
// longer meaningful for a replay.
func replayResult(rec TransferRecord) TransferResult {
	var mapping []NodeMapping
	_ = json.Unmarshal([]byte(rec.MappingJSON), &mapping)
	if mapping == nil {
		mapping = []NodeMapping{}
	}
	return TransferResult{TransferID: rec.ID, Mapping: mapping}
}
