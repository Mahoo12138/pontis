package reconcile

import "sort"

// Match statuses (doc 07 §4). A node is exactly one of: matched to a
// unique counterpart, only present on one side, or ambiguous between
// several equally plausible counterparts. Ambiguous nodes are never
// guessed (doc 06 §6); they surface as reconciliation issues.
type MatchStatus string

const (
	Matched    MatchStatus = "matched"
	SourceOnly MatchStatus = "source_only"
	TargetOnly MatchStatus = "target_only"
	Ambiguous  MatchStatus = "ambiguous"
)

// Pair is one resolved identity link between the two trees.
type Pair struct {
	SourceRef string
	TargetRef string
}

// Ambiguity records a source node with more than one equally plausible
// target counterpart.
type Ambiguity struct {
	SourceRef  string
	Candidates []string
}

// MatchResult is the output of an identity resolver. SourceOnly and
// TargetOnly enumerate every unmatched node including whole unmatched
// subtrees.
type MatchResult struct {
	Source *Tree
	Target *Tree

	Pairs    []Pair
	BySource map[string]string // source ref → target ref
	ByTarget map[string]string // target ref → source ref

	SourceOnly []string
	TargetOnly []string
	Ambiguous  []Ambiguity
}

// Status reports the match status of a source node.
func (m *MatchResult) Status(sourceRef string) MatchStatus {
	if _, ok := m.BySource[sourceRef]; ok {
		return Matched
	}
	for _, a := range m.Ambiguous {
		if a.SourceRef == sourceRef {
			return Ambiguous
		}
	}
	return SourceOnly
}

// link records a resolved pair.
func (m *MatchResult) link(sourceRef, targetRef string) {
	m.Pairs = append(m.Pairs, Pair{SourceRef: sourceRef, TargetRef: targetRef})
	m.BySource[sourceRef] = targetRef
	m.ByTarget[targetRef] = sourceRef
}

// classify fills SourceOnly/TargetOnly once pairing is done: every node
// without a resolved counterpart, deterministically ordered.
func (m *MatchResult) classify(srcIdx, tgtIdx *treeIndex) {
	for ref := range srcIdx.byRef {
		if _, ok := m.BySource[ref]; ok {
			continue
		}
		ambig := false
		for _, a := range m.Ambiguous {
			if a.SourceRef == ref {
				ambig = true
				break
			}
		}
		if !ambig {
			m.SourceOnly = append(m.SourceOnly, ref)
		}
	}
	sort.Strings(m.SourceOnly)
	for ref := range tgtIdx.byRef {
		if _, ok := m.ByTarget[ref]; !ok {
			m.TargetOnly = append(m.TargetOnly, ref)
		}
	}
	sort.Strings(m.TargetOnly)
}

// linkRoots matches the root nodes of both trees on the canonical root
// slot key. A slot may map to at most one browser root per snapshot.
func (m *MatchResult) linkRoots(srcIdx, tgtIdx *treeIndex) {
	srcRoots := srcIdx.rootByKeys()
	tgtRoots := tgtIdx.rootByKeys()
	for key, srcRoot := range srcRoots {
		if tgtRoot, ok := tgtRoots[key]; ok {
			m.link(srcRoot.Ref, tgtRoot.Ref)
		}
	}
}

// MatchExact is the conservative parent-aware identity resolver used by
// initial sync and recovery (doc 06 §6): matching only happens under an
// already-matched parent; folders match on exact title and bookmarks on
// exact raw URL, and only when the candidate is unique. It never infers
// renames, moves or deletes: preferring duplicates over wrong merges.
func MatchExact(source, target *Tree) (*MatchResult, error) {
	srcIdx, err := source.index()
	if err != nil {
		return nil, err
	}
	tgtIdx, err := target.index()
	if err != nil {
		return nil, err
	}

	m := &MatchResult{
		Source:   source,
		Target:   target,
		BySource: map[string]string{},
		ByTarget: map[string]string{},
	}
	m.linkRoots(srcIdx, tgtIdx)

	var matchChildren func(srcParent, tgtParent string)
	matchChildren = func(srcParent, tgtParent string) {
		srcChildren := srcIdx.children[srcParent]
		tgtChildren := tgtIdx.children[tgtParent]
		used := map[string]bool{}
		for _, sc := range srcChildren {
			srcNode := srcIdx.byRef[sc]
			var candidates []string
			for _, tc := range tgtChildren {
				if used[tc] {
					continue
				}
				tgtNode := tgtIdx.byRef[tc]
				if srcNode.Type != tgtNode.Type {
					continue
				}
				switch srcNode.Type {
				case NodeFolder:
					if srcNode.Title == tgtNode.Title {
						candidates = append(candidates, tc)
					}
				case NodeBookmark:
					if srcNode.URL == tgtNode.URL {
						candidates = append(candidates, tc)
					}
				}
			}
			switch len(candidates) {
			case 0:
				// No inference: the node arrives as a fresh create.
			case 1:
				used[candidates[0]] = true
				m.link(sc, candidates[0])
				matchChildren(sc, candidates[0])
			default:
				m.Ambiguous = append(m.Ambiguous, Ambiguity{SourceRef: sc, Candidates: candidates})
			}
		}
	}
	for _, pair := range m.Pairs {
		if srcIdx.byRef[pair.SourceRef].Type == NodeRoot {
			matchChildren(pair.SourceRef, pair.TargetRef)
		}
	}
	m.classify(srcIdx, tgtIdx)
	return m, nil
}

// MatchByCanonicalID matches nodes by their known canonical identity,
// regardless of position (doc 07 §3). Used by full resync, where the
// mapping is still trusted but the incremental timeline is not.
func MatchByCanonicalID(source, target *Tree) (*MatchResult, error) {
	srcIdx, err := source.index()
	if err != nil {
		return nil, err
	}
	tgtIdx, err := target.index()
	if err != nil {
		return nil, err
	}

	m := &MatchResult{
		Source:   source,
		Target:   target,
		BySource: map[string]string{},
		ByTarget: map[string]string{},
	}
	m.linkRoots(srcIdx, tgtIdx)

	// Index the target by canonical identity; a source node matches the
	// unique target carrying its id, or stays unmatched. Duplicate
	// identities inside one tree are rejected by the index.
	tgtByID := map[string][]string{}
	for ref, n := range tgtIdx.byRef {
		if n.Type == NodeRoot || n.CanonicalID == "" {
			continue
		}
		tgtByID[n.CanonicalID] = append(tgtByID[n.CanonicalID], ref)
	}

	for ref, n := range srcIdx.byRef {
		if n.Type == NodeRoot || n.CanonicalID == "" {
			continue
		}
		candidates := tgtByID[n.CanonicalID]
		switch len(candidates) {
		case 1:
			m.link(ref, candidates[0])
		default:
			if len(candidates) > 1 {
				m.Ambiguous = append(m.Ambiguous, Ambiguity{SourceRef: ref, Candidates: candidates})
			}
		}
	}
	m.classify(srcIdx, tgtIdx)
	return m, nil
}
