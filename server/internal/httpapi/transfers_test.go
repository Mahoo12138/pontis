package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

// createTestNode posts a node to the session library endpoint.
func createTestNode(t *testing.T, st *flowState, spaceID string, req map[string]any) string {
	t.Helper()
	code, body := doJSON(t, "POST", fmt.Sprintf("%s/api/v1/spaces/%s/nodes", st.ts.URL, spaceID),
		map[string]string{"Authorization": "Bearer " + st.sessionToken}, req)
	if code != http.StatusCreated {
		t.Fatalf("create node = %d %v", code, body)
	}
	id, _ := body["id"].(string)
	return id
}

func listNodeTitles(t *testing.T, st *flowState, spaceID string) map[string]bool {
	t.Helper()
	code, body := doJSON(t, "GET", fmt.Sprintf("%s/api/v1/spaces/%s/nodes", st.ts.URL, spaceID),
		map[string]string{"Authorization": "Bearer " + st.sessionToken}, nil)
	if code != http.StatusOK {
		t.Fatalf("list nodes = %d %v", code, body)
	}
	out := map[string]bool{}
	nodes, _ := body["nodes"].([]any)
	for _, n := range nodes {
		m, _ := n.(map[string]any)
		title, _ := m["title"].(string)
		out[title] = true
	}
	return out
}

func TestTransferEndpoints(t *testing.T) {
	st := bootstrapFlow(t)
	sessionAuth := map[string]string{"Authorization": "Bearer " + st.sessionToken}
	deviceAuth := map[string]string{"Authorization": "Bearer " + st.deviceToken}

	// Second space owned by the same user.
	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/spaces", sessionAuth,
		map[string]string{"name": "Work"})
	if code != http.StatusCreated {
		t.Fatalf("second space = %d %v", code, body)
	}
	targetSpace, _ := body["id"].(string)

	// Seed a folder subtree in the source space.
	folder := createTestNode(t, st, st.spaceID, map[string]any{
		"type": "folder", "title": "Dev", "parent": map[string]string{"type": "root", "key": "main"},
	})
	createTestNode(t, st, st.spaceID, map[string]any{
		"type": "bookmark", "title": "Go", "url": "https://go.dev",
		"parent": map[string]string{"type": "node", "id": folder},
	})

	// Session endpoint moves the folder (and its child) to Work.
	code, body = doJSON(t, "POST", fmt.Sprintf("%s/api/v1/spaces/%s/transfers", st.ts.URL, st.spaceID),
		sessionAuth, map[string]any{
			"transfer_id":     "tw-1",
			"target_space_id": targetSpace,
			"node_id":         folder,
			"target_parent":   map[string]string{"type": "root", "key": "main"},
		})
	if code != http.StatusOK {
		t.Fatalf("session transfer = %d %v", code, body)
	}
	mapping, _ := body["mapping"].([]any)
	if len(mapping) != 2 {
		t.Fatalf("mapping = %v", mapping)
	}
	if body["source_revision"] == body["target_revision"] {
		t.Errorf("revisions = %v", body)
	}

	if listNodeTitles(t, st, st.spaceID)["Dev"] {
		t.Error("source still holds transferred subtree")
	}
	if !listNodeTitles(t, st, targetSpace)["Dev"] || !listNodeTitles(t, st, targetSpace)["Go"] {
		t.Error("target missing transferred subtree")
	}

	// Idempotent replay returns the same mapping.
	replayCode, replayBody := doJSON(t, "POST", fmt.Sprintf("%s/api/v1/spaces/%s/transfers", st.ts.URL, st.spaceID),
		sessionAuth, map[string]any{
			"transfer_id":     "tw-1",
			"target_space_id": targetSpace,
			"node_id":         folder,
			"target_parent":   map[string]string{"type": "root", "key": "main"},
		})
	if replayCode != http.StatusOK || fmt.Sprint(replayBody["mapping"]) != fmt.Sprint(body["mapping"]) {
		t.Fatalf("replay = %d %v, want %d %v", replayCode, replayBody, http.StatusOK, body)
	}

	// Reusing the transfer id with a different payload conflicts.
	other := createTestNode(t, st, st.spaceID, map[string]any{
		"type": "folder", "title": "Other", "parent": map[string]string{"type": "root", "key": "main"},
	})
	code, body = doJSON(t, "POST", fmt.Sprintf("%s/api/v1/spaces/%s/transfers", st.ts.URL, st.spaceID),
		sessionAuth, map[string]any{
			"transfer_id":     "tw-1",
			"target_space_id": targetSpace,
			"node_id":         other,
			"target_parent":   map[string]string{"type": "root", "key": "main"},
		})
	if code != http.StatusConflict || errCode(t, body) != "TRANSFER_ID_REUSED" {
		t.Fatalf("conflict = %d %v", code, body)
	}

	// Device endpoint moves another subtree using source_space_id.
	code, body = doJSON(t, "POST", st.ts.URL+"/api/v1/sync/transfers", deviceAuth, map[string]any{
		"transfer_id":     "tw-2",
		"source_space_id": st.spaceID,
		"target_space_id": targetSpace,
		"node_id":         other,
		"target_parent":   map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusOK {
		t.Fatalf("device transfer = %d %v", code, body)
	}
	if len(body["mapping"].([]any)) != 1 {
		t.Fatalf("device mapping = %v", body["mapping"])
	}

	// Error mapping: same space and unknown node.
	code, body = doJSON(t, "POST", fmt.Sprintf("%s/api/v1/spaces/%s/transfers", st.ts.URL, st.spaceID),
		sessionAuth, map[string]any{
			"transfer_id":     "tw-3",
			"target_space_id": st.spaceID,
			"node_id":         other,
			"target_parent":   map[string]string{"type": "root", "key": "main"},
		})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_TRANSFER" {
		t.Fatalf("same space = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", fmt.Sprintf("%s/api/v1/spaces/%s/transfers", st.ts.URL, st.spaceID),
		sessionAuth, map[string]any{
			"transfer_id":     "tw-4",
			"target_space_id": targetSpace,
			"node_id":         "missing-node",
			"target_parent":   map[string]string{"type": "root", "key": "main"},
		})
	if code != http.StatusNotFound || errCode(t, body) != "NODE_NOT_FOUND" {
		t.Fatalf("unknown node = %d %v", code, body)
	}
}
