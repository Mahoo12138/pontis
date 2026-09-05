package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

// activityEntries fetches the space's activity feed as generic maps.
func activityEntries(t *testing.T, tsURL, spaceID, token string) []map[string]any {
	t.Helper()
	code, body := doJSON(t, "GET", tsURL+"/api/v1/spaces/"+spaceID+"/activity",
		map[string]string{"Authorization": "Bearer " + token}, nil)
	if code != http.StatusOK {
		t.Fatalf("activity = %d %v", code, body)
	}
	raw, _ := body["activity"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, e := range raw {
		out = append(out, e.(map[string]any))
	}
	return out
}

func findEntryBySummary(t *testing.T, entries []map[string]any, summary string) map[string]any {
	t.Helper()
	for _, e := range entries {
		if e["summary"] == summary {
			return e
		}
	}
	t.Fatalf("no activity entry with summary %q in %v", summary, entries)
	return nil
}

// TestActivityUndoFlow covers the real undo loop: CRUD records ChangeSets,
// the feed exposes undoable state, the undo endpoint executes the inverse
// and the feed reflects the undone + undo entries.
func TestActivityUndoFlow(t *testing.T) {
	f := bootstrapFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := fmt.Sprintf("%s/api/v1/spaces/%s", f.ts.URL, f.spaceID)

	// Create and rename a bookmark.
	code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "GitHub", "url": "https://github.com",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("create bookmark = %d %v", code, body)
	}
	bookmarkID := body["id"].(string)
	code, body = doJSON(t, "PATCH", root+"/nodes/"+bookmarkID, h, map[string]any{"title": "GH"})
	if code != http.StatusOK {
		t.Fatalf("rename = %d %v", code, body)
	}

	entries := activityEntries(t, f.ts.URL, f.spaceID, f.sessionToken)
	rename := findEntryBySummary(t, entries, "修改了「GitHub」的标题")
	if rename["undoable"] != true || rename["undone"] != false || rename["action"] != "update" {
		t.Fatalf("rename entry = %v", rename)
	}
	renameID := rename["id"].(string)

	// Undo the rename through the real endpoint.
	code, body = doJSON(t, "POST", root+"/changesets/"+renameID+"/undo", h, nil)
	if code != http.StatusOK || body["status"] != "clean" {
		t.Fatalf("undo = %d %v", code, body)
	}

	// The tree reflects the inverse.
	code, body = doJSON(t, "GET", root+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("list nodes = %d", code)
	}
	for _, n := range body["nodes"].([]any) {
		if n.(map[string]any)["id"] == bookmarkID {
			if n.(map[string]any)["title"] != "GitHub" {
				t.Fatalf("title after undo = %v", n.(map[string]any)["title"])
			}
		}
	}

	// The feed shows the undone state plus the undo operation itself.
	entries = activityEntries(t, f.ts.URL, f.spaceID, f.sessionToken)
	rename = findEntryBySummary(t, entries, "修改了「GitHub」的标题")
	if rename["undone"] != true || rename["undoable"] != false {
		t.Fatalf("renamed entry after undo = %v", rename)
	}
	undoEntry := findEntryBySummary(t, entries, "撤销：修改了「GitHub」的标题")
	if undoEntry["action"] != "undo" || undoEntry["undoable"] != false {
		t.Fatalf("undo entry = %v", undoEntry)
	}

	// Second undo of the same ChangeSet is rejected.
	code, body = doJSON(t, "POST", root+"/changesets/"+renameID+"/undo", h, nil)
	if code != http.StatusConflict || errCode(t, body) != "ALREADY_UNDONE" {
		t.Fatalf("double undo = %d %v", code, body)
	}
}

func TestUndoReviewRequiredSurfacesReasons(t *testing.T) {
	f := bootstrapFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := fmt.Sprintf("%s/api/v1/spaces/%s", f.ts.URL, f.spaceID)

	code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "Go", "url": "https://go.dev",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("create = %d %v", code, body)
	}
	bookmarkID := body["id"].(string)
	for _, title := range []string{"First", "Second"} {
		code, body = doJSON(t, "PATCH", root+"/nodes/"+bookmarkID, h, map[string]any{"title": title})
		if code != http.StatusOK {
			t.Fatalf("rename %s = %d %v", title, code, body)
		}
	}

	// Undoing the FIRST rename hits a later edit: review, nothing applied.
	entries := activityEntries(t, f.ts.URL, f.spaceID, f.sessionToken)
	first := findEntryBySummary(t, entries, "修改了「Go」的标题")
	firstID := first["id"].(string)
	code, body = doJSON(t, "POST", root+"/changesets/"+firstID+"/undo", h, nil)
	if code != http.StatusConflict || errCode(t, body) != "REVIEW_REQUIRED" {
		t.Fatalf("review undo = %d %v", code, body)
	}
	errBody, _ := body["error"].(map[string]any)
	details, _ := errBody["details"].(map[string]any)
	if reasons, ok := details["reasons"].([]any); !ok || len(reasons) == 0 {
		t.Fatalf("review without reasons: %v", body)
	}

	code, body = doJSON(t, "GET", root+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("list nodes = %d", code)
	}
	title := ""
	for _, n := range body["nodes"].([]any) {
		if n.(map[string]any)["id"] == bookmarkID {
			title, _ = n.(map[string]any)["title"].(string)
		}
	}
	if title != "Second" {
		t.Fatalf("review overwrote later state: title = %q", title)
	}
}

func TestActivityShowsDeviceActor(t *testing.T) {
	f := bootstrapFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	deviceAuth := map[string]string{"Authorization": "Bearer " + f.deviceToken}

	// A device-side create lands in the same activity feed with the device
	// as actor and is undoable like any primitive.
	syncBody := map[string]any{
		"protocol_version": 1, "epoch": 1,
		"applied_revision": 0, "received_revision": 0, "max_changes": 100,
		"operations": []map[string]any{{
			"op_id": "op-dev-1", "client_seq": 1, "base_revision": 0,
			"type": "create", "node_id": "22222222-2222-7222-8222-222222222222",
			"node_type": "bookmark", "title": "From Edge", "url": "https://edge.dev",
			"parent": map[string]string{"type": "root", "key": "main"},
		}},
	}
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/sync/bindings/"+f.bindingID, deviceAuth, syncBody)
	if code != http.StatusOK {
		t.Fatalf("sync = %d %v", code, body)
	}

	entries := activityEntries(t, f.ts.URL, f.spaceID, f.sessionToken)
	entry := findEntryBySummary(t, entries, "新建了「From Edge」")
	if entry["actor"] != "Edge@Home" || entry["undoable"] != true {
		t.Fatalf("device entry = %v", entry)
	}

	// The device-side operation is undoable from the web.
	undoURL := fmt.Sprintf("%s/api/v1/spaces/%s/changesets/%s/undo", f.ts.URL, f.spaceID, entry["id"].(string))
	code, body = doJSON(t, "POST", undoURL, h, nil)
	if code != http.StatusOK || body["status"] != "clean" {
		t.Fatalf("undo device op = %d %v", code, body)
	}
}
