package reconcile

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"pontis/internal/canonical"
)

// Kind enumerates the planned primitive operations (doc 07 §7).
type Kind string

const (
	KindCreate      Kind = "create"
	KindUpdateTitle Kind = "update_title"
	KindUpdateURL   Kind = "update_url"
	KindMove        Kind = "move"
	KindDelete      Kind = "delete"
)

// Primitive is one planned tree mutation. NodeID is the ref of the node
// in the identity space being planned: canonical ids for the canonical
// plan, session-local local_refs for client steps. Parent and BeforeID
// always refer to the desired (canonical) space.
type Primitive struct {
	Kind      Kind
	NodeID    string
	Type      NodeType // create only
	Title     string   // create, update_title
	URL       string   // create, update_url
	Parent    canonical.ParentRef
	BeforeID  string // create, move; empty means append
	SourceRef string // client linkage carried by the desired node
}

// Stats summarizes a plan.
type Stats struct {
	Creates int
	Updates int
	Moves   int
	Deletes int
}

// Plan is a first-class apply plan (doc 07 §11): the ordered operations
// that transform the current tree into the desired tree, plus enough
// metadata to detect staleness at commit time.
type Plan struct {
	Strategy   Strategy
	Placement  Placement
	Operations []Primitive
	Stats      Stats
	Warnings   []string
	Hash       string
}

// Hash binds the plan content to a stable digest.
func (p *Plan) computeHash() string {
	var b strings.Builder
	b.WriteString(string(p.Strategy))
	b.WriteByte(0)
	b.WriteString(string(p.Placement))
	b.WriteByte(0)
	for _, op := range p.Operations {
		b.WriteString(string(op.Kind))
		b.WriteByte(0x1f)
		b.WriteString(op.NodeID)
		b.WriteByte(0x1f)
		b.WriteString(string(op.Type))
		b.WriteByte(0x1f)
		b.WriteString(op.Title)
		b.WriteByte(0x1f)
		b.WriteString(op.URL)
		b.WriteByte(0x1f)
		b.WriteString(parentKey(op.Parent))
		b.WriteByte(0x1f)
		b.WriteString(op.BeforeID)
		b.WriteByte(0x1f)
		b.WriteString(op.SourceRef)
		b.WriteByte(0x1e)
	}
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:])
}

func parentKey(p canonical.ParentRef) string {
	switch p.Type {
	case canonical.ParentTypeNode:
		return "n:" + string(p.NodeID)
	case canonical.ParentTypeRoot:
		return "r:" + p.RootKey
	default:
		return ""
	}
}

// parentRef maps a desired container ref to a canonical parent reference.
func parentRef(container string) canonical.ParentRef {
	if isRootRef(container) {
		return canonical.NewRootParent(container[5:])
	}
	return canonical.NewNodeParent(canonical.NodeID(container))
}

// deleteCount returns the number of nodes a delete removes; the planner
// uses subtree sizes supplied by the caller only for warnings, so a flat
// count of emitted deletes is reported here.
func planWarnings(p *Plan, deleteRoots int) []string {
	var warnings []string
	if deleteRoots > 0 {
		warnings = append(warnings,
			"plan deletes "+strconv.Itoa(deleteRoots)+" top-level subtrees")
	}
	return warnings
}
