package canonical

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// UndoStatus is the outcome of planning an undo (doc 15 §8). V1 never
// forces an undo past a review (no force undo).
type UndoStatus string

const (
	// UndoClean means the inverse commands can run safely.
	UndoClean UndoStatus = "clean"
	// UndoReviewRequired means newer state would be clobbered or
	// protected data would be lost (doc 15 §4-6).
	UndoReviewRequired UndoStatus = "review_required"
	// UndoNotUndoable means there is no usable before-image.
	UndoNotUndoable UndoStatus = "not_undoable"
	// UndoExpired means the undo window has passed (doc 15 §12).
	UndoExpired UndoStatus = "expired"
)

// UndoReview explains one blocking condition.
type UndoReview struct {
	NodeID string
	Reason string
}

// UndoPlan is the validated inverse of a ChangeSet.
type UndoPlan struct {
	Status        UndoStatus
	Commands      []Command
	Reviews       []UndoReview
	ChangeSet     ChangeSet // set after execution; zero while planning
	SkippedCreate bool      // every created node was already gone
}

// Reasons surfaced in reviews.
const (
	ReviewFieldChanged    = "field_changed_since"
	ReviewMovedSince      = "moved_since"
	ReviewAlreadyRestored = "already_restored"
	ReviewProtectedData   = "protected_descendants"
	ReviewParentDeleted   = "parent_deleted_since"
)

// ErrChangeSetNotFound is returned for unknown ChangeSet ids.
var ErrChangeSetNotFound = errors.New("changeset: not found")

// BuildUndoPlan validates the stored before-image against the current
// canonical state and derives the inverse commands. Read-only.
func BuildUndoPlan(ctx context.Context, tx Tx, space SpaceID, cs ChangeSet, data UndoData, now time.Time) (UndoPlan, error) {
	if !data.ExpiresAt.IsZero() && now.After(data.ExpiresAt) {
		return UndoPlan{Status: UndoExpired}, nil
	}
	payload, err := data.decode()
	if err != nil {
		return UndoPlan{}, err
	}

	plan := UndoPlan{Status: UndoClean}
	// Group restore commands per parent: siblings must be emitted in
	// reverse original order so each before-anchor already exists.
	restoreByParent := map[string][]restoredNode{}
	var restoreOrder []string

	appendCmd := func(cmd Command) {
		plan.Commands = append(plan.Commands, cmd)
	}

	for _, entry := range payload.Entries {
		switch entry.Kind {
		case "create":
			nodeID := NodeID(entry.NodeID)
			node, err := tx.LoadNode(ctx, space, nodeID)
			if errors.Is(err, ErrNodeNotFound) {
				// Already deleted by someone else: nothing to undo.
				plan.SkippedCreate = true
				continue
			} else if err != nil {
				return UndoPlan{}, err
			}
			if entry.WasFolder && node.Type == NodeTypeFolder {
				children, err := tx.Children(ctx, space, NewNodeParent(nodeID))
				if err != nil {
					return UndoPlan{}, err
				}
				if len(children) > 0 {
					// Data arrived inside the folder after creation:
					// deleting it would destroy protected descendants
					// (doc 15 §6).
					plan.Status = UndoReviewRequired
					plan.Reviews = append(plan.Reviews, UndoReview{NodeID: entry.NodeID, Reason: ReviewProtectedData})
					continue
				}
			}
			appendCmd(DeleteNode{SpaceID: space, NodeID: nodeID})
		case "update_title", "update_url":
			nodeID := NodeID(entry.NodeID)
			node, err := tx.LoadNode(ctx, space, nodeID)
			if errors.Is(err, ErrNodeNotFound) {
				continue // delete wins over stale undo (doc 15 §8)
			} else if err != nil {
				return UndoPlan{}, err
			}
			current := node.Title
			kind := "update_title"
			if entry.Kind == "update_url" {
				current = node.URL
				kind = "update_url"
			}
			if current != entry.ExpectedAfter {
				plan.Status = UndoReviewRequired
				plan.Reviews = append(plan.Reviews, UndoReview{NodeID: entry.NodeID, Reason: ReviewFieldChanged})
				continue
			}
			if kind == "update_title" {
				appendCmd(UpdateNodeTitle{SpaceID: space, NodeID: nodeID, Title: entry.Before})
			} else {
				appendCmd(UpdateNodeURL{SpaceID: space, NodeID: nodeID, URL: entry.Before})
			}
		case "move":
			nodeID := NodeID(entry.NodeID)
			node, err := tx.LoadNode(ctx, space, nodeID)
			if errors.Is(err, ErrNodeNotFound) {
				continue
			} else if err != nil {
				return UndoPlan{}, err
			}
			expected := parentFromWire(entry.ExpectedParent)
			if entry.HasExpected && !sameParentRef(node.Parent, expected) {
				// The node moved again since (a different parent): undo
				// does not drag it back (doc 15 §5). Sibling position
				// shifts from unrelated deletes/creates are not moves.
				plan.Status = UndoReviewRequired
				plan.Reviews = append(plan.Reviews, UndoReview{NodeID: entry.NodeID, Reason: ReviewMovedSince})
				continue
			}
			oldParent := parentFromWire(entry.OldParent)
			if oldParent.Type == ParentTypeNode {
				// Undoing the move needs the original parent alive; a
				// since-deleted parent requires review rather than a
				// failed transaction (doc 15 §8).
				if _, err := tx.LoadNode(ctx, space, oldParent.NodeID); errors.Is(err, ErrNodeNotFound) {
					plan.Status = UndoReviewRequired
					plan.Reviews = append(plan.Reviews, UndoReview{NodeID: entry.NodeID, Reason: ReviewParentDeleted})
					continue
				} else if err != nil {
					return UndoPlan{}, err
				}
			}
			cmd := MoveNode{SpaceID: space, NodeID: nodeID, Parent: oldParent}
			if entry.OldNextSibling != "" {
				if _, err := tx.LoadNode(ctx, space, NodeID(entry.OldNextSibling)); err == nil {
					before := NodeID(entry.OldNextSibling)
					cmd.BeforeID = &before
				}
			}
			appendCmd(cmd)
		case "delete":
			topID := NodeID(entry.NodeID)
			if _, err := tx.LoadNode(ctx, space, topID); err == nil {
				// Restoring over a live node would duplicate identity.
				plan.Status = UndoReviewRequired
				plan.Reviews = append(plan.Reviews, UndoReview{NodeID: entry.NodeID, Reason: ReviewAlreadyRestored})
				continue
			} else if !errors.Is(err, ErrNodeNotFound) {
				return UndoPlan{}, err
			}
			// The original parent may have been deleted since (doc 15
			// §7): route the top node to a recovery root instead of
			// losing the restored content.
			parent := parentFromWire(entry.Subtree[0].Parent)
			if parent.Type == ParentTypeNode {
				if _, err := tx.LoadNode(ctx, space, parent.NodeID); errors.Is(err, ErrNodeNotFound) {
					key := "recovered:undo"
					if err := tx.EnsureRootSlot(ctx, space, key, "Recovered"); err != nil {
						return UndoPlan{}, err
					}
					parent = NewRootParent(key)
					entry.Subtree[0].Parent = parentToWire(parent)
					entry.Subtree[0].NextSibling = ""
				} else if err != nil {
					return UndoPlan{}, err
				}
			}
			for _, node := range entry.Subtree {
				key := node.Parent.Key
				if node.Parent.Type == "node" {
					key = node.Parent.ID
				}
				restoreByParent[key] = append(restoreByParent[key], node)
				if len(restoreByParent[key]) == 1 {
					restoreOrder = append(restoreOrder, key)
				}
			}
		}
	}

	// Emit restore commands: per parent, reverse original order, each
	// anchored before its original next sibling (created one step earlier
	// in the reverse walk).
	for _, parentKey := range restoreOrder {
		group := restoreByParent[parentKey]
		for i := len(group) - 1; i >= 0; i-- {
			node := group[i]
			cmd := CreateNode{
				SpaceID: space,
				NodeID:  NodeID(node.ID),
				Type:    node.Type,
				Title:   node.Title,
				URL:     node.URL,
				Parent:  parentFromWire(node.Parent),
			}
			if node.NextSibling != "" && nodeIn(group, node.NextSibling) == nil {
				// The anchor lives outside the restored subtree: use it
				// only when it still exists.
				if _, err := tx.LoadNode(ctx, space, NodeID(node.NextSibling)); err == nil {
					before := NodeID(node.NextSibling)
					cmd.BeforeID = &before
				}
			} else if node.NextSibling != "" {
				before := NodeID(node.NextSibling)
				cmd.BeforeID = &before
			}
			appendCmd(cmd)
		}
	}
	return plan, nil
}

// sameParentRef compares two parent references for identity.
func sameParentRef(a, b ParentRef) bool {
	if a.Type != b.Type {
		return false
	}
	switch a.Type {
	case ParentTypeNode:
		return a.NodeID == b.NodeID
	case ParentTypeRoot:
		return a.RootKey == b.RootKey
	default:
		return false
	}
}

func nodeIn(group []restoredNode, id string) *restoredNode {
	for i := range group {
		if group[i].ID == id {
			return &group[i]
		}
	}
	return nil
}

// ExecuteUndo validates and applies the inverse of a ChangeSet as a new
// ChangeSet (revisions only move forward, doc 15 §2) in one
// transaction. The undo ChangeSet carries its own before-image, which
// makes the inverse reversible.
func (e *Executor) ExecuteUndo(ctx context.Context, store Store, origin Origin, space SpaceID, changeSetID string) (UndoPlan, error) {
	tx, err := store.BeginTx(ctx)
	if err != nil {
		return UndoPlan{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	cs, err := tx.LoadChangeSet(ctx, space, changeSetID)
	if errors.Is(err, ErrChangeSetNotFound) {
		return UndoPlan{Status: UndoNotUndoable}, nil
	} else if err != nil {
		return UndoPlan{}, err
	}
	data, found, err := tx.LoadUndoData(ctx, changeSetID)
	if err != nil {
		return UndoPlan{}, err
	}
	if !found {
		return UndoPlan{Status: UndoNotUndoable}, nil
	}

	plan, err := BuildUndoPlan(ctx, tx, space, cs, data, time.Now().UTC())
	if err != nil {
		return UndoPlan{}, err
	}
	if plan.Status != UndoClean || len(plan.Commands) == 0 {
		return plan, nil
	}

	summary := "撤销了「" + cs.Summary + "」"
	if cs.Summary == "" {
		summary = fmt.Sprintf("撤销了 %s 操作", cs.Kind)
	}
	undone, err := e.ApplyTxChangeSet(ctx, tx, origin, space, ChangeSetInput{
		Kind:      "undo",
		Summary:   summary,
		InverseOf: cs.ID,
	}, plan.Commands...)
	if err != nil {
		return UndoPlan{}, err
	}
	plan.ChangeSet = undone

	if err := tx.Commit(ctx); err != nil {
		return UndoPlan{}, err
	}
	committed = true
	return plan, nil
}
