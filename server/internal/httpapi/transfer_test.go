package httpapi

import (
	"net/http"
	"strings"
	"testing"
)

func TestTransferExportImportRoundTrip(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	// Seed a folder with two bookmarks.
	code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "开发", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("folder = %d %v", code, body)
	}
	folderID := body["id"].(string)
	for _, u := range []string{"https://go.dev", "https://github.com"} {
		code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
			"type": "bookmark", "title": u, "url": u,
			"parent": map[string]string{"type": "node", "id": folderID},
		})
		if code != http.StatusCreated {
			t.Fatalf("bookmark %s = %d %v", u, code, body)
		}
	}

	// Export as Netscape HTML: hierarchy and links present.
	code, body = doJSON(t, "POST", root+"/export", h, map[string]string{"format": "netscape_html"})
	if code != http.StatusOK {
		t.Fatalf("export html = %d %v", code, body)
	}
	html := body["content"].(string)
	if !strings.Contains(html, "<DT><H3>开发</H3>") || !strings.Contains(html, `HREF="https://go.dev"`) {
		t.Fatalf("html export missing content: %.200s", html)
	}

	// Export as Native JSON.
	code, body = doJSON(t, "POST", root+"/export", h, map[string]string{"format": "native_json"})
	if code != http.StatusOK {
		t.Fatalf("export json = %d %v", code, body)
	}
	jsonContent := body["content"].(string)
	if !strings.Contains(jsonContent, "pontis-portable-bookmarks") {
		t.Fatalf("json export wrong format: %.120s", jsonContent)
	}

	// Preview an import of the HTML export into the same space: everything kept.
	code, body = doJSON(t, "POST", root+"/import/preview", h,
		map[string]string{"format": "netscape_html", "content": html})
	if code != http.StatusOK {
		t.Fatalf("preview = %d %v", code, body)
	}
	planID := body["plan_id"].(string)
	if body["counts"].(map[string]any)["keep"].(float64) < 3 {
		t.Fatalf("expected keeps in plan, got %v", body["counts"])
	}

	// Garbage content is rejected.
	code, body = doJSON(t, "POST", root+"/import/preview", h,
		map[string]string{"format": "netscape_html", "content": "this is not html"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_IMPORT" {
		t.Fatalf("garbage preview = %d %v", code, body)
	}

	// Apply as merge into root: keeps all matched, creates nothing.
	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "merge"})
	if code != http.StatusOK || body["created"].(float64) != 0 {
		t.Fatalf("merge apply = %d %v", code, body)
	}

	// Stale plan protection: reuse the consumed plan id.
	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "merge"})
	if code != http.StatusNotFound || errCode(t, body) != "PLAN_NOT_FOUND" {
		t.Fatalf("consumed plan reuse = %d %v", code, body)
	}

	// Replace import into a fresh folder wipes the folder's previous content.
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "替换目标", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("target folder = %d %v", code, body)
	}
	targetID := body["id"].(string)
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "will be wiped", "url": "https://wipe.example",
		"parent": map[string]string{"type": "node", "id": targetID},
	})
	if code != http.StatusCreated {
		t.Fatalf("wipee = %d %v", code, body)
	}

	code, body = doJSON(t, "POST", root+"/import/preview", h,
		map[string]string{"format": "native_json", "content": jsonContent})
	if code != http.StatusOK {
		t.Fatalf("json preview = %d %v", code, body)
	}
	planID = body["plan_id"].(string)
	code, body = doJSON(t, "POST", root+"/import/apply", h,
		map[string]any{"plan_id": planID, "parent": map[string]string{"type": "node", "id": targetID}, "strategy": "replace"})
	if code != http.StatusOK {
		t.Fatalf("replace apply = %d %v", code, body)
	}
	if body["created"].(float64) != 3 || body["deleted"].(float64) != 1 {
		t.Fatalf("replace counters = %v, want created=3 deleted=1", body)
	}

	// The target folder now holds the imported subtree: one folder whose
	// two bookmarks live beneath it.
	code, body = doJSON(t, "GET", root+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("nodes = %d %v", code, body)
	}
	inTarget := 0
	titles := map[string]bool{}
	for _, n := range body["nodes"].([]any) {
		m := n.(map[string]any)
		if m["parent_id"] == targetID {
			inTarget++
		}
		titles[m["title"].(string)] = true
	}
	if inTarget != 1 {
		t.Fatalf("target children = %d, want 1 folder", inTarget)
	}
	for _, want := range []string{"开发", "https://go.dev", "https://github.com"} {
		if !titles[want] {
			t.Fatalf("imported node %q missing", want)
		}
	}
	if titles["will be wiped"] {
		t.Fatalf("replace left the old child behind")
	}
}
