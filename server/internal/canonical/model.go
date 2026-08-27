package canonical

import "time"

// NodeType is the immutable node type. Changing type means DELETE + CREATE.
type NodeType string

const (
	// NodeTypeFolder is a container node; its URL must be empty.
	NodeTypeFolder NodeType = "folder"
	// NodeTypeBookmark is a leaf node with a non-empty URL.
	NodeTypeBookmark NodeType = "bookmark"
)

// ParentType discriminates the ParentRef tagged union.
type ParentType string

const (
	// ParentTypeNode means the parent is a folder node.
	ParentTypeNode ParentType = "node"
	// ParentTypeRoot means the parent is a root slot.
	ParentTypeRoot ParentType = "root"
)

// ParentRef is the explicit parent of a node: either a folder node or a
// root slot. Exactly one of the two is set; nil ParentRef is not valid.
type ParentRef struct {
	Type    ParentType
	NodeID  NodeID
	RootKey string
}

// NewNodeParent returns a ParentRef pointing at a folder node.
func NewNodeParent(id NodeID) ParentRef {
	return ParentRef{Type: ParentTypeNode, NodeID: id}
}

// NewRootParent returns a ParentRef pointing at a root slot.
func NewRootParent(key string) ParentRef {
	return ParentRef{Type: ParentTypeRoot, RootKey: key}
}

// Node is a canonical bookmark tree node. Domain entity only: no JSON or DB
// tags; adapters map to DTOs and rows.
type Node struct {
	SpaceID           SpaceID
	ID                NodeID
	Type              NodeType
	Title             string
	URL               string // empty means NULL; required for bookmarks
	Parent            ParentRef
	Position          int64
	CreatedRevision   int64
	TitleRevision     int64
	URLRevision       int64
	StructureRevision int64
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

// RootSlot is an abstract mount position at the top of the canonical tree.
// It is not a Node.
type RootSlot struct {
	SpaceID     SpaceID
	Key         string
	DisplayName string
	Position    int64
	CreatedAt   time.Time
}

// SyncSpace is an independent canonical bookmark universe.
type SyncSpace struct {
	ID                   SpaceID
	OwnerUserID          UserID
	Name                 string
	Epoch                int64
	CurrentRevision      int64
	JournalFloorRevision int64
	CreatedAt            time.Time
	UpdatedAt            time.Time
}
