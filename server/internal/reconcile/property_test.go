package reconcile

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"testing"

	"pontis/internal/canonical"
)

// simulator mirrors the canonical executor semantics closely enough to
// verify plan convergence in pure Go: create/move anchors must exist at
// execution time, deletes take whole subtrees, and a no-op reorder
// changes nothing.
type simulator struct {
	children map[string][]string // container or node ref → ordered child refs
	nodes    map[string]TreeNode
}

func newSimulator() *simulator {
	return &simulator{
		children: map[string][]string{},
		nodes:    map[string]TreeNode{},
	}
}

func (s *simulator) loadTree(t *Tree) error {
	idx, err := t.index()
	if err != nil {
		return err
	}
	for ref, n := range idx.byRef {
		s.nodes[ref] = n
		s.children[ref] = append([]string(nil), idx.children[ref]...)
	}
	return nil
}

func (s *simulator) insertBefore(parent, ref, before string) error {
	list := s.children[parent]
	at := len(list)
	if before != "" {
		at = -1
		for i, cur := range list {
			if cur == before {
				at = i
				break
			}
		}
		if at < 0 {
			return fmt.Errorf("anchor %q not found under %q", before, parent)
		}
	}
	list = append(list, "")
	copy(list[at+1:], list[at:])
	list[at] = ref
	s.children[parent] = list
	return nil
}

func (s *simulator) detach(ref string) string {
	parent := s.nodes[ref].ParentRef
	list := s.children[parent]
	for i, cur := range list {
		if cur == ref {
			s.children[parent] = append(list[:i], list[i+1:]...)
			return parent
		}
	}
	return "" // not attached (fresh create)
}

func (s *simulator) apply(op Primitive) error {
	switch op.Kind {
	case KindCreate:
		parent := parentKeyStr(op.Parent)
		if _, exists := s.nodes[op.NodeID]; exists {
			return fmt.Errorf("create of existing node %q", op.NodeID)
		}
		node := TreeNode{
			Ref:       op.NodeID,
			ParentRef: parent,
			Type:      op.Type,
			Title:     op.Title,
			URL:       op.URL,
		}
		s.nodes[op.NodeID] = node
		if err := s.insertBefore(parent, op.NodeID, op.BeforeID); err != nil {
			return err
		}
	case KindUpdateTitle:
		node := s.nodes[op.NodeID]
		node.Title = op.Title
		s.nodes[op.NodeID] = node
	case KindUpdateURL:
		node := s.nodes[op.NodeID]
		node.URL = op.URL
		s.nodes[op.NodeID] = node
	case KindMove:
		node, exists := s.nodes[op.NodeID]
		if !exists {
			return fmt.Errorf("move of unknown node %q", op.NodeID)
		}
		parent := parentKeyStr(op.Parent)
		s.detach(op.NodeID)
		node.ParentRef = parent
		s.nodes[op.NodeID] = node
		if err := s.insertBefore(parent, op.NodeID, op.BeforeID); err != nil {
			return err
		}
	case KindDelete:
		stack := []string{op.NodeID}
		for len(stack) > 0 {
			ref := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			stack = append(stack, s.children[ref]...)
			s.detach(ref)
			delete(s.children, ref)
			delete(s.nodes, ref)
		}
	default:
		return fmt.Errorf("unknown kind %q", op.Kind)
	}
	return nil
}

func parentKeyStr(p canonical.ParentRef) string {
	switch p.Type {
	case canonical.ParentTypeNode:
		return string(p.NodeID)
	case canonical.ParentTypeRoot:
		return RootRef(p.RootKey)
	default:
		return ""
	}
}

// assertDesired verifies the simulated tree equals the desired tree.
func assertDesired(t *testing.T, sim *simulator, desired *DesiredTree) {
	t.Helper()
	for container, order := range desired.Order {
		got := []string{}
		for _, ref := range sim.children[container] {
			if _, isDesired := desired.Nodes[ref]; isDesired {
				got = append(got, ref)
			} else if sim.nodes[ref].Type == NodeRoot {
				continue // root containers are not plan targets
			} else {
				t.Fatalf("container %q holds unexpected node %q", container, ref)
			}
		}
		if strings.Join(got, ",") != strings.Join(order, ",") {
			t.Fatalf("container %q order = %v, want %v", container, got, order)
		}
	}
	for id, d := range desired.Nodes {
		got, exists := sim.nodes[id]
		if !exists {
			t.Fatalf("desired node %q missing after apply", id)
		}
		if got.Type != d.Type || got.Title != d.Title || got.URL != d.URL {
			t.Fatalf("node %q = %+v, want %+v", id, got, d)
		}
		if got.ParentRef != d.ParentRef {
			t.Fatalf("node %q parent = %q, want %q", id, got.ParentRef, d.ParentRef)
		}
	}
}

// randomTree generates a random canonical-style tree over the given root
// keys. Refs are "c<i>"; the canonical id falls back to the ref.
func randomTree(rng *rand.Rand, rootKeys []string, size int) *Tree {
	nodes := []TreeNode{}
	for _, key := range rootKeys {
		nodes = append(nodes, TreeNode{Ref: RootRef(key), Type: NodeRoot, RootKey: key, Title: key})
	}
	folders := []string{}
	for _, key := range rootKeys {
		folders = append(folders, RootRef(key))
	}
	for i := 0; i < size; i++ {
		ref := fmt.Sprintf("c%d", i)
		typ := NodeBookmark
		if rng.Intn(3) == 0 {
			typ = NodeFolder
		}
		parent := folders[rng.Intn(len(folders))]
		node := TreeNode{
			Ref:       ref,
			ParentRef: parent,
			Type:      typ,
			Title:     "Title " + ref,
		}
		if typ == NodeBookmark {
			node.URL = "https://" + ref + ".example"
		}
		nodes = append(nodes, node)
		if typ == NodeFolder {
			folders = append(folders, ref)
		}
	}
	return &Tree{Nodes: nodes}
}

// randomDesired builds a random desired tree whose id pool overlaps the
// current tree's refs: retained ids may be re-parented, renamed or
// retitled; dropped current ids become deletes; extra ids become creates.
func randomDesired(rng *rand.Rand, current *Tree, rootKeys []string, extra int) *DesiredTree {
	idx, _ := current.index()
	pool := []string{}
	for ref, node := range idx.byRef {
		if node.Type == NodeRoot {
			continue
		}
		if rng.Intn(4) > 0 { // drop ~25% → deletes
			pool = append(pool, ref)
		}
	}
	for i := 0; i < extra; i++ { // fresh ids → creates
		pool = append(pool, fmt.Sprintf("d%d", i))
	}
	rng.Shuffle(len(pool), func(i, j int) { pool[i], pool[j] = pool[j], pool[i] })

	d := &DesiredTree{
		Nodes: map[string]*DesiredNode{},
		Order: map[string][]string{},
	}
	containers := []string{}
	for _, key := range rootKeys {
		containers = append(containers, RootRef(key))
	}
	for _, id := range pool {
		container := containers[rng.Intn(len(containers))]
		// Canonical node types are immutable: retained ids keep the type
		// their current counterpart has; only fresh ids may pick one.
		typ := NodeBookmark
		if cur, ok := idx.byRef[id]; ok {
			typ = cur.Type
		} else if rng.Intn(3) == 0 {
			typ = NodeFolder
		}
		title := "Title " + id
		if rng.Intn(4) == 0 {
			title = "Renamed " + id
		}
		node := &DesiredNode{ID: id, ParentRef: container, Type: typ, Title: title}
		if typ == NodeBookmark {
			node.URL = "https://" + id + ".example"
		}
		d.Nodes[id] = node
		d.Order[container] = append(d.Order[container], id)
		if typ == NodeFolder {
			containers = append(containers, id)
		}
	}
	return d
}

func TestBuildPlanConvergesProperty(t *testing.T) {
	rootKeys := []string{"main", "archive"}
	for seed := int64(1); seed <= 300; seed++ {
		rng := rand.New(rand.NewSource(seed))
		current := randomTree(rng, rootKeys, rng.Intn(30))
		desired := randomDesired(rng, current, rootKeys, rng.Intn(10))

		p, err := BuildPlan(current, desired, Policy{Strategy: StrategyReplace}, newCanonicalIdentity(current))
		if err != nil {
			t.Fatalf("seed %d: BuildPlan: %v", seed, err)
		}
		sim := newSimulator()
		if err := sim.loadTree(current); err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		for i, op := range p.Operations {
			if err := sim.apply(op); err != nil {
				t.Fatalf("seed %d: operation %d (%s %s): %v", seed, i, op.Kind, op.NodeID, err)
			}
		}
		assertDesired(t, sim, desired)
	}
}

func TestClientStepsConvergeProperty(t *testing.T) {
	rootKeys := []string{"main"}
	for seed := int64(1); seed <= 200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		// Server snapshot as the desired authority.
		desired := randomDesired(rng, randomTree(rng, rootKeys, rng.Intn(20)), rootKeys, rng.Intn(8))

		// Client tree: browser nodes over a local ref space, some carrying
		// canonical ids of desired nodes, plus browser-only nodes.
		clientNodes := []TreeNode{TreeNode{Ref: "l_root", Type: NodeRoot, RootKey: "main", Title: "Bar"}}
		containers := []string{"l_root"}
		mapping := map[string]string{} // canonical id → local ref
		id := 0
		// Deterministic iteration: map ranges would make the rng stream
		// (and thus the whole case) unreproducible.
		desiredIDs := make([]string, 0, len(desired.Nodes))
		for did := range desired.Nodes {
			desiredIDs = append(desiredIDs, did)
		}
		sort.Strings(desiredIDs)
		for _, did := range desiredIDs {
			d := desired.Nodes[did]
			if rng.Intn(3) == 0 {
				continue // server-only node: client must create it
			}
			id++
			lref := fmt.Sprintf("l%d", id)
			parent := containers[rng.Intn(len(containers))]
			clientNodes = append(clientNodes, TreeNode{
				Ref: lref, ParentRef: parent, Type: d.Type, Title: d.Title, URL: d.URL, CanonicalID: did,
			})
			mapping[did] = lref
			if d.Type == NodeFolder {
				containers = append(containers, lref)
			}
		}
		for i := 0; i < rng.Intn(4); i++ { // browser-only nodes → deletes
			id++
			lref := fmt.Sprintf("l%d", id)
			clientNodes = append(clientNodes, TreeNode{
				Ref: lref, ParentRef: containers[rng.Intn(len(containers))],
				Type: NodeBookmark, Title: "Local only", URL: "https://local.example",
			})
		}
		client := &Tree{Nodes: clientNodes}

		steps, err := DeriveClientSteps(client, desired, Policy{Strategy: StrategyReplace}, newCanonicalIdentity(client))
		if err != nil {
			t.Fatalf("seed %d: DeriveClientSteps: %v", seed, err)
		}

		// Apply the steps in browser space.
		sim := newSimulator()
		if err := sim.loadTree(client); err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		invMapping := map[string]string{} // local ref → canonical id
		rootByRef := map[string]string{}  // local root ref → root key
		for _, node := range clientNodes {
			if node.Type == NodeRoot {
				rootByRef[node.Ref] = node.RootKey
			} else if node.CanonicalID != "" {
				invMapping[node.Ref] = node.CanonicalID
			}
		}
		resolveParent := func(p canonical.ParentRef) string {
			switch p.Type {
			case canonical.ParentTypeRoot:
				for lref, key := range rootByRef {
					if key == p.RootKey {
						return lref
					}
				}
				t.Fatalf("seed %d: unknown root key %q", seed, p.RootKey)
			case canonical.ParentTypeNode:
				if lref, ok := mapping[string(p.NodeID)]; ok {
					return lref
				}
				t.Fatalf("seed %d: unmapped parent %q", seed, p.NodeID)
			}
			return ""
		}
		// resolveLocal maps a canonical id onto the browser node the plan
		// created for it; plain local refs pass through unchanged.
		resolveLocal := func(ref string) string {
			if lref, ok := mapping[ref]; ok {
				return lref
			}
			return ref
		}
		for i, step := range steps {
			switch step.Kind {
			case StepAssignIdentity:
				mapping[step.CanonicalID] = step.LocalRef
				invMapping[step.LocalRef] = step.CanonicalID
			case StepCreate:
				ref := "created:" + step.CanonicalID
				parent := resolveParent(step.Parent)
				sim.nodes[ref] = TreeNode{Ref: ref, ParentRef: parent, Type: step.Type, Title: step.Title, URL: step.URL}
				if err := sim.insertBefore(parent, ref, mapping[step.BeforeID]); err != nil {
					t.Fatalf("seed %d: step %d create: %v", seed, i, err)
				}
				mapping[step.CanonicalID] = ref
				invMapping[ref] = step.CanonicalID
			case StepUpdate:
				ref := resolveLocal(step.LocalRef)
				node := sim.nodes[ref]
				node.Title, node.URL = step.Title, step.URL
				sim.nodes[ref] = node
			case StepMove:
				ref := resolveLocal(step.LocalRef)
				sim.detach(ref)
				parent := resolveParent(step.Parent)
				node := sim.nodes[ref]
				node.ParentRef = parent
				sim.nodes[ref] = node
				if err := sim.insertBefore(parent, ref, mapping[step.BeforeID]); err != nil {
					t.Fatalf("seed %d: step %d move: %v", seed, i, err)
				}
			case StepDelete:
				if err := sim.apply(Primitive{Kind: KindDelete, NodeID: resolveLocal(step.LocalRef)}); err != nil {
					t.Fatalf("seed %d: step %d delete: %v", seed, i, err)
				}
			}
		}

		// Project the browser tree back into canonical space and compare.
		// Walk sim.children in order (map iteration would randomize the
		// sibling order of the projection).
		projection := &DesiredTree{Nodes: map[string]*DesiredNode{}, Order: map[string][]string{}}
		var walk func(ref, parentContainer string)
		walk = func(ref, parentContainer string) {
			for _, child := range sim.children[ref] {
				node := sim.nodes[child]
				cid, ok := invMapping[child]
				if !ok {
					t.Fatalf("seed %d: browser node %q left unmapped after steps", seed, child)
				}
				projection.Nodes[cid] = &DesiredNode{ID: cid, ParentRef: parentContainer, Type: node.Type, Title: node.Title, URL: node.URL}
				projection.Order[parentContainer] = append(projection.Order[parentContainer], cid)
				walk(child, cid)
			}
		}
		for _, node := range clientNodes {
			if node.Type != NodeRoot {
				continue
			}
			walk(node.Ref, RootRef(node.RootKey))
		}
		for container, order := range desired.Order {
			got := projection.Order[container]
			if strings.Join(got, ",") != strings.Join(order, ",") {
				t.Fatalf("seed %d: container %q order = %v, want %v", seed, container, got, order)
			}
		}
		for id, d := range desired.Nodes {
			got := projection.Nodes[id]
			if got == nil {
				t.Fatalf("seed %d: desired node %q missing from projection", seed, id)
			}
			if got.ParentRef != d.ParentRef || got.Title != d.Title || got.URL != d.URL || got.Type != d.Type {
				t.Fatalf("seed %d: node %q = %+v, want %+v", seed, id, got, d)
			}
		}
	}
}

func TestDeriveClientStepsInitialFlow(t *testing.T) {
	// Empty server, populated browser: every node arrives as
	// assign_identity + a server-side create; client steps carry no
	// creates of their own.
	client := mustTree(t, []TreeNode{
		r("l_root", "main", "Bar"),
		n("l_f1", "l_root", "folder", "Development", ""),
		n("l_b1", "l_f1", "bookmark", "GitHub", "https://github.com"),
	})
	server := mustTree(t, []TreeNode{r("root:main", "main", "Main")})
	m, err := MatchExact(client, server)
	if err != nil {
		t.Fatalf("MatchExact: %v", err)
	}
	d, err := BuildDesired(m, Policy{Strategy: StrategyMerge}, nil, fixedIDs("new_"))
	if err != nil {
		t.Fatalf("BuildDesired: %v", err)
	}
	steps, err := DeriveClientSteps(client, d, Policy{Strategy: StrategyMerge}, sourceRefIdentity{})
	if err != nil {
		t.Fatalf("DeriveClientSteps: %v", err)
	}
	assign := 0
	for _, s := range steps {
		if s.Kind != StepAssignIdentity {
			t.Fatalf("unexpected step %+v", s)
		}
		assign++
	}
	// Only the two real nodes get identities; the root slot itself is a
	// container, not a desired node.
	if assign != 2 {
		t.Fatalf("want 2 assign_identity steps, got %d: %+v", assign, steps)
	}
	// The root slot itself is not a desired node: no mapping for it.
	for _, s := range steps {
		if s.LocalRef == "l_root" {
			t.Fatal("root nodes must not receive assign_identity steps")
		}
	}
}
