package reconcile

import "pontis/internal/canonical"

// StepKind enumerates the client apply steps (doc 08 §13). The server
// computes them so the extension never implements a tree planner.
type StepKind string

const (
	// StepAssignIdentity only establishes the local_ref → canonical_id
	// mapping; it never touches the browser tree.
	StepAssignIdentity StepKind = "assign_identity"
	StepCreate         StepKind = "create"
	StepUpdate         StepKind = "update"
	StepMove           StepKind = "move"
	StepDelete         StepKind = "delete"
)

// Step is one client apply step. Parent and BeforeID refer to the
// canonical space (root keys and canonical ids) and are resolved by the
// client through its mapping. Create/move/delete/update steps carry
// Ensure-State semantics: re-applying an already applied step is a no-op.
type Step struct {
	Kind        StepKind
	LocalRef    string // client-side node, empty for creates
	CanonicalID string // canonical identity, always set except for deletes
	Type        NodeType
	Title       string
	URL         string
	Parent      canonical.ParentRef
	BeforeID    string
}

// DeriveClientSteps computes the steps that turn the client browser tree
// into the desired tree: identity assignments first (parents before
// children), then creates, updates, moves and deletes.
//
// The resolver defines the client identity space: initial and recovery
// sessions correspond through the desired tree's source refs (the client
// snapshot IS the source), while full resync corresponds through the
// canonical ids the client snapshot carries.
func DeriveClientSteps(client *Tree, desired *DesiredTree, policy Policy, resolver identityResolver) ([]Step, error) {
	idx, err := client.index()
	if err != nil {
		return nil, err
	}

	steps := make([]Step, 0, len(desired.Nodes))

	// assign_identity for every desired node the browser already holds
	// under a local ref. Fresh server-side nodes arrive via create steps.
	for _, container := range desired.Containers() {
		for _, id := range desired.Children(container) {
			d := desired.Nodes[id]
			if d.SourceRef == "" {
				continue
			}
			if cn, exists := idx.byRef[d.SourceRef]; exists && cn.CanonicalID == d.ID {
				continue // mapping already known to the client
			}
			steps = append(steps, Step{
				Kind:        StepAssignIdentity,
				LocalRef:    d.SourceRef,
				CanonicalID: d.ID,
			})
		}
	}

	// Diff the browser tree against the desired tree in client identity
	// space and translate the primitives into steps.
	p, err := BuildPlan(client, desired, policy, resolver)
	if err != nil {
		return nil, err
	}

	// Coalesce the split field updates of one node into a single step.
	// canonicalByRef helps the client resolve a step's node: a local ref
	// that carries a known canonical id, a source-linked desired node, or
	// a node this very plan created (identified by its canonical id).
	canonicalByRef := map[string]string{}
	for _, node := range client.Nodes {
		if node.CanonicalID != "" {
			canonicalByRef[node.Ref] = node.CanonicalID
		}
	}
	for _, d := range desired.Nodes {
		if d.SourceRef != "" {
			canonicalByRef[d.SourceRef] = d.ID
		}
	}
	canonicalFor := func(ref string) string {
		if cid, ok := canonicalByRef[ref]; ok {
			return cid
		}
		if _, isDesiredID := desired.Nodes[ref]; isDesiredID {
			return ref // freshly created in this plan
		}
		return ""
	}
	updateIndex := map[string]int{} // local ref → step index
	for _, op := range p.Operations {
		switch op.Kind {
		case KindCreate:
			steps = append(steps, Step{
				Kind:        StepCreate,
				CanonicalID: op.NodeID,
				Type:        op.Type,
				Title:       op.Title,
				URL:         op.URL,
				Parent:      op.Parent,
				BeforeID:    op.BeforeID,
			})
		case KindUpdateTitle, KindUpdateURL:
			i, ok := updateIndex[op.NodeID]
			if !ok {
				steps = append(steps, Step{
					Kind:        StepUpdate,
					LocalRef:    op.NodeID,
					CanonicalID: canonicalFor(op.NodeID),
				})
				i = len(steps) - 1
				updateIndex[op.NodeID] = i
			}
			if op.Kind == KindUpdateTitle {
				steps[i].Title = op.Title
			} else {
				steps[i].URL = op.URL
			}
		case KindMove:
			steps = append(steps, Step{
				Kind:        StepMove,
				LocalRef:    op.NodeID,
				CanonicalID: canonicalFor(op.NodeID),
				Parent:      op.Parent,
				BeforeID:    op.BeforeID,
			})
		case KindDelete:
			steps = append(steps, Step{
				Kind:        StepDelete,
				LocalRef:    op.NodeID,
				CanonicalID: canonicalFor(op.NodeID),
			})
		}
	}
	return steps, nil
}
