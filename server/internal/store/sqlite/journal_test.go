package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"

	"pontis/internal/canonical"
)

type journalRow struct {
	Epoch      int64
	Revision   int64
	ChangeType string
	NodeID     string
	Payload    string
	OriginType string
	OpID       *string
	ClientSeq  *int64
}

func loadJournal(t *testing.T, store *Store, space canonical.SpaceID) []journalRow {
	t.Helper()
	rows, err := store.db.Query(`
		SELECT epoch, revision, change_type, COALESCE(node_id, ''), payload, origin_type, op_id, origin_client_seq
		FROM journal WHERE space_id = ? ORDER BY revision`, string(space))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var out []journalRow
	for rows.Next() {
		var r journalRow
		if err := rows.Scan(&r.Epoch, &r.Revision, &r.ChangeType, &r.NodeID, &r.Payload, &r.OriginType, &r.OpID, &r.ClientSeq); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func tombstoneRevision(t *testing.T, store *Store, space canonical.SpaceID, node canonical.NodeID) (int64, bool) {
	t.Helper()
	var rev int64
	err := store.db.QueryRow(`SELECT deleted_revision FROM tombstones WHERE space_id = ? AND node_id = ?`,
		string(space), string(node)).Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return rev, true
}

func TestJournalContinuousAndTyped(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	f := canonical.NodeID("f")
	bm := canonical.NodeID("bm")
	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: space, NodeID: f, Type: canonical.NodeTypeFolder, Title: "F", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: bm, Type: canonical.NodeTypeBookmark, Title: "BM", URL: "https://bm", Parent: canonical.NewNodeParent(f)},
	)
	mustExec(t, e, store, canonical.UpdateNodeTitle{SpaceID: space, NodeID: bm, Title: "BM2"})
	mustExec(t, e, store, canonical.UpdateNodeURL{SpaceID: space, NodeID: bm, URL: "https://bm2"})
	mustExec(t, e, store, canonical.MoveNode{SpaceID: space, NodeID: bm, Parent: main})
	mustExec(t, e, store, canonical.DeleteNode{SpaceID: space, NodeID: bm})

	journal := loadJournal(t, store, space)
	if len(journal) != 6 {
		t.Fatalf("journal entries = %d, want 6", len(journal))
	}

	gotTypes := []string{}
	for i, r := range journal {
		if r.Epoch != 1 {
			t.Errorf("entry %d epoch = %d, want 1", i, r.Epoch)
		}
		if r.Revision != int64(i+1) {
			t.Errorf("entry %d revision = %d, want %d", i, r.Revision, i+1)
		}
		if r.OriginType != "system" {
			t.Errorf("entry %d origin_type = %q, want system", i, r.OriginType)
		}
		gotTypes = append(gotTypes, r.ChangeType)
	}
	want := []string{"create", "create", "update_title", "update_url", "move", "delete"}
	for i, w := range want {
		if gotTypes[i] != w {
			t.Errorf("journal[%d] type = %q, want %q", i, gotTypes[i], w)
		}
	}

	// The move entry payload must carry the wire parent format.
	var movePayload struct {
		Parent   journalParent `json:"parent"`
		Position int64         `json:"position"`
	}
	if err := json.Unmarshal([]byte(journal[4].Payload), &movePayload); err != nil {
		t.Fatalf("unmarshal move payload: %v", err)
	}
	if movePayload.Parent.Type != "root" || movePayload.Parent.Key != "main" {
		t.Errorf("move payload parent = %+v, want root/main", movePayload.Parent)
	}
	// main already contains f, so the appended bm lands at position 1.
	if movePayload.Position != 1 {
		t.Errorf("move payload position = %d, want 1", movePayload.Position)
	}
}

func TestJournalOriginColumns(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	seq := int64(382)
	origin := canonical.Origin{
		Type:      canonical.OriginDevice,
		UserID:    "u1",
		DeviceID:  "d1",
		BindingID: "b1",
		ClientSeq: &seq,
		OpID:      "op-1",
	}
	err := e.Execute(context.Background(), store, origin,
		canonical.CreateNode{SpaceID: space, NodeID: "n1", Type: canonical.NodeTypeBookmark, Title: "N1", URL: "https://n1", Parent: main},
	)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	journal := loadJournal(t, store, space)
	if len(journal) != 1 {
		t.Fatalf("journal entries = %d, want 1", len(journal))
	}
	r := journal[0]
	if r.OriginType != "device" {
		t.Errorf("origin_type = %q, want device", r.OriginType)
	}
	if r.OpID == nil || *r.OpID != "op-1" {
		t.Errorf("op_id = %v, want op-1", r.OpID)
	}
	if r.ClientSeq == nil || *r.ClientSeq != 382 {
		t.Errorf("origin_client_seq = %v, want 382", r.ClientSeq)
	}

	var originCols struct {
		UserID    *string
		DeviceID  *string
		BindingID *string
	}
	if err := store.db.QueryRow(`
		SELECT origin_user_id, origin_device_id, origin_binding_id
		FROM journal WHERE space_id = ? AND revision = 1`, string(space)).
		Scan(&originCols.UserID, &originCols.DeviceID, &originCols.BindingID); err != nil {
		t.Fatal(err)
	}
	if originCols.UserID == nil || *originCols.UserID != "u1" {
		t.Errorf("origin_user_id = %v, want u1", originCols.UserID)
	}
	if originCols.DeviceID == nil || *originCols.DeviceID != "d1" {
		t.Errorf("origin_device_id = %v, want d1", originCols.DeviceID)
	}
	if originCols.BindingID == nil || *originCols.BindingID != "b1" {
		t.Errorf("origin_binding_id = %v, want b1", originCols.BindingID)
	}
}

func TestDeleteWritesTombstonesAndSingleJournalEntry(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	f := canonical.NodeID("f")
	c1 := canonical.NodeID("c1")
	f2 := canonical.NodeID("f2")
	c2 := canonical.NodeID("c2")
	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: space, NodeID: f, Type: canonical.NodeTypeFolder, Title: "F", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: c1, Type: canonical.NodeTypeBookmark, Title: "C1", URL: "https://c1", Parent: canonical.NewNodeParent(f)},
		canonical.CreateNode{SpaceID: space, NodeID: f2, Type: canonical.NodeTypeFolder, Title: "F2", Parent: canonical.NewNodeParent(f)},
		canonical.CreateNode{SpaceID: space, NodeID: c2, Type: canonical.NodeTypeBookmark, Title: "C2", URL: "https://c2", Parent: canonical.NewNodeParent(f2)},
	)

	journalBefore := len(loadJournal(t, store, space)) // 4 creates
	mustExec(t, e, store, canonical.DeleteNode{SpaceID: space, NodeID: f})

	journal := loadJournal(t, store, space)
	if len(journal) != journalBefore+1 {
		t.Fatalf("journal entries = %d, want %d (one top-level delete)", len(journal), journalBefore+1)
	}
	del := journal[len(journal)-1]
	if del.ChangeType != "delete" || del.NodeID != string(f) {
		t.Errorf("delete entry = %+v", del)
	}

	var payload struct {
		Count int64 `json:"count"`
	}
	if err := json.Unmarshal([]byte(del.Payload), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Count != 4 {
		t.Errorf("delete count = %d, want 4", payload.Count)
	}

	// Every subtree node has a tombstone at the delete revision.
	for _, id := range []canonical.NodeID{f, c1, f2, c2} {
		rev, ok := tombstoneRevision(t, store, space, id)
		if !ok {
			t.Errorf("tombstone for %s missing", id)
			continue
		}
		if rev != del.Revision {
			t.Errorf("tombstone %s revision = %d, want %d", id, rev, del.Revision)
		}
	}
}

func TestJournalRollbackOnFailure(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	err := e.Execute(context.Background(), store, canonical.Origin{Type: canonical.OriginSystem},
		canonical.CreateNode{SpaceID: space, NodeID: "ok", Type: canonical.NodeTypeBookmark, Title: "OK", URL: "https://ok", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: "bad", Type: canonical.NodeTypeBookmark, Title: "Bad", Parent: main},
	)
	if !errors.Is(err, canonical.ErrURLRequired) {
		t.Fatalf("err = %v, want ErrURLRequired", err)
	}

	if journal := loadJournal(t, store, space); len(journal) != 0 {
		t.Errorf("journal entries = %d, want 0 after rollback", len(journal))
	}
	if _, ok := tombstoneRevision(t, store, space, "ok"); ok {
		t.Error("no tombstones expected after rollback")
	}
}
