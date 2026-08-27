// Package sync implements the server side of the /sync replica protocol:
// client operation intake with idempotent receipts, conflict decision
// based on field-level revision causality, and the canonical change
// stream. All tree mutations go through the canonical executor.
package sync

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"pontis/internal/canonical"
)

// ProtocolVersion is the wire protocol version implemented here.
const ProtocolVersion = 1

// DefaultMaxChanges caps a change stream page when the request omits it.
const DefaultMaxChanges = 500

// OpType is the type of a client operation intent.
type OpType string

const (
	OpCreate      OpType = "create"
	OpUpdateTitle OpType = "update_title"
	OpUpdateURL   OpType = "update_url"
	OpMove        OpType = "move"
	OpDelete      OpType = "delete"
)

// Operation is the client operation envelope. BaseRevision is the world
// the client actually saw when the intent was created; it is never
// rewritten, even after more changes arrive.
type Operation struct {
	OpID         string
	ClientSeq    int64
	BaseRevision int64
	Type         OpType
	NodeID       canonical.NodeID
	NodeType     canonical.NodeType  // create only
	Title        string              // create, update_title
	URL          string              // create, update_url
	Parent       canonical.ParentRef // create, move
	BeforeID     *canonical.NodeID   // create, move; nil means append
}

// OpStatus is the business outcome of an operation.
type OpStatus string

const (
	StatusApplied   OpStatus = "APPLIED"
	StatusRebased   OpStatus = "REBASED"
	StatusNoop      OpStatus = "NOOP"
	StatusConflict  OpStatus = "CONFLICT"
	StatusRejected  OpStatus = "REJECTED"
	StatusRecovered OpStatus = "RECOVERED"
)

// Reason codes attached to operation results.
const (
	ReasonConcurrentUpdate = "concurrent_update"
	ReasonConcurrentMove   = "concurrent_move"
	ReasonTargetDeleted    = "target_deleted"
	ReasonParentDeleted    = "parent_deleted"
	ReasonAlreadyDeleted   = "already_deleted"
	ReasonAlreadyExists    = "already_exists"
	ReasonAlreadyInPlace   = "already_in_place"
	ReasonInvalidTarget    = "invalid_target"
	ReasonInvalidParent    = "invalid_parent"
	ReasonParentNotFolder  = "parent_not_folder"
	ReasonInvalidAnchor    = "invalid_anchor"
	ReasonAnchorDeleted    = "anchor_deleted"
	ReasonAnchorMoved      = "anchor_moved"
	ReasonTreeCycle        = "tree_cycle"
	ReasonInvalidPayload   = "invalid_payload"
	ReasonNotBookmark      = "not_bookmark"
)

// OperationResult is the per-operation outcome returned to the client.
// SettleAfterRevision tells the client which canonical revision it must
// apply before it may safely drop the pending operation.
type OperationResult struct {
	OpID                string
	ClientSeq           int64
	Status              OpStatus
	Reason              string
	ResultRevision      int64
	SettleAfterRevision int64
}

// Receipt is the idempotency record of a processed operation.
type Receipt struct {
	BindingID           string
	OpID                string
	ClientSeq           int64
	RequestEpoch        int64
	BaseRevision        int64
	RequestHash         string
	Status              OpStatus
	Reason              string
	ResultRevision      int64
	SettleAfterRevision int64
	ProcessedAtRevision int64
	CreatedAt           string
}

// JournalChange is one entry of the canonical change stream. PayloadJSON
// is the stored wire payload, passed through verbatim.
type JournalChange struct {
	Revision    int64
	Type        string
	NodeID      string
	PayloadJSON string
}

// Tombstone records the deletion point of a node.
type Tombstone struct {
	Epoch    int64
	Revision int64
}

// SyncRequest is a full /sync round request.
type SyncRequest struct {
	ProtocolVersion  int
	DeviceID         canonical.DeviceID
	DeviceName       string // informational, used for recovery labels
	SpaceID          canonical.SpaceID
	Epoch            int64
	AppliedRevision  int64
	ReceivedRevision int64
	Operations       []Operation
	MaxChanges       int
}

// SyncResponse is a full /sync round response.
type SyncResponse struct {
	ProtocolVersion      int
	Epoch                int64
	JournalFloorRevision int64
	FromRevision         int64
	ThroughRevision      int64
	ServerRevision       int64
	HasMore              bool
	OperationResults     []OperationResult
	Changes              []JournalChange
}

// operationHash is the idempotency fingerprint of an operation envelope.
func operationHash(op Operation) string {
	var b strings.Builder
	write := func(v string) {
		b.WriteString(v)
		b.WriteByte(0)
	}
	write(op.OpID)
	write(strconv.FormatInt(op.ClientSeq, 10))
	write(strconv.FormatInt(op.BaseRevision, 10))
	write(string(op.Type))
	write(string(op.NodeID))
	write(string(op.NodeType))
	write(op.Title)
	write(op.URL)
	write(string(op.Parent.Type))
	write(string(op.Parent.NodeID))
	write(op.Parent.RootKey)
	if op.BeforeID != nil {
		write(string(*op.BeforeID))
	} else {
		write("")
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}
