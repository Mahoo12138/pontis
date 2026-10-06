package httpapi

import (
	"context"
	"net/http"
	"testing"

	"pontis/internal/auth"
)

// TestLibraryNodeLifecycle exercises the web-facing bookmark REST API
// exactly as the web app consumes it (packages/api endpoints).
func TestLibraryNodeLifecycle(t *testing.T) {
	st := bootstrapFlow(t)
	auth := map[string]string{"Authorization": "Bearer " + st.sessionToken}

	// Root slots back the explorer's tree roots.
	code, body := doJSON(t, "GET", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/root-slots", auth, nil)
	if code != http.StatusOK {
		t.Fatalf("root-slots = %d %v", code, body)
	}
	slots, _ := body["root_slots"].([]any)
	if len(slots) != 1 || slots[0].(map[string]any)["key"] != "main" {
		t.Fatalf("root slots = %v", body)
	}

	// Empty space: no nodes yet.
	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes", auth, nil)
	if code != http.StatusOK {
		t.Fatalf("nodes = %d %v", code, body)
	}
	if nodes, _ := body["nodes"].([]any); len(nodes) != 0 {
		t.Fatalf("expected empty node list, got %v", body)
	}

	// Create a folder and a bookmark inside it.
	code, folder := doJSON(t, "POST", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes", auth,
		map[string]any{"type": "folder", "title": "Development", "parent": map[string]any{"type": "root", "key": "main"}})
	if code != http.StatusCreated {
		t.Fatalf("create folder = %d %v", code, folder)
	}
	folderID := folder["id"].(string)
	if folder["parent_id"] != nil || folder["root_key"] != "main" || folder["url"] != nil {
		t.Fatalf("folder shape = %v", folder)
	}

	code, bookmark := doJSON(t, "POST", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes", auth,
		map[string]any{"type": "bookmark", "title": "GitHub", "url": "https://github.com", "parent": map[string]any{"type": "node", "id": folderID}})
	if code != http.StatusCreated {
		t.Fatalf("create bookmark = %d %v", code, bookmark)
	}
	bookmarkID := bookmark["id"].(string)
	if bookmark["parent_id"] != folderID || bookmark["root_key"] != nil || bookmark["url"] != "https://github.com" {
		t.Fatalf("bookmark shape = %v", bookmark)
	}
	if bookmark["created_revision"].(float64) != 2 {
		t.Fatalf("bookmark created_revision = %v", bookmark["created_revision"])
	}

	// The node list reflects both nodes with the web's exact shape.
	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes", auth, nil)
	if code != http.StatusOK {
		t.Fatalf("node list = %d %v", code, body)
	}
	nodes := body["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("node list = %v", body)
	}

	// Rename the bookmark; the response carries bumped revisions.
	code, updated := doJSON(t, "PATCH", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes/"+bookmarkID, auth,
		map[string]any{"title": "GitHub (official)"})
	if code != http.StatusOK || updated["title"] != "GitHub (official)" {
		t.Fatalf("update = %d %v", code, updated)
	}
	if updated["title_revision"].(float64) != 3 {
		t.Fatalf("title revision = %v", updated["title_revision"])
	}

	// Move the bookmark to the root slot, before nothing (append).
	code, moved := doJSON(t, "PATCH", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes/"+bookmarkID+"/move", auth,
		map[string]any{"parent": map[string]any{"type": "root", "key": "main"}})
	if code != http.StatusOK || moved["parent_id"] != nil || moved["root_key"] != "main" {
		t.Fatalf("move = %d %v", code, moved)
	}
	if moved["structure_revision"].(float64) != 4 {
		t.Fatalf("structure revision = %v", moved["structure_revision"])
	}

	// Activity reflects the operations with journal-derived summaries.
	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/activity", auth, nil)
	if code != http.StatusOK {
		t.Fatalf("activity = %d %v", code, body)
	}
	activity := body["activity"].([]any)
	if len(activity) != 4 {
		t.Fatalf("activity entries = %v", body)
	}
	first := activity[0].(map[string]any)
	if first["action"] != "move" || first["undoable"] != false || first["id"] == "" {
		t.Fatalf("newest activity entry = %v", first)
	}

	// Delete the folder (empty now): 204 and gone from the list.
	code, body = doJSON(t, "DELETE", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes/"+folderID, auth, nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete = %d %v", code, body)
	}
	_, body = doJSON(t, "GET", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes", auth, nil)
	nodes = body["nodes"].([]any)
	if len(nodes) != 1 {
		t.Fatalf("node list after delete = %v", body)
	}

	// Deleting an unknown node is a 404.
	code, body = doJSON(t, "DELETE", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes/"+folderID, auth, nil)
	if code != http.StatusNotFound || errCode(t, body) != "NODE_NOT_FOUND" {
		t.Fatalf("delete unknown = %d %v", code, body)
	}

	// Device listing and settings back the web settings surface.
	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/devices", auth, nil)
	if code != http.StatusOK {
		t.Fatalf("devices = %d %v", code, body)
	}
	if _, ok := body["devices"].([]any); !ok {
		t.Fatalf("devices shape = %v", body)
	}
	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/settings", auth, nil)
	if code != http.StatusOK {
		t.Fatalf("settings = %d %v", code, body)
	}
	settings := body["settings"].(map[string]any)
	if settings["max_spaces_per_user"].(float64) != 16 {
		t.Fatalf("settings = %v", settings)
	}
}

func TestLibraryOwnershipEnforced(t *testing.T) {
	st := bootstrapFlow(t)

	// A second user cannot see the first user's space. Setup only ever
	// creates the first account, so bob is created through the service.
	if _, err := st.srv.Auth.CreateUser(context.Background(), auth.CreateUserParams{
		Username: "bob", Password: "password123",
	}); err != nil {
		t.Fatalf("create bob: %v", err)
	}
	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "bob", "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("bob login = %d %v", code, body)
	}
	bobAuth := map[string]string{"Authorization": "Bearer " + body["token"].(string)}

	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes", bobAuth, nil)
	if code != http.StatusNotFound || errCode(t, body) != "SPACE_NOT_FOUND" {
		t.Fatalf("cross-user node list = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", st.ts.URL+"/api/v1/spaces/"+st.spaceID+"/nodes", bobAuth,
		map[string]any{"type": "bookmark", "title": "X", "url": "https://x.example", "parent": map[string]any{"type": "root", "key": "main"}})
	if code != http.StatusNotFound {
		t.Fatalf("cross-user create = %d %v", code, body)
	}
}
