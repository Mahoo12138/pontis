package reconcile

import (
	"encoding/json"
	"fmt"

	"pontis/internal/canonical"
)

// Artifact codecs. The artifact content formats are part of this
// module's own contract (they are written and read back by the
// reconciliation service); the domain structs above stay tag-free.

// ClientSnapshotJSON is the client browser snapshot (doc 08 §10): only
// session-local local_refs cross the wire, never browser ids.
type ClientSnapshotJSON struct {
	Epoch    int64            `json:"epoch"`
	Revision int64            `json:"revision"`
	Roots    []ClientRootJSON `json:"roots"`
	Nodes    []ClientNodeJSON `json:"nodes"`
}

// ClientRootJSON is one browser root mapped onto a canonical root slot.
type ClientRootJSON struct {
	LocalRef string `json:"local_ref"`
	RootKey  string `json:"root_key"`
	Title    string `json:"title"`
}

// ClientNodeJSON is one browser node of the client snapshot.
type ClientNodeJSON struct {
	LocalRef       string `json:"local_ref"`
	ParentLocalRef string `json:"parent_local_ref"`
	Type           string `json:"type"`
	Title          string `json:"title"`
	URL            string `json:"url"`
	CanonicalID    string `json:"canonical_id,omitempty"`
}

// Tree projects the snapshot onto the engine's input tree.
func (c ClientSnapshotJSON) Tree() (*Tree, error) {
	nodes := make([]TreeNode, 0, len(c.Roots)+len(c.Nodes))
	for _, root := range c.Roots {
		nodes = append(nodes, TreeNode{
			Ref:     root.LocalRef,
			Type:    NodeRoot,
			RootKey: root.RootKey,
			Title:   root.Title,
		})
	}
	for _, node := range c.Nodes {
		var typ NodeType
		switch node.Type {
		case "folder":
			typ = NodeFolder
		case "bookmark":
			typ = NodeBookmark
		default:
			return nil, fmt.Errorf("reconcile: unknown node type %q", node.Type)
		}
		nodes = append(nodes, TreeNode{
			Ref:         node.LocalRef,
			ParentRef:   node.ParentLocalRef,
			Type:        typ,
			Title:       node.Title,
			URL:         node.URL,
			CanonicalID: node.CanonicalID,
		})
	}
	tr := &Tree{Nodes: nodes}
	if _, err := tr.index(); err != nil {
		return nil, err
	}
	return tr, nil
}

// ParentJSON is the wire form of a canonical parent reference.
type ParentJSON struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Key  string `json:"key,omitempty"`
}

func parentToJSON(p canonical.ParentRef) *ParentJSON {
	switch p.Type {
	case canonical.ParentTypeNode:
		return &ParentJSON{Type: "node", ID: string(p.NodeID)}
	case canonical.ParentTypeRoot:
		return &ParentJSON{Type: "root", Key: p.RootKey}
	default:
		return nil
	}
}

func parentFromJSON(p *ParentJSON) canonical.ParentRef {
	if p == nil {
		return canonical.ParentRef{}
	}
	if p.Type == "node" {
		return canonical.NewNodeParent(canonical.NodeID(p.ID))
	}
	return canonical.NewRootParent(p.Key)
}

// PrimitiveJSON is the artifact form of a planned primitive.
type PrimitiveJSON struct {
	Kind      Kind        `json:"kind"`
	NodeID    string      `json:"node_id"`
	Type      NodeType    `json:"type,omitempty"`
	Title     string      `json:"title,omitempty"`
	URL       string      `json:"url,omitempty"`
	Parent    *ParentJSON `json:"parent,omitempty"`
	BeforeID  string      `json:"before_id,omitempty"`
	SourceRef string      `json:"source_ref,omitempty"`
}

// StatsJSON is the artifact form of plan stats.
type StatsJSON struct {
	Creates int `json:"creates"`
	Updates int `json:"updates"`
	Moves   int `json:"moves"`
	Deletes int `json:"deletes"`
}

// PlanArtifactJSON is the stored plan (doc 07 §11): operations bound to
// the base epoch/revision they were computed against plus the plan hash
// verified at commit time.
type PlanArtifactJSON struct {
	Type         string          `json:"type"`
	Strategy     Strategy        `json:"strategy"`
	Placement    Placement       `json:"placement"`
	BaseEpoch    int64           `json:"base_epoch"`
	BaseRevision int64           `json:"base_revision"`
	PlanHash     string          `json:"plan_hash"`
	Operations   []PrimitiveJSON `json:"operations"`
	Stats        StatsJSON       `json:"stats"`
	Warnings     []string        `json:"warnings"`
}

// StepJSON is the artifact/wire form of a client apply step.
type StepJSON struct {
	Kind        StepKind    `json:"kind"`
	LocalRef    string      `json:"local_ref,omitempty"`
	CanonicalID string      `json:"canonical_id,omitempty"`
	Type        NodeType    `json:"type,omitempty"`
	Title       string      `json:"title,omitempty"`
	URL         string      `json:"url,omitempty"`
	Parent      *ParentJSON `json:"parent,omitempty"`
	BeforeID    string      `json:"before_id,omitempty"`
}

// StepsArtifactJSON is the stored client apply plan (doc 08 §13).
type StepsArtifactJSON struct {
	PlanHash string     `json:"plan_hash"`
	Steps    []StepJSON `json:"steps"`
}

// IssuePayloadJSON describes one ambiguity for the user (doc 18 §6).
type IssuePayloadJSON struct {
	SourceRef  string   `json:"source_ref"`
	Type       NodeType `json:"type"`
	Title      string   `json:"title"`
	URL        string   `json:"url"`
	Candidates []string `json:"candidates"`
}

func marshalJSON(v any) ([]byte, error) {
	return json.Marshal(v)
}

func unmarshalJSON(data []byte, v any) error {
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("reconcile: decode artifact: %w", err)
	}
	return nil
}
