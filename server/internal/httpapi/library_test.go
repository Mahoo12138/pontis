package httpapi

import (
	"fmt"
	"net/http"
	"testing"

	"pontis/internal/auth"
)

// libraryFlow bootstraps an instance with two users: alice (admin, owns a
// space) and bob (a second account that must not touch alice's tree).
type libraryFlow struct {
	flowState
	bobToken string
}

// doEmpty issues a request whose response body is expected to be empty.
func doEmpty(t *testing.T, method, url string, headers map[string]string) int {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func bootstrapLibraryFlow(t *testing.T) *libraryFlow {
	t.Helper()
	base := bootstrapFlow(t)
	f := &libraryFlow{flowState: *base}

	// A second account, created directly via the auth service (registration
	// is closed via the API in V1).
	if _, err := f.srv.Auth.CreateUser(t.Context(), auth.CreateUserParams{
		Username: "bob", Password: "password123",
	}); err != nil {
		t.Fatalf("create bob: %v", err)
	}
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "bob", "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("bob login = %d %v", code, body)
	}
	f.bobToken = body["token"].(string)
	return f
}

func TestNodesCRUDAndActivity(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := fmt.Sprintf("%s/api/v1/spaces/%s", f.ts.URL, f.spaceID)

	// Empty tree on a fresh space.
	code, body := doJSON(t, "GET", root+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("list nodes = %d %v", code, body)
	}
	if got := len(body["nodes"].([]any)); got != 0 {
		t.Fatalf("fresh space has %d nodes, want 0", got)
	}

	// Root slots exist with the default Main slot.
	code, body = doJSON(t, "GET", root+"/root-slots", h, nil)
	if code != http.StatusOK {
		t.Fatalf("root slots = %d %v", code, body)
	}
	slots := body["root_slots"].([]any)
	if len(slots) != 1 || slots[0].(map[string]any)["key"] != "main" {
		t.Fatalf("unexpected root slots %v", slots)
	}

	// Create a folder under the root slot.
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "开发", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("create folder = %d %v", code, body)
	}
	folderID := body["id"].(string)

	// Create a bookmark inside the folder.
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "GitHub", "url": "https://github.com",
		"parent": map[string]string{"type": "node", "id": folderID},
	})
	if code != http.StatusCreated {
		t.Fatalf("create bookmark = %d %v", code, body)
	}
	bookmarkID := body["id"].(string)

	// A bookmark without a URL is rejected.
	code, body = doJSON(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "no url", "parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusBadRequest || errCode(t, body) != "URL_REQUIRED" {
		t.Fatalf("bookmark without url = %d %v", code, body)
	}

	// Rename the folder and edit the bookmark URL.
	code, body = doJSON(t, "PATCH", root+"/nodes/"+folderID, h, map[string]any{"title": "开发资源"})
	if code != http.StatusOK || body["title"] != "开发资源" {
		t.Fatalf("rename = %d %v", code, body)
	}
	code, body = doJSON(t, "PATCH", root+"/nodes/"+bookmarkID, h, map[string]any{"url": "https://github.com/explore"})
	if code != http.StatusOK || body["url"] != "https://github.com/explore" {
		t.Fatalf("url update = %d %v", code, body)
	}

	// Move the bookmark back to the root slot.
	code, body = doJSON(t, "PUT", root+"/nodes/"+bookmarkID+"/move", h,
		map[string]any{"parent": map[string]string{"type": "root", "key": "main"}})
	if code != http.StatusOK {
		t.Fatalf("move = %d %v", code, body)
	}
	if got := body["parent_id"]; got != nil {
		t.Fatalf("moved bookmark still has parent_id %v", got)
	}
	if got := body["root_key"].(string); got != "main" {
		t.Fatalf("moved bookmark root_key = %v", got)
	}

	// Deleting the (now empty) folder works; deleting a missing node 404s.
	code = doEmpty(t, "DELETE", root+"/nodes/"+folderID, h)
	if code != http.StatusNoContent {
		t.Fatalf("delete folder = %d", code)
	}
	code, body = doJSON(t, "DELETE", root+"/nodes/"+folderID, h, nil)
	if code != http.StatusNotFound || errCode(t, body) != "NODE_NOT_FOUND" {
		t.Fatalf("delete missing node = %d %v", code, body)
	}

	// The journal produced a readable activity feed.
	code, body = doJSON(t, "GET", root+"/activity", h, nil)
	if code != http.StatusOK {
		t.Fatalf("activity = %d %v", code, body)
	}
	entries := body["activity"].([]any)
	if len(entries) < 5 {
		t.Fatalf("expected at least 5 activity entries, got %d", len(entries))
	}
	first := entries[0].(map[string]any)
	if first["summary"] == "" || first["actor"] == "" || first["action"] == "" {
		t.Fatalf("activity entry missing fields: %v", first)
	}
}

func TestNodesOwnershipEnforced(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	aliceHeader := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bobHeader := map[string]string{"Authorization": "Bearer " + f.bobToken}
	root := fmt.Sprintf("%s/api/v1/spaces/%s", f.ts.URL, f.spaceID)

	// Bob cannot read or mutate alice's space.
	code, body := doJSON(t, "GET", root+"/nodes", bobHeader, nil)
	if code != http.StatusForbidden || errCode(t, body) != "NOT_SPACE_OWNER" {
		t.Fatalf("bob list = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", root+"/nodes", bobHeader, map[string]any{
		"type": "bookmark", "title": "x", "url": "https://x.example",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusForbidden {
		t.Fatalf("bob create = %d %v", code, body)
	}

	// Alice creates a node; bob cannot modify or delete it.
	code, body = doJSON(t, "POST", root+"/nodes", aliceHeader, map[string]any{
		"type": "bookmark", "title": "mine", "url": "https://mine.example",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("alice create = %d %v", code, body)
	}
	nodeID := body["id"].(string)

	code, _ = doJSON(t, "PATCH", root+"/nodes/"+nodeID, bobHeader, map[string]any{"title": "stolen"})
	if code != http.StatusForbidden {
		t.Fatalf("bob patch = %d", code)
	}
	code, _ = doJSON(t, "DELETE", root+"/nodes/"+nodeID, bobHeader, nil)
	if code != http.StatusForbidden {
		t.Fatalf("bob delete = %d", code)
	}

	// Unknown space 404s rather than leaking existence.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/nope/nodes", aliceHeader, nil)
	if code != http.StatusNotFound || errCode(t, body) != "SPACE_NOT_FOUND" {
		t.Fatalf("unknown space = %d %v", code, body)
	}
}
