package sync

import (
	"errors"
	"fmt"
	"testing"

	"pontis/internal/canonical"
)

func TestOperationHashDeterministic(t *testing.T) {
	before := canonical.NodeID("anchor-1")
	op := Operation{
		OpID: "op-1", ClientSeq: 7, BaseRevision: 42,
		Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark,
		Title: "Go", URL: "https://go.dev",
		Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before,
	}
	if operationHash(op) != operationHash(op) {
		t.Error("operationHash not deterministic for identical operations")
	}
}

func TestOperationHashSensitiveToEveryField(t *testing.T) {
	before := canonical.NodeID("anchor-1")
	base := Operation{
		OpID: "op-1", ClientSeq: 7, BaseRevision: 42,
		Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark,
		Title: "Go", URL: "https://go.dev",
		Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before,
	}
	baseHash := operationHash(base)

	mutations := map[string]Operation{
		"op id":          {OpID: "op-2", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"client seq":     {OpID: "op-1", ClientSeq: 8, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"base revision":  {OpID: "op-1", ClientSeq: 7, BaseRevision: 43, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"op type":        {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpMove, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"node id":        {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n2", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"node type":      {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeFolder, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"title":          {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go!", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"url":            {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev/", Parent: canonical.NewNodeParent("folder-1"), BeforeID: &before},
		"parent":         {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-2"), BeforeID: &before},
		"parent kind":    {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewRootParent("toolbar"), BeforeID: &before},
		"before set":     {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: nil},
		"before changed": {OpID: "op-1", ClientSeq: 7, BaseRevision: 42, Type: OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("folder-1"), BeforeID: ptrNodeID("anchor-2")},
	}
	for name, mutated := range mutations {
		if operationHash(mutated) == baseHash {
			t.Errorf("operationHash identical after mutating %s", name)
		}
	}
}

func ptrNodeID(s canonical.NodeID) *canonical.NodeID { return &s }

func TestInsertIndex(t *testing.T) {
	siblings := []canonical.Node{
		{ID: "a"}, {ID: "b"}, {ID: "c"},
	}
	cases := []struct {
		name     string
		siblings []canonical.Node
		beforeID *canonical.NodeID
		want     int64
	}{
		{"empty append", nil, nil, 0},
		{"empty with anchor", nil, ptrNodeID("a"), 0},
		{"append at end", siblings, nil, 3},
		{"before first", siblings, ptrNodeID("a"), 0},
		{"before middle", siblings, ptrNodeID("b"), 1},
		{"before last", siblings, ptrNodeID("c"), 2},
		{"anchor not a sibling -> append", siblings, ptrNodeID("zzz"), 3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := insertIndex(c.siblings, c.beforeID); got != c.want {
				t.Errorf("insertIndex = %d, want %d", got, c.want)
			}
		})
	}
}

func TestContainsChild(t *testing.T) {
	children := []canonical.Node{{ID: "a"}, {ID: "b"}}
	if !containsChild(children, "a") {
		t.Error("containsChild(a) = false, want true")
	}
	if containsChild(children, "z") {
		t.Error("containsChild(z) = true, want false")
	}
	if containsChild(nil, "a") {
		t.Error("containsChild(nil) = true, want false")
	}
}

func TestExcludeNode(t *testing.T) {
	children := []canonical.Node{{ID: "a"}, {ID: "b"}, {ID: "c"}}
	out := excludeNode(children, "b")
	if len(out) != 2 || out[0].ID != "a" || out[1].ID != "c" {
		t.Errorf("excludeNode = %v, want [a c]", out)
	}
	// The input slice must not be mutated.
	if len(children) != 3 {
		t.Errorf("input slice mutated: len = %d", len(children))
	}
	if got := excludeNode(children, "zzz"); len(got) != 3 {
		t.Errorf("excludeNode of a missing id changed the count: %d", len(got))
	}
}

func TestSameParent(t *testing.T) {
	cases := []struct {
		name string
		a, b canonical.ParentRef
		want bool
	}{
		{"same node", canonical.NewNodeParent("f1"), canonical.NewNodeParent("f1"), true},
		{"different nodes", canonical.NewNodeParent("f1"), canonical.NewNodeParent("f2"), false},
		{"same root", canonical.NewRootParent("toolbar"), canonical.NewRootParent("toolbar"), true},
		{"different roots", canonical.NewRootParent("toolbar"), canonical.NewRootParent("menu"), false},
		{"node vs root", canonical.NewNodeParent("f1"), canonical.NewRootParent("f1"), false},
		{"both zero", canonical.ParentRef{}, canonical.ParentRef{}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := sameParent(c.a, c.b); got != c.want {
				t.Errorf("sameParent = %v, want %v", got, c.want)
			}
		})
	}
}

func TestRejectionReason(t *testing.T) {
	mapped := map[error]string{
		canonical.ErrTitleRequired:   ReasonInvalidPayload,
		canonical.ErrURLRequired:     ReasonInvalidPayload,
		canonical.ErrURLNotAllowed:   ReasonInvalidPayload,
		canonical.ErrParentMissing:   ReasonInvalidPayload,
		canonical.ErrParentNotFolder: ReasonParentNotFolder,
		canonical.ErrNodeIsSelf:      ReasonTreeCycle,
		canonical.ErrTreeCycle:       ReasonTreeCycle,
	}
	for err, want := range mapped {
		reason, ok := rejectionReason(err)
		if !ok {
			t.Errorf("rejectionReason(%v) not mapped, want %q", err, want)
			continue
		}
		if reason != want {
			t.Errorf("rejectionReason(%v) = %q, want %q", err, reason, want)
		}
	}

	wrapped := fmt.Errorf("executor failed: %w", canonical.ErrTreeCycle)
	if reason, ok := rejectionReason(wrapped); !ok || reason != ReasonTreeCycle {
		t.Errorf("rejectionReason(wrapped ErrTreeCycle) = %q, %v", reason, ok)
	}

	if _, ok := rejectionReason(errors.New("boom")); ok {
		t.Error("rejectionReason of an unrelated error reports ok, want false")
	}
	if _, ok := rejectionReason(nil); ok {
		t.Error("rejectionReason(nil) reports ok, want false")
	}
}

func TestRecoveryRootNaming(t *testing.T) {
	if got := recoveryRootKey(canonical.DeviceID("dev-9")); got != "recovered:dev-9" {
		t.Errorf("recoveryRootKey = %q, want recovered:dev-9", got)
	}
	if got := recoveryRootName(""); got != "Recovered" {
		t.Errorf("recoveryRootName(\"\") = %q, want Recovered", got)
	}
	if got := recoveryRootName("Edge Work"); got != "Recovered/Edge Work" {
		t.Errorf("recoveryRootName = %q, want Recovered/Edge Work", got)
	}
}

func TestResultConstructors(t *testing.T) {
	op := Operation{OpID: "op-1", ClientSeq: 3}

	res := rejectedResult(op, ReasonInvalidParent)
	if res.Status != StatusRejected || res.Reason != ReasonInvalidParent || res.OpID != "op-1" || res.ClientSeq != 3 {
		t.Errorf("rejectedResult = %+v", res)
	}
	if res.SettleAfterRevision != 0 {
		t.Errorf("rejectedResult settle = %d, want 0", res.SettleAfterRevision)
	}

	res = rejectedWithSettle(op, ReasonTargetDeleted, 12)
	if res.Status != StatusRejected || res.SettleAfterRevision != 12 {
		t.Errorf("rejectedWithSettle = %+v", res)
	}

	res = noopResult(op, ReasonAlreadyDeleted, 9)
	if res.Status != StatusNoop || res.SettleAfterRevision != 9 {
		t.Errorf("noopResult = %+v", res)
	}

	res = conflictResult(op, ReasonConcurrentUpdate, 15)
	if res.Status != StatusConflict || res.SettleAfterRevision != 15 {
		t.Errorf("conflictResult = %+v", res)
	}
}

func TestReceiptResultRoundTrip(t *testing.T) {
	r := Receipt{
		OpID: "op-1", ClientSeq: 4, Status: StatusApplied,
		Reason: ReasonAlreadyExists, ResultRevision: 20, SettleAfterRevision: 20,
	}
	got := receiptResult(r)
	if got.OpID != r.OpID || got.ClientSeq != r.ClientSeq || got.Status != r.Status ||
		got.Reason != r.Reason || got.ResultRevision != r.ResultRevision ||
		got.SettleAfterRevision != r.SettleAfterRevision {
		t.Errorf("receiptResult = %+v, want mirror of %+v", got, r)
	}
}
