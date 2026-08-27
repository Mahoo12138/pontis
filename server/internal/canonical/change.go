package canonical

import "time"

// ChangeType is the kind of a committed Canonical Change.
type ChangeType string

const (
	ChangeTypeCreate      ChangeType = "create"
	ChangeTypeUpdateTitle ChangeType = "update_title"
	ChangeTypeUpdateURL   ChangeType = "update_url"
	ChangeTypeMove        ChangeType = "move"
	ChangeTypeDelete      ChangeType = "delete"
)

// OriginType identifies what caused a Canonical Change.
type OriginType string

const (
	OriginSystem   OriginType = "system"
	OriginUser     OriginType = "user"
	OriginDevice   OriginType = "device"
	OriginImport   OriginType = "import"
	OriginRecovery OriginType = "recovery"
)

// Origin records the causal source of a Canonical Change. Empty values map
// to NULL columns; it is used by the sync engine for same-binding
// causality and receipt bookkeeping.
type Origin struct {
	Type        OriginType
	UserID      UserID
	DeviceID    DeviceID
	BindingID   BindingID
	ClientSeq   *int64
	OpID        string
	ChangeSetID string
	RequestID   string
}

// Change is a committed Canonical Change. The journal persists the final
// server fact, never the raw client intent.
type Change struct {
	SpaceID   SpaceID
	Epoch     int64
	Revision  int64
	Type      ChangeType
	NodeID    NodeID
	Payload   any
	Origin    Origin
	CreatedAt time.Time
}

// CreatePayload carries the full created node state.
type CreatePayload struct {
	Type     NodeType
	Title    string
	URL      string
	Parent   ParentRef
	Position int64
}

// UpdateTitlePayload carries the new title.
type UpdateTitlePayload struct {
	Title string
}

// UpdateURLPayload carries the new URL.
type UpdateURLPayload struct {
	URL string
}

// MovePayload carries the new parent and position.
type MovePayload struct {
	Parent   ParentRef
	Position int64
}

// DeletePayload carries the subtree size of the recursive delete.
type DeletePayload struct {
	Count int64
}
