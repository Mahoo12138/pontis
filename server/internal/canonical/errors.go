package canonical

import "errors"

// Domain errors. They carry no HTTP semantics; the HTTP layer maps them.
var (
	// ErrSpaceNotFound is returned when the referenced Sync Space does not exist.
	ErrSpaceNotFound = errors.New("canonical: sync space not found")

	// ErrNodeNotFound is returned when the referenced node does not exist.
	ErrNodeNotFound = errors.New("canonical: node not found")

	// ErrRootSlotNotFound is returned when the referenced root slot does not exist.
	ErrRootSlotNotFound = errors.New("canonical: root slot not found")

	// ErrParentNotFolder is returned when a parent node is not a folder.
	ErrParentNotFolder = errors.New("canonical: parent must be a folder")

	// ErrNodeIsSelf is returned when a node is used as its own parent.
	ErrNodeIsSelf = errors.New("canonical: node cannot be its own parent")

	// ErrTreeCycle is returned when moving a folder under its own descendant.
	ErrTreeCycle = errors.New("canonical: move would create a cycle")

	// ErrURLRequired is returned when a bookmark is created without a URL.
	ErrURLRequired = errors.New("canonical: bookmark requires a url")

	// ErrURLNotAllowed is returned when a folder is given a URL.
	ErrURLNotAllowed = errors.New("canonical: folder cannot have a url")

	// ErrTitleRequired is returned when a title is empty.
	ErrTitleRequired = errors.New("canonical: title must not be empty")

	// ErrParentMissing is returned when a command carries no valid ParentRef.
	ErrParentMissing = errors.New("canonical: parent ref must be set")

	// ErrNodeIsBookmark is returned when a bookmark is used where a folder is required.
	ErrNodeIsBookmark = errors.New("canonical: node is a bookmark, not a folder")
)
