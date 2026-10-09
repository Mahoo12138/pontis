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

// Two accounts both keeping a space called "Personal" is the ordinary case.
// Their backups must not share storage, and restoring one must never apply
// the other's tree.
func TestBackupsOfEquallyNamedSpacesStayIndependent(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	alice := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bob := map[string]string{"Authorization": "Bearer " + f.bobToken}
	aliceRoot := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", bob, map[string]string{"name": "Personal"})
	if code != http.StatusCreated {
		t.Fatalf("bob create space = %d %v", code, body)
	}
	bobRoot := f.ts.URL + "/api/v1/spaces/" + body["id"].(string)

	addBookmark := func(t *testing.T, base string, h map[string]string, title string) {
		t.Helper()
		code, body := doJSON(t, "POST", base+"/nodes", h, map[string]any{
			"type": "bookmark", "title": title, "url": "https://" + title + ".example",
			"parent": map[string]string{"type": "root", "key": "main"},
		})
		if code != http.StatusCreated {
			t.Fatalf("create %s = %d %v", title, code, body)
		}
	}
	backupID := func(t *testing.T, base string, h map[string]string) string {
		t.Helper()
		code, body := doJSON(t, "POST", base+"/backups", h, nil)
		if code != http.StatusCreated {
			t.Fatalf("create backup = %d %v", code, body)
		}
		return body["id"].(string)
	}
	titles := func(t *testing.T, base string, h map[string]string) map[string]bool {
		t.Helper()
		code, body := doJSON(t, "GET", base+"/nodes", h, nil)
		if code != http.StatusOK {
			t.Fatalf("list nodes = %d %v", code, body)
		}
		got := map[string]bool{}
		for _, n := range body["nodes"].([]any) {
			got[n.(map[string]any)["title"].(string)] = true
		}
		return got
	}

	addBookmark(t, aliceRoot, alice, "alice")
	addBookmark(t, bobRoot, bob, "bob")
	aBackup := backupID(t, aliceRoot, alice)
	bBackup := backupID(t, bobRoot, bob)

	addBookmark(t, aliceRoot, alice, "alice-later")
	addBookmark(t, bobRoot, bob, "bob-later")

	for _, tc := range []struct {
		base, id, want string
		h              map[string]string
	}{
		{aliceRoot, aBackup, "alice", alice},
		{bobRoot, bBackup, "bob", bob},
	} {
		code, body = doJSON(t, "POST", tc.base+"/backups/"+tc.id+"/restore", tc.h, nil)
		if code != http.StatusOK {
			t.Fatalf("restore %s = %d %v", tc.want, code, body)
		}
		got := titles(t, tc.base, tc.h)
		if !got[tc.want] || got[tc.want+"-later"] {
			t.Fatalf("restore of %s produced %v, want only %q", tc.id, got, tc.want)
		}
	}
}

// Creating a second backup right after the first must not consume the first
// payload, and a delete only ever removes its own file.
func TestRepeatedBackupsRestoreTheirOwnSnapshots(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	add := func(title string) {
		t.Helper()
		code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
			"type": "bookmark", "title": title, "url": "https://" + title + ".example",
			"parent": map[string]string{"type": "root", "key": "main"},
		})
		if code != http.StatusCreated {
			t.Fatalf("create %s = %d %v", title, code, body)
		}
	}
	add("first")
	_, body := doJSON(t, "POST", root+"/backups", h, nil)
	first := body["id"].(string)
	add("second")
	_, body = doJSON(t, "POST", root+"/backups", h, nil)
	second := body["id"].(string)

	// Drop the newest row: the older snapshot has to stay restorable.
	if code := doEmpty(t, "DELETE", root+"/backups/"+second, h); code != http.StatusNoContent {
		t.Fatalf("delete second = %d", code)
	}
	if code, body := doJSON(t, "POST", root+"/backups/"+first+"/restore", h, nil); code != http.StatusOK {
		t.Fatalf("restore first = %d %v", code, body)
	}
	_, body = doJSON(t, "GET", root+"/nodes", h, nil)
	got := map[string]bool{}
	for _, n := range body["nodes"].([]any) {
		got[n.(map[string]any)["title"].(string)] = true
	}
	if !got["first"] || got["second"] {
		t.Fatalf("restored tree = %v, want only the first snapshot", got)
	}
}
