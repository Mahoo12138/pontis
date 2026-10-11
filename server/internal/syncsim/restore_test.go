package syncsim

// The stage-C exit condition: a restore is only worth having if the devices
// that were already on the space find their way back by themselves. Their last
// confirmed tree no longer exists, their epoch is dead, and anything they queued
// offline was written against a revision nobody has any more — so the ordinary
// protocol has to carry them home to active, without losing local work and
// without replaying an intent of the dead epoch.

import (
	"testing"

	"pontis/internal/backup"
)

func TestBoundDeviceReturnsToActiveAfterARestore(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	a.CaptureCreate(rootBrowser(a), "bookmark", "Kept", "https://kept.example")
	w.DrainAll()

	if _, err := w.Backups.Create(w.ctx, w.SpaceID, backup.KindManual); err != nil {
		t.Fatalf("backup: %v", err)
	}

	// The device keeps working after the snapshot, with the server gone,
	// against a world that is about to be replaced underneath it.
	w.SetOnline(false)
	a.CaptureCreate(rootBrowser(a), "bookmark", "Made offline", "https://offline.example")
	if a.PendingCount() == 0 {
		t.Fatal("the offline edit queued no operation; the journey below would prove nothing")
	}
	w.SetOnline(true)

	// Someone restores while the device is away.
	newEpoch, safetyID, err := w.Backups.Restore(w.ctx, w.SpaceID, firstBackupID(t, w))
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if newEpoch != 2 {
		t.Fatalf("restore left the space at epoch %d, want 2", newEpoch)
	}
	if safetyID == "" {
		t.Error("the restore took no safety backup of the tree it replaced")
	}
	if _, now := w.ServerHead(); now != 0 {
		t.Fatalf("space revision after restore = %d, want the 0 baseline", now)
	}

	// The device comes back. Its binding is pending_initial on an epoch it has
	// never seen, so an incremental round is not available to it: the initial
	// reconciliation is the ordinary way home.
	if err := a.Initialize(); err != nil {
		t.Fatalf("re-initialize after the restore: %v", err)
	}
	w.DrainAll()

	// Nothing of the dead epoch survives into the new journal.
	var stale int
	if err := w.db.QueryRow(`SELECT COUNT(*) FROM journal WHERE space_id = ? AND epoch = 1`,
		string(w.SpaceID)).Scan(&stale); err != nil {
		t.Fatal(err)
	}
	if stale != 0 {
		t.Errorf("%d journal rows of epoch 1 survived a restore to epoch 2", stale)
	}

	// The user's offline work is still there. Convergence alone would also be
	// satisfied by a reconciliation that dropped it from the browser to match
	// the restored tree, which is data loss wearing a green badge.
	if _, found := w.ServerTree().Nodes[serverIDByTitle(t, w, "Made offline")]; !found {
		t.Fatal("the bookmark made while offline disappeared in the restore round trip")
	}
	if serverIDByTitle(t, w, "Kept") == "" {
		t.Error("the restored bookmark is missing")
	}
}

// firstBackupID reads back the newest manual backup of the world's space.
func firstBackupID(t *testing.T, w *World) string {
	t.Helper()
	var id string
	if err := w.db.QueryRow(`SELECT id FROM space_backups WHERE space_id = ? ORDER BY created_at DESC, id LIMIT 1`,
		string(w.SpaceID)).Scan(&id); err != nil {
		t.Fatalf("no backup row: %v", err)
	}
	return id
}

// A device that edited while the server was away comes back to a world the
// restore replaced underneath it. Neither half of its work may be silently
// rewritten: the bookmark it made must exist exactly once (not once from the
// snapshot and once from the replayed create), and the bookmark it deleted must
// stay deleted rather than be resurrected by an older snapshot. The restore is
// still safe precisely because the state it overwrote is kept on disk.
func TestOfflineEditsSurviveARestore(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	kept := a.CaptureCreate(rootBrowser(a), "bookmark", "Kept", "https://kept.example")
	a.CaptureCreate(rootBrowser(a), "bookmark", "Also kept", "https://also.example")
	w.DrainAll()

	restored, err := w.Backups.Create(w.ctx, w.SpaceID, backup.KindManual)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}

	w.SetOnline(false)
	a.CaptureCreate(rootBrowser(a), "bookmark", "Made offline", "https://offline.example")
	a.CaptureDelete(kept)
	if a.PendingCount() < 2 {
		t.Fatalf("the offline edits queued %d operations, want a create and a delete", a.PendingCount())
	}
	w.SetOnline(true)

	newEpoch, safetyID, err := w.Backups.Restore(w.ctx, w.SpaceID, restored.ID)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if newEpoch != 2 {
		t.Fatalf("epoch = %d, want 2", newEpoch)
	}
	if safetyID == "" {
		t.Fatal("the restore overwrote a tree without keeping a copy of it")
	}

	if err := a.Initialize(); err != nil {
		t.Fatalf("re-initialize after the restore: %v", err)
	}
	w.DrainAll()

	titles := map[string]int{}
	for _, n := range w.ServerTree().Nodes {
		titles[n.Title]++
	}
	if titles["Made offline"] != 1 {
		t.Errorf("%d copies of the offline bookmark on the server, want exactly 1", titles["Made offline"])
	}
	if titles["Kept"] != 0 {
		t.Errorf("the bookmark deleted offline came back %d times from the restored snapshot", titles["Kept"])
	}
	if titles["Also kept"] != 1 {
		t.Errorf("%d copies of the untouched bookmark, want 1", titles["Also kept"])
	}

	// The safety backup is a readable state, not a placeholder — and what it
	// keeps is the tree the *server* held, because the offline work above never
	// reached it.
	safety, err := w.Backups.Get(w.ctx, safetyID)
	if err != nil {
		t.Fatalf("the safety backup is not readable: %v", err)
	}
	if safety.Kind != backup.KindSafety {
		t.Errorf("safety backup kind = %s, want safety", safety.Kind)
	}
	payload, err := w.Backups.ReadPayload(w.ctx, w.SpaceID, safetyID)
	if err != nil {
		t.Fatalf("read the safety payload: %v", err)
	}
	held := map[string]bool{}
	for _, n := range payload.Nodes {
		held[n.Title] = true
	}
	if !held["Kept"] || !held["Also kept"] {
		t.Errorf("safety backup holds %v, want the server tree the restore replaced", held)
	}
	if held["Made offline"] {
		t.Errorf("the safety backup contains device-side work that never reached the server: %v", held)
	}
}
