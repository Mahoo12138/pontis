package canonical

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ChangeSet is one user-facing, business-semantic operation (doc 15 §3):
// a named span of canonical revisions with an atomic before-image that
// allows a safe inverse. Journal rows link to it via Origin.ChangeSetID.
type ChangeSet struct {
	ID            string
	SpaceID       SpaceID
	ActorType     OriginType
	ActorUserID   UserID
	ActorDeviceID DeviceID
	Kind          string
	Summary       string
	FirstRevision int64
	LastRevision  int64
	InverseOf     string
	CreatedAt     time.Time
}

// ChangeSetInput describes a ChangeSet about to be recorded.
type ChangeSetInput struct {
	Kind      string
	Summary   string
	InverseOf string
}

// Undo retention (doc 15 §12): undo data outlives nothing forever; the
// activity summary outlives it.
const UndoRetention = 30 * 24 * time.Hour

// Errors.
var (
	// ErrNotUndoable is returned when a ChangeSet carries no undo data.
	ErrNotUndoable = errors.New("changeset: not undoable")
	// ErrUndoExpired is returned when the undo window has passed.
	ErrUndoExpired = errors.New("changeset: undo expired")
)

// --- before-image format (codec json v1) ---

type parentWire struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Key  string `json:"key,omitempty"`
}

func parentToWire(p ParentRef) parentWire {
	if p.Type == ParentTypeNode {
		return parentWire{Type: "node", ID: string(p.NodeID)}
	}
	return parentWire{Type: "root", Key: p.RootKey}
}

func parentFromWire(p parentWire) ParentRef {
	if p.Type == "node" {
		return NewNodeParent(NodeID(p.ID))
	}
	return NewRootParent(p.Key)
}

// restoredNode is one node of a deleted subtree's before-image.
type restoredNode struct {
	ID           string    `json:"id"`
	Type         NodeType  `json:"type"`
	Title        string    `json:"title"`
	URL          string    `json:"url,omitempty"`
	Parent       parentWire `json:"parent"`
	Position     int64     `json:"position"`
	NextSibling  string    `json:"next_sibling,omitempty"`
}

// undoEntry is the before-image of one planned command.
type undoEntry struct {
	Kind string `json:"kind"`
	NodeID string `json:"node_id"`

	// update_title / update_url: the field must still hold
	// ExpectedAfter, otherwise undoing would clobber newer state
	// (doc 15 §4).
	ExpectedAfter string `json:"expected_after,omitempty"`
	Before        string `json:"before,omitempty"`

	// move: the node must still sit at the expected post-move location
	// (doc 15 §5).
	ExpectedParent   parentWire `json:"expected_parent,omitempty"`
	ExpectedPosition int64      `json:"expected_position,omitempty"`
	HasExpected      bool       `json:"has_expected,omitempty"`

	// move inverse placement: the node's original location.
	OldParent      parentWire `json:"old_parent,omitempty"`
	OldNextSibling string     `json:"old_next_sibling,omitempty"`

	// delete: the full deleted subtree before-image (doc 15 §7).
	Subtree []restoredNode `json:"subtree,omitempty"`

	// create: undo deletes the created node; a folder only if no other
	// data arrived inside it since (doc 15 §6).
	WasFolder bool `json:"was_folder,omitempty"`
}

type undoPayload struct {
	Format  int         `json:"format"`
	Entries []undoEntry `json:"entries"`
}

const undoFormatVersion = 1

// captureBeforeImage reads the pre-mutation state of every command
// inside the open transaction (doc 15 §13: atomic with the mutation).
func captureBeforeImage(ctx context.Context, tx Tx, cmds []Command) ([]undoEntry, error) {
	entries := make([]undoEntry, 0, len(cmds))
	for _, cmd := range cmds {
		switch c := cmd.(type) {
		case CreateNode:
			entries = append(entries, undoEntry{Kind: "create", NodeID: string(c.NodeID), WasFolder: c.Type == NodeTypeFolder})
		case UpdateNodeTitle:
			node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
			if err != nil {
				return nil, err
			}
			entries = append(entries, undoEntry{Kind: "update_title", NodeID: string(c.NodeID), Before: node.Title, ExpectedAfter: c.Title})
		case UpdateNodeURL:
			node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
			if err != nil {
				return nil, err
			}
			entries = append(entries, undoEntry{Kind: "update_url", NodeID: string(c.NodeID), Before: node.URL, ExpectedAfter: c.URL})
		case MoveNode:
			node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
			if err != nil {
				return nil, err
			}
			// Original location: parent plus the sibling that followed.
			siblings, err := tx.Children(ctx, c.SpaceID, node.Parent)
			if err != nil {
				return nil, err
			}
			var next string
			for _, s := range siblings {
				if s.Position > node.Position {
					next = string(s.ID)
					break
				}
			}
			entry := undoEntry{
				Kind:           "move",
				NodeID:         string(c.NodeID),
				OldParent:      parentToWire(node.Parent),
				OldNextSibling: next,
			}
			// Expected post-move location, computed with the executor's
			// own insertion semantics.
			siblings, err = tx.Children(ctx, c.SpaceID, c.Parent)
			if err != nil {
				return nil, err
			}
			base := siblings[:0]
			for _, s := range siblings {
				if s.ID != c.NodeID {
					base = append(base, s)
				}
			}
			at := len(base)
			if c.BeforeID != nil {
				for i, s := range base {
					if s.ID == *c.BeforeID {
						at = i
						break
					}
				}
			}
			entry.ExpectedParent = parentToWire(c.Parent)
			entry.ExpectedPosition = int64(at)
			entry.HasExpected = true
			entries = append(entries, entry)
		case DeleteNode:
			// Full subtree before-image, structured for top-down restore.
			node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
			if err != nil {
				return nil, err
			}
			subtree, err := captureSubtree(ctx, tx, c.SpaceID, node.Parent, c.NodeID)
			if err != nil {
				return nil, err
			}
			entries = append(entries, undoEntry{Kind: "delete", NodeID: string(c.NodeID), Subtree: subtree})
		default:
			return nil, fmt.Errorf("changeset: no before-image for %T", cmd)
		}
	}
	return entries, nil
}

// captureSubtree walks the subtree in restore order (parents before
// children, siblings in original order) recording placement.
func captureSubtree(ctx context.Context, tx Tx, space SpaceID, topParent ParentRef, topID NodeID) ([]restoredNode, error) {
	var out []restoredNode
	var walk func(parent ParentRef, id NodeID) error
	walk = func(parent ParentRef, id NodeID) error {
		node, err := tx.LoadNode(ctx, space, id)
		if err != nil {
			return err
		}
		siblings, err := tx.Children(ctx, space, node.Parent)
		if err != nil {
			return err
		}
		var next string
		for _, s := range siblings {
			if s.Position > node.Position {
				next = string(s.ID)
				break
			}
		}
		out = append(out, restoredNode{
			ID:          string(node.ID),
			Type:        node.Type,
			Title:       node.Title,
			URL:         node.URL,
			Parent:      parentToWire(parent),
			Position:    node.Position,
			NextSibling: next,
		})
		children, err := tx.Children(ctx, space, NewNodeParent(id))
		if err != nil {
			return err
		}
		for _, child := range children {
			if err := walk(NewNodeParent(id), child.ID); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(topParent, topID); err != nil {
		return nil, err
	}
	return out, nil
}

// ApplyTxChangeSet executes the commands as one ChangeSet inside the
// caller's transaction: the before-image is captured, the commands and
// journal rows (linked via Origin.ChangeSetID) commit atomically, and
// the undo data is stored alongside (doc 15 §13). When the commands
// produce no canonical change (all no-ops), no ChangeSet is recorded.
func (e *Executor) ApplyTxChangeSet(ctx context.Context, tx Tx, origin Origin, space SpaceID, input ChangeSetInput, cmds ...Command) (ChangeSet, error) {
	if len(cmds) == 0 {
		return ChangeSet{}, errors.New("changeset: no commands")
	}
	head, err := tx.LoadSpace(ctx, space)
	if err != nil {
		return ChangeSet{}, err
	}
	before := head.CurrentRevision

	entries, err := captureBeforeImage(ctx, tx, cmds)
	if err != nil {
		return ChangeSet{}, err
	}

	csID, err := uuid.NewV7()
	if err != nil {
		return ChangeSet{}, err
	}
	linked := origin
	linked.ChangeSetID = csID.String()

	if err := e.ApplyTx(ctx, tx, linked, cmds...); err != nil {
		return ChangeSet{}, err
	}

	after, err := tx.LoadSpace(ctx, space)
	if err != nil {
		return ChangeSet{}, err
	}
	if after.CurrentRevision == before {
		// Nothing changed (all no-ops): no user-facing activity.
		return ChangeSet{}, nil
	}

	cs := ChangeSet{
		ID:            csID.String(),
		SpaceID:       space,
		ActorType:     linked.Type,
		ActorUserID:   linked.UserID,
		ActorDeviceID: linked.DeviceID,
		Kind:          input.Kind,
		Summary:       input.Summary,
		FirstRevision: before + 1,
		LastRevision:  after.CurrentRevision,
		InverseOf:     input.InverseOf,
		CreatedAt:     time.Now().UTC(),
	}
	if err := tx.InsertChangeSet(ctx, cs); err != nil {
		return ChangeSet{}, err
	}
	payload, err := json.Marshal(undoPayload{Format: undoFormatVersion, Entries: entries})
	if err != nil {
		return ChangeSet{}, err
	}
	if err := tx.InsertUndoData(ctx, UndoData{
		ChangeSetID:   cs.ID,
		FormatVersion: undoFormatVersion,
		Codec:         "json",
		Payload:       payload,
		ExpiresAt:     cs.CreatedAt.Add(UndoRetention),
		CreatedAt:     cs.CreatedAt,
	}); err != nil {
		return ChangeSet{}, err
	}
	return cs, nil
}

// ExecuteChangeSet is the transactional wrapper of ApplyTxChangeSet for
// callers that do not hold a transaction.
func (e *Executor) ExecuteChangeSet(ctx context.Context, store Store, origin Origin, space SpaceID, input ChangeSetInput, cmds ...Command) (ChangeSet, error) {
	tx, err := store.BeginTx(ctx)
	if err != nil {
		return ChangeSet{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	cs, err := e.ApplyTxChangeSet(ctx, tx, origin, space, input, cmds...)
	if err != nil {
		return ChangeSet{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ChangeSet{}, err
	}
	committed = true
	return cs, nil
}

// UndoData is the stored before-image of a ChangeSet.
type UndoData struct {
	ChangeSetID   string
	FormatVersion int
	Codec         string
	Payload       []byte
	ExpiresAt     time.Time
	CreatedAt     time.Time
}

func (u UndoData) decode() (undoPayload, error) {
	var p undoPayload
	if err := json.Unmarshal(u.Payload, &p); err != nil {
		return undoPayload{}, fmt.Errorf("changeset: decode undo data: %w", err)
	}
	if p.Format != undoFormatVersion {
		return undoPayload{}, fmt.Errorf("changeset: unsupported undo format %d", p.Format)
	}
	return p, nil
}
