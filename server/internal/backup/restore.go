package backup

import (
	"fmt"
	"strings"

	"pontis/internal/canonical"
)

// A backup payload is exported data: it may be hand-edited, produced by an
// older server, or truncated. Restoring replaces the live tree, so the whole
// payload is validated and put into a writable order before anything is
// touched, never mid-transaction.

// validatePayload checks the envelope and the shape of the tree: unique ids,
// resolvable parents, bookmarks that carry a URL.
func validatePayload(spaceID canonical.SpaceID, p Payload) error {
	if p.Format != formatTag {
		return fmt.Errorf("%w: format %q", ErrInvalidPayload, p.Format)
	}
	if p.Version != payloadVersion {
		return fmt.Errorf("%w: version %d", ErrInvalidPayload, p.Version)
	}
	if p.SpaceID != string(spaceID) {
		return fmt.Errorf("%w: space %q does not match %s", ErrInvalidPayload, p.SpaceID, spaceID)
	}

	slots := map[string]bool{}
	for _, s := range p.RootSlots {
		if strings.TrimSpace(s.Key) == "" {
			return fmt.Errorf("%w: root slot without a key", ErrInvalidPayload)
		}
		if slots[s.Key] {
			return fmt.Errorf("%w: duplicate root slot %q", ErrInvalidPayload, s.Key)
		}
		slots[s.Key] = true
	}

	seen := map[string]*NodeDTO{}
	for i := range p.Nodes {
		n := &p.Nodes[i]
		if strings.TrimSpace(n.ID) == "" {
			return fmt.Errorf("%w: node without an id", ErrInvalidPayload)
		}
		if seen[n.ID] != nil {
			return fmt.Errorf("%w: duplicate node id %s", ErrInvalidPayload, n.ID)
		}
		seen[n.ID] = n
		switch canonical.NodeType(n.Type) {
		case canonical.NodeTypeBookmark, canonical.NodeTypeFolder:
		default:
			return fmt.Errorf("%w: node %s has unknown type %q", ErrInvalidPayload, n.ID, n.Type)
		}
		if n.Type == string(canonical.NodeTypeBookmark) && (n.URL == nil || *n.URL == "") {
			return fmt.Errorf("%w: bookmark %s has no url", ErrInvalidPayload, n.ID)
		}
		switch {
		case n.ParentID != nil && n.RootKey != nil:
			return fmt.Errorf("%w: node %s names two parents", ErrInvalidPayload, n.ID)
		case n.ParentID == nil && n.RootKey == nil:
			return fmt.Errorf("%w: node %s has no parent", ErrInvalidPayload, n.ID)
		case n.RootKey != nil:
			if !slots[*n.RootKey] {
				return fmt.Errorf("%w: node %s hangs off unknown root slot %q", ErrInvalidPayload, n.ID, *n.RootKey)
			}
		}
	}

	for id, n := range seen {
		if n.ParentID == nil {
			continue
		}
		parent, ok := seen[*n.ParentID]
		if !ok {
			return fmt.Errorf("%w: node %s has missing parent %s", ErrInvalidPayload, id, *n.ParentID)
		}
		if canonical.NodeType(parent.Type) != canonical.NodeTypeFolder {
			return fmt.Errorf("%w: node %s hangs off %s, which is not a folder", ErrInvalidPayload, id, parent.ID)
		}
	}
	return nil
}

// orderParentFirst returns the nodes so that every node follows its parent.
// nodes.parent_id is an immediate foreign key, so inserting the payload in
// export order (sorted by position across the whole space) fails as soon as a
// folder sorts after one of its own children.
//
// A cycle is reported as invalid content rather than looping forever.
func orderParentFirst(nodes []NodeDTO) ([]NodeDTO, error) {
	byID := make(map[string]*NodeDTO, len(nodes))
	for i := range nodes {
		byID[nodes[i].ID] = &nodes[i]
	}
	const (
		unvisited = iota
		onPath
		done
	)
	state := make(map[string]int, len(nodes))
	ordered := make([]NodeDTO, 0, len(nodes))

	var visit func(id string) error
	visit = func(id string) error {
		switch state[id] {
		case done:
			return nil
		case onPath:
			return fmt.Errorf("%w: parent cycle at node %s", ErrInvalidPayload, id)
		}
		n := byID[id]
		if n == nil {
			return fmt.Errorf("%w: unknown node %s", ErrInvalidPayload, id)
		}
		state[id] = onPath
		if n.ParentID != nil {
			if err := visit(*n.ParentID); err != nil {
				return err
			}
		}
		state[id] = done
		ordered = append(ordered, *n)
		return nil
	}
	// Walking the payload order keeps the result deterministic.
	for i := range nodes {
		if err := visit(nodes[i].ID); err != nil {
			return nil, err
		}
	}
	return ordered, nil
}
