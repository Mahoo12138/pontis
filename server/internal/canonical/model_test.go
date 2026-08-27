package canonical

import "testing"

func TestParentRefConstructors(t *testing.T) {
	nodeParent := NewNodeParent("n1")
	if nodeParent.Type != ParentTypeNode || nodeParent.NodeID != "n1" || nodeParent.RootKey != "" {
		t.Errorf("unexpected node parent ref: %+v", nodeParent)
	}

	rootParent := NewRootParent("toolbar")
	if rootParent.Type != ParentTypeRoot || rootParent.RootKey != "toolbar" || rootParent.NodeID != "" {
		t.Errorf("unexpected root parent ref: %+v", rootParent)
	}
}

func TestNodeTypeValues(t *testing.T) {
	if NodeTypeFolder != "folder" || NodeTypeBookmark != "bookmark" {
		t.Errorf("unexpected node type values: %q %q", NodeTypeFolder, NodeTypeBookmark)
	}
}
