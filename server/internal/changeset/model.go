// Package changeset implements ChangeSet-level undo and the activity
// history (doc 15). A ChangeSet is one user-facing business operation that
// aggregates one or many canonical journal entries. Undoable ChangeSets
// carry an atomic Before Image captured in the same transaction as the
// canonical mutation; undo NEVER rolls back revisions — it applies new
// inverse commands recorded as a fresh ChangeSet.
package changeset

import (
	"errors"
	"time"

	"pontis/internal/canonical"
)

// Kind classifies one ChangeSet (doc 15 §3).
type Kind string

const (
	// Primitive web/device node operations.
	KindNodeCreate Kind = "node_create"
	KindNodeUpdate Kind = "node_update"
	KindNodeMove   Kind = "node_move"
	KindNodeDelete Kind = "node_delete"
	// High-level operations aggregating many primitives (doc 15 §8).
	KindImport      Kind = "import"
	KindPublication Kind = "publication_apply"
	// Cross-space transfer sides (not undoable in V1: undo would be a
	// reverse transfer, a separate high-level operation).
	KindTransferIn  Kind = "transfer_in"
	KindTransferOut Kind = "transfer_out"
	// The inverse operation produced by Undo itself.
	KindUndo Kind = "undo"
)

// UndoWindow bounds how long a ChangeSet stays undoable. Activity rows
// survive longer (ActivityRetention, pruned by journal GC); past the window
// the UI shows the entry but the undo action is expired (doc 15 §12).
const (
	UndoWindow       = 30 * 24 * time.Hour
	ActivityRetention = 90 * 24 * time.Hour
)

// PlanStatus is the outcome of building an undo plan (doc 15 §8). V1 has no
// Force Undo: anything not clean is surfaced for human review.
type PlanStatus string

const (
	PlanClean          PlanStatus = "clean"
	PlanReviewRequired PlanStatus = "review_required"
	PlanNotUndoable    PlanStatus = "not_undoable"
	PlanExpired        PlanStatus = "expired"
)

// Errors surfaced to the HTTP layer.
var (
	// ErrChangeSetNotFound covers unknown ids and space mismatches.
	ErrChangeSetNotFound = errors.New("changeset: change set not found")
	// ErrAlreadyUndone rejects a second undo of the same ChangeSet.
	ErrAlreadyUndone = errors.New("changeset: already undone")
)

// ChangeSet is one committed user-facing operation. Journal entries link
// back via their change_set_id column.
type ChangeSet struct {
	ID                string
	SpaceID           canonical.SpaceID
	Epoch             int64
	Kind              Kind
	Summary           string
	OriginType        canonical.OriginType
	ActorUserID       canonical.UserID
	ActorDeviceID     canonical.DeviceID
	FirstRevision     int64
	LastRevision      int64
	InverseOf         string
	UndoDataJSON      string // empty = not undoable
	UndoneByChangeSet string
	UndoneAt          string
	CreatedAt         time.Time
}

// UndoResult reports an undo plan outcome; when Status is PlanClean the
// inverse commands were executed as the ChangeSet identified by ChangeSetID.
type UndoResult struct {
	Status      PlanStatus
	ChangeSetID string
	Summary     string
	Reasons     []string
}

// UndoData is the Before Image model persisted with an undoable ChangeSet.
// All sections are optional; an undoable ChangeSet has at least one.
type UndoData struct {
	// Field restores for UPDATE primitives (doc 15 §4).
	Updates []UpdateUndo `json:"updates,omitempty"`
	// Location restores for MOVE primitives (doc 15 §5).
	Moves []MoveUndo `json:"moves,omitempty"`
	// Nodes created by this ChangeSet; undo deletes them (doc 15 §6).
	Creates []CreateUndo `json:"creates,omitempty"`
	// Full subtree snapshots deleted by this ChangeSet; undo restores the
	// original canonical UUIDs (doc 15 §7).
	Deletes []SubtreeSnapshot `json:"deletes,omitempty"`
}

// UpdateUndo reverts one field edit. Undo only applies when the field is
// still ExpectedAfter; later edits force a review instead of overwriting.
type UpdateUndo struct {
	NodeID        canonical.NodeID `json:"node_id"`
	Field         string           `json:"field"` // title | url
	Title         string           `json:"title"` // node title at capture, for summaries
	Before        string           `json:"before"`
	ExpectedAfter string           `json:"expected_after"`
}

// MoveUndo restores one location change. If the node was moved again after
// this ChangeSet, undo does not drag it back (review required).
type MoveUndo struct {
	NodeID           canonical.NodeID `json:"node_id"`
	Title            string           `json:"title"`
	OldParent        wireParent       `json:"old_parent"`
	OldPosition      int64            `json:"old_position"`
	ExpectedParent   wireParent       `json:"expected_parent"`
	ExpectedPosition int64            `json:"expected_position"`
}

// CreateUndo marks a node created by this ChangeSet.
type CreateUndo struct {
	NodeID canonical.NodeID   `json:"node_id"`
	Type   canonical.NodeType `json:"type"`
	Title  string             `json:"title"`
}

// SubtreeSnapshot is the complete before image of one deleted subtree:
// node UUIDs, types, titles, urls, parent/order and structure (doc 15 §7).
type SubtreeSnapshot struct {
	Root     canonical.NodeID `json:"root"`
	Parent   wireParent       `json:"parent"`
	Position int64            `json:"position"`
	// Nodes in restore order: parents before children.
	Nodes []NodeSnapshot `json:"nodes"`
}

// NodeSnapshot is one node of a deleted subtree.
type NodeSnapshot struct {
	ID       canonical.NodeID   `json:"id"`
	Type     canonical.NodeType `json:"type"`
	Title    string             `json:"title"`
	URL      string             `json:"url"`
	Parent   wireParent         `json:"parent"`
	Position int64              `json:"position"`
}

// wireParent is the JSON representation of a canonical.ParentRef
// (the domain type stays tag-free): {"type":"node","id":...} or
// {"type":"root","key":...}.
type wireParent struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Key  string `json:"key,omitempty"`
}

func fromParent(p canonical.ParentRef) wireParent {
	if p.Type == canonical.ParentTypeNode {
		return wireParent{Type: "node", ID: string(p.NodeID)}
	}
	return wireParent{Type: "root", Key: p.RootKey}
}

func (w wireParent) toParent() canonical.ParentRef {
	if w.Type == string(canonical.ParentTypeNode) {
		return canonical.NewNodeParent(canonical.NodeID(w.ID))
	}
	return canonical.NewRootParent(w.Key)
}
