package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pontis/internal/canonical"
)

const restoreSpace = canonical.SpaceID("space-restore")

// seedBackupFile stores a raw payload as a catalog row's file and returns the
// backup id, so a test can hand Restore any content it wants.
func seedBackupFile(t *testing.T, store *fakeStore, dir string, id string, raw []byte) string {
	t.Helper()
	key := id + ".json"
	if err := os.WriteFile(filepath.Join(dir, key), raw, 0o644); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	row := Backup{ID: id, SpaceID: string(restoreSpace), Kind: KindManual,
		Filename: key, StorageKey: key, CreatedAt: time.Now().UTC()}
	if err := store.Insert(context.Background(), row); err != nil {
		t.Fatalf("insert row: %v", err)
	}
	return id
}

func payloadOf(nodes []NodeDTO) Payload {
	return Payload{
		Format: formatTag, Version: payloadVersion, SpaceID: string(restoreSpace),
		RootSlots: []SlotDTO{{Key: "main", DisplayName: "Main", Position: 0}},
		Nodes:     nodes,
	}
}

func strRef(s string) *string { return &s }

// A payload is exported data, and restore wipes the live tree with it, so the
// whole tree has to be provably writable before anything is touched.
func TestRestoreRejectsInvalidPayloadsBeforeTouchingAnything(t *testing.T) {
	base := func() []NodeDTO {
		return []NodeDTO{
			{ID: "b", Type: "bookmark", Title: "B", URL: strRef("https://b"), RootKey: strRef("main")},
			{ID: "f", Type: "folder", Title: "F", RootKey: strRef("main")},
		}
	}

	for _, tc := range []struct {
		name   string
		mutate func(p *Payload)
	}{
		{"wrong format", func(p *Payload) { p.Format = "zip" }},
		{"wrong version", func(p *Payload) { p.Version = 7 }},
		{"other space", func(p *Payload) { p.SpaceID = "someone-else" }},
		{"duplicate node id", func(p *Payload) { p.Nodes = append(p.Nodes, p.Nodes[0]) }},
		{"node without id", func(p *Payload) { p.Nodes[0].ID = "" }},
		{"unknown node type", func(p *Payload) { p.Nodes[0].Type = "tab" }},
		{"bookmark without url", func(p *Payload) { p.Nodes[0].URL = nil }},
		{"two parents", func(p *Payload) { p.Nodes[0].ParentID = strRef("f") }},
		{"no parent", func(p *Payload) { p.Nodes[0].RootKey = nil }},
		{"unknown root slot", func(p *Payload) { p.Nodes[0].RootKey = strRef("archive") }},
		{"duplicate root slot", func(p *Payload) {
			p.RootSlots = append(p.RootSlots, p.RootSlots[0])
		}},
		{"missing parent", func(p *Payload) {
			p.Nodes = append(p.Nodes, NodeDTO{ID: "c", Type: "bookmark", Title: "C",
				URL: strRef("https://c"), ParentID: strRef("nobody")})
		}},
		{"parent is a bookmark", func(p *Payload) {
			p.Nodes = append(p.Nodes, NodeDTO{ID: "c", Type: "bookmark", Title: "C",
				URL: strRef("https://c"), ParentID: strRef("b")})
		}},
		{"parent cycle", func(p *Payload) {
			p.Nodes = []NodeDTO{
				{ID: "x", Type: "folder", Title: "X", ParentID: strRef("y")},
				{ID: "y", Type: "folder", Title: "Y", ParentID: strRef("x")},
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trees := newFakeTrees()
			trees.add(restoreSpace, "Personal", "Live")
			store := newFakeStore()
			svc, dir := newService(t, store, trees)

			payload := payloadOf(base())
			tc.mutate(&payload)
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			id := seedBackupFile(t, store, dir, "bad-"+tc.name, raw)

			_, safetyID, err := svc.Restore(context.Background(), restoreSpace, id)
			if !errors.Is(err, ErrInvalidPayload) {
				t.Fatalf("Restore err = %v, want ErrInvalidPayload", err)
			}
			if safetyID != "" {
				t.Fatalf("an unusable payload still spent a safety backup: %s", safetyID)
			}
			if store.replacedWith != nil {
				t.Fatalf("baseline replaced from an invalid payload")
			}
			if len(store.rows) != 1 {
				t.Fatalf("catalog gained rows for an invalid payload: %d", len(store.rows))
			}
		})
	}
}

// Export order sorts across the whole space by position, so a folder can land
// after its own children. parent_id is an immediate FK: the store must receive
// parents first or the restore aborts.
func TestRestoreHandsTheStoreParentsBeforeChildren(t *testing.T) {
	trees := newFakeTrees()
	trees.add(restoreSpace, "Personal", "Live")
	store := newFakeStore()
	svc, dir := newService(t, store, trees)

	// Deliberately child-first, which is what ListNodes' ORDER BY
	// position,id produces for a folder sorting after one of its children.
	payload := payloadOf([]NodeDTO{
		{ID: "a", Type: "bookmark", Title: "A", URL: strRef("https://a"), RootKey: strRef("main"), Position: 0},
		{ID: "c", Type: "folder", Title: "C", ParentID: strRef("f"), Position: 0},
		{ID: "f", Type: "folder", Title: "F", RootKey: strRef("main"), Position: 1},
		{ID: "g", Type: "bookmark", Title: "G", URL: strRef("https://g"), ParentID: strRef("c"), Position: 0},
	})
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	id := seedBackupFile(t, store, dir, "deep", raw)

	epoch, safetyID, err := svc.Restore(context.Background(), restoreSpace, id)
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if epoch != 2 || safetyID == "" {
		t.Fatalf("Restore = (%d, %q), want epoch 2 and a safety backup", epoch, safetyID)
	}

	at := map[string]int{}
	for i, n := range store.replacedWith {
		at[n.ID] = i
		if n.ParentID != nil {
			parentAt, ok := at[*n.ParentID]
			if !ok || parentAt > i {
				t.Fatalf("node %s (index %d) precedes its parent %s (%v)", n.ID, i, *n.ParentID, at)
			}
		}
	}
	if len(store.replacedWith) != len(payload.Nodes) {
		t.Fatalf("store received %d nodes, want %d", len(store.replacedWith), len(payload.Nodes))
	}
	if len(store.replacedSlots) != 1 || store.replacedSlots[0].Key != "main" {
		t.Fatalf("root slots = %+v", store.replacedSlots)
	}
}
