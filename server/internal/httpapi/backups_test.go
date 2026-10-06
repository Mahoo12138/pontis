package httpapi

import (
	"net/http"
	"testing"
)

func TestBackupLifecycleAndRestore(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	// Create content: a folder and a bookmark.
	code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "开发", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("create folder = %d %v", code, body)
	}
	folderID := body["id"].(string)
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "GitHub", "url": "https://github.com",
		"parent": map[string]string{"type": "node", "id": folderID},
	})
	if code != http.StatusCreated {
		t.Fatalf("create bookmark = %d %v", code, body)
	}
	bookmarkID := body["id"].(string)

	// Capture a backup.
	code, body = doJSON(t, "POST", root+"/backups", h, nil)
	if code != http.StatusCreated {
		t.Fatalf("create backup = %d %v", code, body)
	}
	b1 := body["id"].(string)
	if body["node_count"].(float64) != 2 || body["bookmark_count"].(float64) != 1 {
		t.Fatalf("backup counts wrong: %v", body)
	}

	// Mutate after the backup: rename, add another bookmark.
	_, _ = doJSON(t, "PATCH", root+"/nodes/"+bookmarkID, h, map[string]any{"title": "GitHub Inc"})
	code, _ = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "Extra", "url": "https://extra.example",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("extra bookmark = %d", code)
	}

	// Restore the backup.
	code, body = doJSON(t, "POST", root+"/backups/"+b1+"/restore", h, nil)
	if code != http.StatusOK {
		t.Fatalf("restore = %d %v", code, body)
	}
	if body["new_epoch"].(float64) != 2 {
		t.Fatalf("new epoch = %v, want 2", body["new_epoch"])
	}
	if body["safety_backup_id"] == "" {
		t.Fatalf("no safety backup recorded: %v", body)
	}

	// The tree is back to the snapshot: same ids, original title.
	code, body = doJSON(t, "GET", root+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("nodes after restore = %d %v", code, body)
	}
	nodes := body["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes after restore, got %d", len(nodes))
	}
	titles := map[string]any{}
	for _, n := range nodes {
		m := n.(map[string]any)
		titles[m["id"].(string)] = m["title"]
	}
	if titles[bookmarkID] != "GitHub" {
		t.Fatalf("restored title = %v, want GitHub", titles[bookmarkID])
	}
	if _, ok := titles[folderID]; !ok {
		t.Fatalf("folder id not preserved across restore")
	}

	// A safety backup was recorded; the list shows manual + safety.
	code, body = doJSON(t, "GET", root+"/backups", h, nil)
	if code != http.StatusOK {
		t.Fatalf("list backups = %d %v", code, body)
	}
	backups := body["backups"].([]any)
	kinds := map[string]bool{}
	for _, b := range backups {
		kinds[b.(map[string]any)["kind"].(string)] = true
	}
	if !kinds["manual"] || !kinds["safety"] {
		t.Fatalf("expected manual and safety backups, got %v", backups)
	}

	// Protect the manual backup, delete the safety one.
	code, _ = doJSON(t, "PATCH", root+"/backups/"+b1, h, map[string]any{"protected": true})
	if code != http.StatusOK {
		t.Fatalf("protect = %d", code)
	}
	var safetyID string
	for _, b := range backups {
		m := b.(map[string]any)
		if m["kind"] == "safety" {
			safetyID = m["id"].(string)
		}
	}
	if safetyID != "" {
		code = doEmpty(t, "DELETE", root+"/backups/"+safetyID, h)
		if code != http.StatusNoContent {
			t.Fatalf("delete safety = %d", code)
		}
	}

	// Bob cannot see or touch alice's backups.
	code, _ = doJSON(t, "GET", root+"/backups", map[string]string{"Authorization": "Bearer " + f.bobToken}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("bob list backups = %d", code)
	}
}
