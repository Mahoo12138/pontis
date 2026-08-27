package sync

import (
	"context"
	"errors"

	"pontis/internal/canonical"
	"pontis/internal/device"
)

// decideCreate handles CREATE. Offline-created new data is protected:
// when the parent folder was deleted after the operation's base, the node
// is recovered under a Recovered/<Device> root slot instead of being
// dropped.
func (s *Service) decideCreate(ctx context.Context, tx Tx, space canonical.SyncSpace, binding device.Binding, op Operation, deviceName string, origin canonical.Origin) (OperationResult, error) {
	// Duplicate client-generated UUID: the node already exists; report a
	// no-op so the client can settle on the existing canonical state.
	if existing, err := tx.LoadNode(ctx, space.ID, op.NodeID); err == nil {
		return noopResult(op, ReasonAlreadyExists, existing.CreatedRevision), nil
	} else if !errors.Is(err, canonical.ErrNodeNotFound) {
		return OperationResult{}, err
	}

	parent := op.Parent
	recovered := false
	switch parent.Type {
	case canonical.ParentTypeNode:
		p, err := tx.LoadNode(ctx, space.ID, parent.NodeID)
		switch {
		case errors.Is(err, canonical.ErrNodeNotFound):
			if _, found, err := tx.LoadTombstone(ctx, space.ID, parent.NodeID); err != nil {
				return OperationResult{}, err
			} else if found {
				// Parent deleted after base: protect the new data.
				key := recoveryRootKey(canonical.DeviceID(binding.DeviceID))
				if err := tx.EnsureRootSlot(ctx, space.ID, key, recoveryRootName(deviceName)); err != nil {
					return OperationResult{}, err
				}
				parent = canonical.NewRootParent(key)
				recovered = true
			} else {
				return rejectedResult(op, ReasonInvalidParent), nil
			}
		case err != nil:
			return OperationResult{}, err
		default:
			if p.Type != canonical.NodeTypeFolder {
				return rejectedResult(op, ReasonParentNotFolder), nil
			}
		}
	case canonical.ParentTypeRoot:
		if _, err := tx.LoadRootSlot(ctx, space.ID, parent.RootKey); err != nil {
			return rejectedResult(op, ReasonInvalidParent), nil
		}
	default:
		return rejectedResult(op, ReasonInvalidPayload), nil
	}

	// Anchor resolution. A stale before_id falls back to append.
	beforeID := op.BeforeID
	rebased := false
	anchorReason := ""
	if !recovered && beforeID != nil {
		if *beforeID == op.NodeID {
			return rejectedResult(op, ReasonInvalidAnchor), nil
		}
		children, err := tx.Children(ctx, space.ID, parent)
		if err != nil {
			return OperationResult{}, err
		}
		if !containsChild(children, *beforeID) {
			rebased = true
			anchorReason = s.anchorGoneReason(ctx, tx, space.ID, *beforeID)
			beforeID = nil
		}
	} else if recovered {
		// The original anchor lived under the deleted parent; drop it.
		beforeID = nil
	}

	res, err := s.applyCommand(ctx, tx, space, origin, op, canonical.CreateNode{
		SpaceID:  space.ID,
		NodeID:   op.NodeID,
		Type:     op.NodeType,
		Title:    op.Title,
		URL:      op.URL,
		Parent:   parent,
		BeforeID: beforeID,
	})
	if err != nil {
		return OperationResult{}, err
	}
	switch {
	case recovered:
		res.Status, res.Reason = StatusRecovered, ReasonParentDeleted
	case rebased:
		res.Status, res.Reason = StatusRebased, anchorReason
	}
	return res, nil
}

// decideUpdate handles one-field UPDATE (title or url). Concurrent edits
// of the same field conflict unless the winning change is a causal
// predecessor of the same binding; concurrent edits of different fields
// merge because only the affected field revision is compared.
func (s *Service) decideUpdate(ctx context.Context, tx Tx, space canonical.SyncSpace, binding device.Binding, op Operation, origin canonical.Origin, isURL bool) (OperationResult, error) {
	node, err := tx.LoadNode(ctx, space.ID, op.NodeID)
	if errors.Is(err, canonical.ErrNodeNotFound) {
		return s.deletedTargetResult(ctx, tx, op, space, StatusRejected, ReasonTargetDeleted, ReasonInvalidTarget)
	}
	if err != nil {
		return OperationResult{}, err
	}

	var fieldRev int64
	var current, wanted string
	if isURL {
		if node.Type != canonical.NodeTypeBookmark {
			return rejectedResult(op, ReasonNotBookmark), nil
		}
		fieldRev, current, wanted = node.URLRevision, node.URL, op.URL
	} else {
		fieldRev, current, wanted = node.TitleRevision, node.Title, op.Title
	}

	if fieldRev > op.BaseRevision {
		causal, err := s.sameBindingCausal(ctx, tx, space, binding.ID, fieldRev, op.ClientSeq)
		if err != nil {
			return OperationResult{}, err
		}
		if !causal {
			if current == wanted {
				return noopResult(op, ReasonConcurrentUpdate, fieldRev), nil
			}
			return conflictResult(op, ReasonConcurrentUpdate, fieldRev), nil
		}
	}

	var cmd canonical.Command
	if isURL {
		cmd = canonical.UpdateNodeURL{SpaceID: space.ID, NodeID: op.NodeID, URL: op.URL}
	} else {
		cmd = canonical.UpdateNodeTitle{SpaceID: space.ID, NodeID: op.NodeID, Title: op.Title}
	}
	return s.applyCommand(ctx, tx, space, origin, op, cmd)
}

// decideMove handles MOVE (reparent and/or reorder). Concurrent moves to
// different canonical destinations conflict; a stale before_id anchor is
// rebased to append.
func (s *Service) decideMove(ctx context.Context, tx Tx, space canonical.SyncSpace, binding device.Binding, op Operation, origin canonical.Origin) (OperationResult, error) {
	node, err := tx.LoadNode(ctx, space.ID, op.NodeID)
	if errors.Is(err, canonical.ErrNodeNotFound) {
		return s.deletedTargetResult(ctx, tx, op, space, StatusRejected, ReasonTargetDeleted, ReasonInvalidTarget)
	}
	if err != nil {
		return OperationResult{}, err
	}

	// Resolve the new parent. Moving into a deleted folder is a stale
	// destructive intent: rejected, no recovery for relocated data.
	parent := op.Parent
	switch parent.Type {
	case canonical.ParentTypeNode:
		p, err := tx.LoadNode(ctx, space.ID, parent.NodeID)
		switch {
		case errors.Is(err, canonical.ErrNodeNotFound):
			if _, found, err := tx.LoadTombstone(ctx, space.ID, parent.NodeID); err != nil {
				return OperationResult{}, err
			} else if found {
				return rejectedResult(op, ReasonParentDeleted), nil
			}
			return rejectedResult(op, ReasonInvalidParent), nil
		case err != nil:
			return OperationResult{}, err
		default:
			if p.Type != canonical.NodeTypeFolder {
				return rejectedResult(op, ReasonParentNotFolder), nil
			}
		}
	case canonical.ParentTypeRoot:
		if _, err := tx.LoadRootSlot(ctx, space.ID, parent.RootKey); err != nil {
			return rejectedResult(op, ReasonInvalidParent), nil
		}
	default:
		return rejectedResult(op, ReasonInvalidPayload), nil
	}

	// Load siblings once: anchor resolution and intended index.
	siblings, err := tx.Children(ctx, space.ID, parent)
	if err != nil {
		return OperationResult{}, err
	}

	beforeID := op.BeforeID
	rebased := false
	anchorReason := ""
	if beforeID != nil {
		if *beforeID == node.ID {
			return rejectedResult(op, ReasonInvalidAnchor), nil
		}
		if !containsChild(siblings, *beforeID) {
			rebased = true
			anchorReason = s.anchorGoneReason(ctx, tx, space.ID, *beforeID)
			beforeID = nil
		}
	}

	base := excludeNode(siblings, node.ID)
	idx := insertIndex(base, beforeID)

	// Already exactly at the intended place: no canonical change.
	if sameParent(node.Parent, parent) && node.Position == idx {
		return noopResult(op, ReasonAlreadyInPlace, node.StructureRevision), nil
	}

	if node.StructureRevision > op.BaseRevision {
		causal, err := s.sameBindingCausal(ctx, tx, space, binding.ID, node.StructureRevision, op.ClientSeq)
		if err != nil {
			return OperationResult{}, err
		}
		if !causal {
			return conflictResult(op, ReasonConcurrentMove, node.StructureRevision), nil
		}
	}

	res, err := s.applyCommand(ctx, tx, space, origin, op, canonical.MoveNode{
		SpaceID:  space.ID,
		NodeID:   op.NodeID,
		Parent:   parent,
		BeforeID: beforeID,
	})
	if err != nil {
		return OperationResult{}, err
	}
	if rebased {
		res.Status, res.Reason = StatusRebased, anchorReason
	}
	return res, nil
}

// decideDelete handles DELETE. Deletion always wins over stale updates
// and moves; deleting an already-deleted node is a no-op.
func (s *Service) decideDelete(ctx context.Context, tx Tx, space canonical.SyncSpace, binding device.Binding, op Operation, origin canonical.Origin) (OperationResult, error) {
	if _, err := tx.LoadNode(ctx, space.ID, op.NodeID); err != nil {
		if errors.Is(err, canonical.ErrNodeNotFound) {
			return s.deletedTargetResult(ctx, tx, op, space, StatusNoop, ReasonAlreadyDeleted, ReasonInvalidTarget)
		}
		return OperationResult{}, err
	}
	return s.applyCommand(ctx, tx, space, origin, op, canonical.DeleteNode{
		SpaceID: space.ID,
		NodeID:  op.NodeID,
	})
}

// applyCommand executes a canonical command inside the open transaction
// and reports the resulting revision. Canonical validation failures map
// to per-operation rejections.
func (s *Service) applyCommand(ctx context.Context, tx Tx, space canonical.SyncSpace, origin canonical.Origin, op Operation, cmd canonical.Command) (OperationResult, error) {
	if err := s.executor.ApplyTx(ctx, tx, origin, cmd); err != nil {
		if reason, ok := rejectionReason(err); ok {
			return rejectedResult(op, reason), nil
		}
		return OperationResult{}, err
	}
	head, err := tx.LoadSpace(ctx, space.ID)
	if err != nil {
		return OperationResult{}, err
	}
	return OperationResult{
		OpID:                op.OpID,
		ClientSeq:           op.ClientSeq,
		Status:              StatusApplied,
		ResultRevision:      head.CurrentRevision,
		SettleAfterRevision: head.CurrentRevision,
	}, nil
}

// deletedTargetResult resolves operations against a missing node: with a
// tombstone the delete wins (deletedStatus/deletedReason), otherwise the
// target never existed (ReasonInvalidTarget).
func (s *Service) deletedTargetResult(ctx context.Context, tx Tx, op Operation, space canonical.SyncSpace, deletedStatus OpStatus, deletedReason, missingReason string) (OperationResult, error) {
	tomb, found, err := tx.LoadTombstone(ctx, space.ID, op.NodeID)
	if err != nil {
		return OperationResult{}, err
	}
	if !found {
		return rejectedResult(op, missingReason), nil
	}
	if deletedStatus == StatusNoop {
		return noopResult(op, deletedReason, tomb.Revision), nil
	}
	return rejectedWithSettle(op, deletedReason, tomb.Revision), nil
}

// sameBindingCausal reports whether the canonical change at revision was
// authored by the same binding as a causal predecessor (client_seq below
// the current operation's). Such changes must not be treated as
// concurrent conflicts.
func (s *Service) sameBindingCausal(ctx context.Context, tx Tx, space canonical.SyncSpace, bindingID string, revision, opSeq int64) (bool, error) {
	originBinding, originSeq, found, err := tx.LoadJournalOrigin(ctx, space.ID, space.Epoch, revision)
	if err != nil || !found {
		return false, err
	}
	return originBinding == bindingID && originSeq != nil && *originSeq < opSeq, nil
}

// anchorGoneReason distinguishes a deleted anchor from one that merely
// moved out of the target parent.
func (s *Service) anchorGoneReason(ctx context.Context, tx Tx, space canonical.SpaceID, anchor canonical.NodeID) string {
	if _, found, err := tx.LoadTombstone(ctx, space, anchor); err == nil && found {
		return ReasonAnchorDeleted
	}
	if _, err := tx.LoadNode(ctx, space, anchor); err == nil {
		return ReasonAnchorMoved
	}
	return ReasonAnchorDeleted
}

func recoveryRootKey(deviceID canonical.DeviceID) string {
	return "recovered:" + string(deviceID)
}

func recoveryRootName(deviceName string) string {
	if deviceName == "" {
		return "Recovered"
	}
	return "Recovered/" + deviceName
}

func sameParent(a, b canonical.ParentRef) bool {
	if a.Type != b.Type {
		return false
	}
	switch a.Type {
	case canonical.ParentTypeNode:
		return a.NodeID == b.NodeID
	case canonical.ParentTypeRoot:
		return a.RootKey == b.RootKey
	default:
		return false
	}
}

// rejectionReason maps canonical validation errors to result reasons.
func rejectionReason(err error) (string, bool) {
	switch {
	case errors.Is(err, canonical.ErrTitleRequired),
		errors.Is(err, canonical.ErrURLRequired),
		errors.Is(err, canonical.ErrURLNotAllowed),
		errors.Is(err, canonical.ErrParentMissing):
		return ReasonInvalidPayload, true
	case errors.Is(err, canonical.ErrParentNotFolder):
		return ReasonParentNotFolder, true
	case errors.Is(err, canonical.ErrNodeIsSelf),
		errors.Is(err, canonical.ErrTreeCycle):
		return ReasonTreeCycle, true
	default:
		return "", false
	}
}

func containsChild(children []canonical.Node, id canonical.NodeID) bool {
	for _, c := range children {
		if c.ID == id {
			return true
		}
	}
	return false
}

func excludeNode(children []canonical.Node, id canonical.NodeID) []canonical.Node {
	out := make([]canonical.Node, 0, len(children))
	for _, c := range children {
		if c.ID != id {
			out = append(out, c)
		}
	}
	return out
}

// insertIndex returns the position before beforeID among the (self-
// excluded) siblings, or append when nil.
func insertIndex(siblings []canonical.Node, beforeID *canonical.NodeID) int64 {
	if beforeID == nil {
		return int64(len(siblings))
	}
	for i, c := range siblings {
		if c.ID == *beforeID {
			return int64(i)
		}
	}
	return int64(len(siblings))
}
