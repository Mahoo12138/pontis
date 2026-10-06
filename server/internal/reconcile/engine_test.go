package reconcile

import (
	"errors"
	"testing"
)

func mustTree(t *testing.T, nodes []TreeNode) *Tree {
	t.Helper()
	tr := &Tree{Nodes: nodes}
	if _, err := tr.index(); err != nil {
		t.Fatalf("invalid test tree: %v", err)
	}
	return tr
}

// n builds a folder/bookmark node; root nodes use r().
func n(ref, parent, typ, title, url string) TreeNode {
	return TreeNode{Ref: ref, ParentRef: parent, Type: NodeType(typ), Title: title, URL: url}
}

func r(ref, key, title string) TreeNode {
	return TreeNode{Ref: ref, Type: NodeRoot, RootKey: key, Title: title}
}

// withCID sets a canonical identity on a node.
func withCID(node TreeNode, cid string) TreeNode {
	node.CanonicalID = cid
	return node
}

func containsRef(refs []string, want string) bool {
	for _, r := range refs {
		if r == want {
			return true
		}
	}
	return false
}

// fixedIDs returns a deterministic id generator for tests.
func fixedIDs(prefix string) IDGenerator {
	i := 0
	return func() (string, error) { i++; return prefix + string(rune('a'+i-1)), nil }
}

// --- matchers ---

func TestMatchExactParentAware(t *testing.T) {
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_f1", "l_root", "folder", "Development", ""),
		n("l_b1", "l_f1", "bookmark", "GitHub", "https://github.com"),
	})
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("t_f1", "root:main", "folder", "Development", ""),
		n("t_b1", "t_f1", "bookmark", "GitHub mirror", "https://github.com"),
	})
	m, err := MatchExact(source, target)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	if m.BySource["l_root"] != "root:main" || m.BySource["l_f1"] != "t_f1" || m.BySource["l_b1"] != "t_b1" {
		t.Fatalf("expected full match, got %+v", m.BySource)
	}
	// The bookmark matched by URL despite the different title: exact URL
	// identity, source state wins later.
	if len(m.SourceOnly) != 0 || len(m.TargetOnly) != 0 || len(m.Ambiguous) != 0 {
		t.Fatalf("unexpected residuals: %+v", m)
	}
}

func TestMatchExactNoCrossParentInference(t *testing.T) {
	// Same title under different parents must not match (doc 06 §6).
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_a", "l_root", "folder", "Work", ""),
		n("l_x", "l_a", "folder", "GitHub", ""),
	})
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("t_b", "root:main", "folder", "Personal", ""),
		n("t_x", "t_b", "folder", "GitHub", ""),
	})
	m, err := MatchExact(source, target)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	if _, ok := m.BySource["l_x"]; ok {
		t.Fatal("cross-parent folder must not be matched")
	}
	if m.Status("l_x") != SourceOnly {
		t.Fatalf("l_x=%v, want source_only", m.Status("l_x"))
	}
	if !containsRef(m.TargetOnly, "t_x") {
		t.Fatalf("t_x must be target_only, got %+v", m.TargetOnly)
	}
}

func TestMatchExactAmbiguityNotGuessed(t *testing.T) {
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_b1", "l_root", "bookmark", "Same", "https://x.example"),
	})
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("t_b1", "root:main", "bookmark", "First", "https://x.example"),
		n("t_b2", "root:main", "bookmark", "Second", "https://x.example"),
	})
	m, err := MatchExact(source, target)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	if m.Status("l_b1") != Ambiguous {
		t.Fatalf("status = %v, want ambiguous", m.Status("l_b1"))
	}
	if len(m.Ambiguous) != 1 || len(m.Ambiguous[0].Candidates) != 2 {
		t.Fatalf("ambiguous candidates: %+v", m.Ambiguous)
	}
}

func TestMatchByCanonicalIDAcrossParents(t *testing.T) {
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_b1", "l_root", "bookmark", "GitHub", "https://github.com"),
	})
	// The target counterpart sits under a different parent: ID matching
	// is parent-agnostic (doc 07 §3).
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("t_other", "root:main", "folder", "Elsewhere", ""),
		n("t_b1", "t_other", "bookmark", "GitHub", "https://github.com"),
	})
	target.Nodes[2].CanonicalID = "c1"
	source.Nodes[1].CanonicalID = "c1"
	m, err := MatchByCanonicalID(source, target)
	if err != nil {
		t.Fatalf("MatchByCanonicalID: %v", err)
	}
	if m.BySource["l_b1"] != "t_b1" {
		t.Fatalf("expected id match, got %+v", m.BySource)
	}
}

// --- desired tree ---

func TestBuildDesiredMergeKeepsTargetOnly(t *testing.T) {
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_b1", "l_root", "bookmark", "GitHub", "https://github.com"),
	})
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		withCID(n("t_b1", "root:main", "bookmark", "GitHub", "https://github.com"), "t_b1"),
		withCID(n("t_b2", "root:main", "bookmark", "Server only", "https://server.example"), "t_b2"),
	})
	m, err := MatchExact(source, target)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	d, err := BuildDesired(m, Policy{Strategy: StrategyMerge}, nil, fixedIDs("new_"))
	if err != nil {
		t.Fatalf("BuildDesired: %v", err)
	}
	// Matched keeps its canonical id and the source title.
	got := d.Nodes["t_b1"]
	if got == nil || got.Title != "GitHub" || got.SourceRef != "l_b1" {
		t.Fatalf("matched node: %+v", got)
	}
	// Target-only node is kept after the source-derived children.
	order := d.Children(RootRef("main"))
	if len(order) != 2 || order[0] != "t_b1" || order[1] != "t_b2" {
		t.Fatalf("desired order: %v", order)
	}
	if d.Nodes["t_b2"].SourceRef != "" {
		t.Fatalf("kept node should not carry a source ref: %+v", d.Nodes["t_b2"])
	}
}

func TestBuildDesiredReplaceDropsTargetOnly(t *testing.T) {
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_b1", "l_root", "bookmark", "Fresh", "https://fresh.example"),
	})
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		withCID(n("t_b1", "root:main", "bookmark", "Old", "https://old.example"), "t_b1"),
	})
	m, err := MatchExact(source, target)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	d, err := BuildDesired(m, Policy{Strategy: StrategyReplace}, nil, fixedIDs("new_"))
	if err != nil {
		t.Fatalf("BuildDesired: %v", err)
	}
	if _, exists := d.Nodes["t_b1"]; exists {
		t.Fatal("replace must drop target-only nodes from the desired tree")
	}
}

func TestBuildDesiredPreserveKeepsTargetState(t *testing.T) {
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_b1", "l_root", "bookmark", "Local title", "https://x.example"),
	})
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		withCID(n("t_b1", "root:main", "bookmark", "Server title", "https://x.example"), "t_b1"),
	})
	m, err := MatchExact(source, target)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	d, err := BuildDesired(m, Policy{Strategy: StrategyPreserve}, nil, fixedIDs("new_"))
	if err != nil {
		t.Fatalf("BuildDesired: %v", err)
	}
	if d.Nodes["t_b1"].Title != "Server title" {
		t.Fatalf("preserve must keep the target state, got %+v", d.Nodes["t_b1"])
	}
}

func TestBuildDesiredDecisions(t *testing.T) {
	source := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_b1", "l_root", "bookmark", "Same", "https://x.example"),
	})
	target := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		withCID(n("t_b1", "root:main", "bookmark", "First", "https://x.example"), "t_b1"),
		withCID(n("t_b2", "root:main", "bookmark", "Second", "https://x.example"), "t_b2"),
	})
	m, err := MatchExact(source, target)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	// User picks t_b2 as the real counterpart.
	d, err := BuildDesired(m, Policy{Strategy: StrategyMerge}, Decisions{"l_b1": "t_b2"}, fixedIDs("new_"))
	if err != nil {
		t.Fatalf("BuildDesired: %v", err)
	}
	if d.Nodes["t_b2"] == nil || d.Nodes["t_b2"].SourceRef != "l_b1" {
		t.Fatalf("decision must link l_b1 to t_b2: %+v", d.Nodes["t_b2"])
	}
	if _, exists := d.Nodes["t_b1"]; !exists {
		t.Fatal("merge must still keep the unmatched t_b1")
	}

	// An invalid decision is rejected, never guessed.
	if _, err := BuildDesired(m, Policy{Strategy: StrategyMerge}, Decisions{"l_b1": "root:main"}, fixedIDs("new_")); !errors.Is(err, ErrDecisionInvalid) {
		t.Fatalf("want ErrDecisionInvalid, got %v", err)
	}
}

// --- planner ---

func TestBuildPlanUpdateOnlyForFieldChange(t *testing.T) {
	// Doc 07 §7: a changed field yields UPDATE, not delete+create.
	current := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("c1", "root:main", "bookmark", "Old title", "https://x.example"),
	})
	desired := &DesiredTree{
		Nodes: map[string]*DesiredNode{
			"c1": {ID: "c1", ParentRef: RootRef("main"), Type: NodeBookmark, Title: "New title", URL: "https://x.example"},
		},
		Order: map[string][]string{RootRef("main"): {"c1"}},
	}
	p, err := BuildPlan(current, desired, Policy{Strategy: StrategyMerge}, newCanonicalIdentity(current))
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if p.Stats.Updates != 1 || p.Stats.Creates != 0 || p.Stats.Moves != 0 || p.Stats.Deletes != 0 {
		t.Fatalf("stats: %+v", p.Stats)
	}
	if p.Operations[0].Kind != KindUpdateTitle || p.Operations[0].Title != "New title" {
		t.Fatalf("operation: %+v", p.Operations[0])
	}
	if p.Hash == "" {
		t.Fatal("plan hash missing")
	}
}

func TestBuildPlanFolderMoveSparesDescendants(t *testing.T) {
	// Doc 07 §7: moving a folder must not emit moves for descendants.
	current := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("f1", "root:main", "folder", "Src", ""),
		n("f2", "root:main", "folder", "Dst", ""),
		n("b1", "f1", "bookmark", "Deep", "https://deep.example"),
	})
	desired := &DesiredTree{
		Nodes: map[string]*DesiredNode{
			"f1": {ID: "f1", ParentRef: "f2", Type: NodeFolder, Title: "Src", SourceRef: "s1"},
			"f2": {ID: "f2", ParentRef: RootRef("main"), Type: NodeFolder, Title: "Dst"},
			"b1": {ID: "b1", ParentRef: "f1", Type: NodeBookmark, Title: "Deep", URL: "https://deep.example"},
		},
		Order: map[string][]string{
			RootRef("main"): {"f2"},
			"f2":            {"f1"},
			"f1":            {"b1"},
		},
	}
	p, err := BuildPlan(current, desired, Policy{Strategy: StrategyMerge}, newCanonicalIdentity(current))
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if p.Stats.Moves != 1 {
		t.Fatalf("want exactly one move, got %+v", p.Stats)
	}
	if p.Operations[0].Kind != KindMove || p.Operations[0].NodeID != "f1" || p.Operations[0].Parent.NodeID != "f2" {
		t.Fatalf("move: %+v", p.Operations[0])
	}
}

func TestBuildPlanLISMinimizesReorder(t *testing.T) {
	// Doc 07 §8: reorder [a,b,c] → [c,a,b] keeps the LIS (a,b) and moves
	// only c.
	current := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("a", "root:main", "bookmark", "A", "https://a.example"),
		n("b", "root:main", "bookmark", "B", "https://b.example"),
		n("c", "root:main", "bookmark", "C", "https://c.example"),
	})
	desired := &DesiredTree{
		Nodes: map[string]*DesiredNode{
			"a": {ID: "a", ParentRef: RootRef("main"), Type: NodeBookmark, Title: "A", URL: "https://a.example"},
			"b": {ID: "b", ParentRef: RootRef("main"), Type: NodeBookmark, Title: "B", URL: "https://b.example"},
			"c": {ID: "c", ParentRef: RootRef("main"), Type: NodeBookmark, Title: "C", URL: "https://c.example"},
		},
		Order: map[string][]string{RootRef("main"): {"c", "a", "b"}},
	}
	p, err := BuildPlan(current, desired, Policy{Strategy: StrategyMerge}, newCanonicalIdentity(current))
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if p.Stats.Moves != 1 {
		t.Fatalf("want one move, got %+v operations=%+v", p.Stats, p.Operations)
	}
	if p.Operations[0].NodeID != "c" {
		t.Fatalf("the moved node should be c: %+v", p.Operations[0])
	}
}

func TestBuildPlanProtectedDescendant(t *testing.T) {
	// Doc 07 §9: replace deletes a target-only folder that holds a
	// matched descendant; the survivor must move out first.
	current := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("old", "root:main", "folder", "Old", ""),
		n("survivor", "old", "bookmark", "Keep me", "https://keep.example"),
		n("junk", "old", "bookmark", "Junk", "https://junk.example"),
	})
	// The survivor is matched by canonical id; its parent is not.
	current.Nodes[2].CanonicalID = "c-survivor"
	desired := &DesiredTree{
		Nodes: map[string]*DesiredNode{
			"c-survivor": {ID: "c-survivor", ParentRef: RootRef("main"), Type: NodeBookmark, Title: "Keep me", URL: "https://keep.example", SourceRef: "s1"},
			"new_f":      {ID: "new_f", ParentRef: RootRef("main"), Type: NodeFolder, Title: "Fresh", SourceRef: "s2"},
			"new_b":      {ID: "new_b", ParentRef: "new_f", Type: NodeBookmark, Title: "Fresh link", URL: "https://fresh.example", SourceRef: "s3"},
		},
		Order: map[string][]string{
			RootRef("main"): {"c-survivor", "new_f"},
			"new_f":         {"new_b"},
		},
	}
	p, err := BuildPlan(current, desired, Policy{Strategy: StrategyReplace}, newCanonicalIdentity(current))
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	var moveSeen, deleteSeen bool
	for _, op := range p.Operations {
		switch op.Kind {
		case KindMove:
			if op.NodeID != "survivor" {
				t.Fatalf("survivor must move, got %+v", op)
			}
			moveSeen = true
		case KindDelete:
			if op.NodeID != "old" {
				t.Fatalf("only the old folder root may be deleted: %+v", op)
			}
			deleteSeen = true
		}
	}
	if !moveSeen || !deleteSeen {
		t.Fatalf("missing move/delete: %+v", p.Operations)
	}
	// Deletes come last.
	if p.Operations[len(p.Operations)-1].Kind != KindDelete {
		t.Fatalf("deletes must be emitted last: %+v", p.Operations)
	}
}

func TestBuildPlanNoOpPlan(t *testing.T) {
	current := mustTree(t, []TreeNode{
		r("root:main", "main", "Main"),
		n("b1", "root:main", "bookmark", "GitHub", "https://github.com"),
	})
	desired := &DesiredTree{
		Nodes: map[string]*DesiredNode{
			"b1": {ID: "b1", ParentRef: RootRef("main"), Type: NodeBookmark, Title: "GitHub", URL: "https://github.com"},
		},
		Order: map[string][]string{RootRef("main"): {"b1"}},
	}
	p, err := BuildPlan(current, desired, Policy{Strategy: StrategyMerge}, newCanonicalIdentity(current))
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if len(p.Operations) != 0 {
		t.Fatalf("identical trees must produce an empty plan: %+v", p.Operations)
	}
}
