package httpapi

import (
	"net/http"
	"testing"
)

// createViaSync pushes one canonical node through /sync and asserts APPLIED.
func createViaSync(t *testing.T, st *flowState, opID string, clientSeq int64, nodeID, nodeType, title, url, parentType, parentKey, parentID string) {
	t.Helper()
	parent := map[string]string{"type": parentType}
	if parentKey != "" {
		parent["key"] = parentKey
	}
	if parentID != "" {
		parent["id"] = parentID
	}
	body := map[string]any{
		"protocol_version":  1,
		"epoch":             1,
		"applied_revision":  0,
		"received_revision": 0,
		"operations": []map[string]any{{
			"op_id":         opID,
			"client_seq":    clientSeq,
			"base_revision": 0,
			"type":          "create",
			"node_id":       nodeID,
			"node_type":     nodeType,
			"title":         title,
			"url":           url,
			"parent":        parent,
		}},
	}
	code, out := doJSON(t, "POST", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID,
		map[string]string{"Authorization": "Bearer " + st.deviceToken}, body)
	if code != http.StatusOK {
		t.Fatalf("sync create = %d %v", code, out)
	}
}

func TestSnapshotReturnsCanonicalTree(t *testing.T) {
	st := bootstrapFlow(t)
	deviceAuth := map[string]string{"Authorization": "Bearer " + st.deviceToken}

	folderID := "11111111-1111-7111-8111-111111111111"
	bookmarkID := "22222222-2222-7222-8222-222222222222"
	createViaSync(t, st, "op-1", 1, folderID, "folder", "Development", "", "root", "main", "")
	createViaSync(t, st, "op-2", 2, bookmarkID, "bookmark", "Go", "https://go.dev", "node", "", folderID)

	code, body := doJSON(t, "GET", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID+"/snapshot", deviceAuth, nil)
	if code != http.StatusOK {
		t.Fatalf("snapshot = %d %v", code, body)
	}
	if body["protocol_version"].(float64) != 1 {
		t.Errorf("protocol_version = %v", body["protocol_version"])
	}
	if body["snapshot_revision"].(float64) != 2 {
		t.Errorf("snapshot_revision = %v, want 2", body["snapshot_revision"])
	}
	nodes, _ := body["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("nodes = %v", nodes)
	}
	byID := map[string]map[string]any{}
	for _, raw := range nodes {
		n := raw.(map[string]any)
		byID[n["id"].(string)] = n
	}
	folder := byID[folderID]
	if folder == nil || folder["parent"].(map[string]any)["key"] != "main" {
		t.Errorf("folder node = %v", folder)
	}
	bookmark := byID[bookmarkID]
	if bookmark == nil {
		t.Fatalf("bookmark missing: %v", byID)
	}
	bp := bookmark["parent"].(map[string]any)
	if bp["type"] != "node" || bp["id"] != folderID {
		t.Errorf("bookmark parent = %v", bp)
	}
	if bookmark["url"] != "https://go.dev" {
		t.Errorf("bookmark url = %v", bookmark["url"])
	}
}

func TestSnapshotOwnershipAndUnknownBinding(t *testing.T) {
	st := bootstrapFlow(t)

	// Register a second device; its token must not read the first
	// device's binding snapshot (doc 22 D.6).
	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/devices",
		map[string]string{"Authorization": "Bearer " + st.sessionToken},
		map[string]string{"name": "Chrome@Work", "browser": "chrome"})
	if code != http.StatusCreated {
		t.Fatalf("register device 2 = %d %v", code, body)
	}
	otherToken, _ := body["token"].(string)

	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID+"/snapshot",
		map[string]string{"Authorization": "Bearer " + otherToken}, nil)
	if code != http.StatusForbidden || errCode(t, body) != "NOT_BINDING_OWNER" {
		t.Fatalf("foreign snapshot = %d %v", code, body)
	}

	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/sync/bindings/00000000-0000-7000-8000-000000000000/snapshot",
		map[string]string{"Authorization": "Bearer " + st.deviceToken}, nil)
	if code != http.StatusNotFound || errCode(t, body) != "BINDING_NOT_FOUND" {
		t.Fatalf("unknown binding snapshot = %d %v", code, body)
	}
}

func TestSnapshotRejectsBindingAfterRestore(t *testing.T) {
	st := bootstrapFlow(t)
	deviceAuth := map[string]string{"Authorization": "Bearer " + st.deviceToken}

	createViaSync(t, st, "op-1", 1,
		"11111111-1111-7111-8111-111111111111", "folder", "Development", "", "root", "main", "")

	// A backup restore resets every binding to pending_initial (doc 14
	// §12); the snapshot stays read-only for non-active bindings.
	h := map[string]string{"Authorization": "Bearer " + st.sessionToken}
	root := st.ts.URL + "/api/v1/spaces/" + st.spaceID
	code, body := doJSON(t, "POST", root+"/backups", h, nil)
	if code != http.StatusCreated {
		t.Fatalf("create backup = %d %v", code, body)
	}
	b1 := body["id"].(string)
	code, body = doJSON(t, "POST", root+"/backups/"+b1+"/restore", h, nil)
	if code != http.StatusOK {
		t.Fatalf("restore = %d %v", code, body)
	}

	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID+"/snapshot", deviceAuth, nil)
	if code != http.StatusConflict || errCode(t, body) != "BINDING_NOT_ACTIVE" {
		t.Fatalf("post-restore snapshot = %d %v", code, body)
	}
}

func TestSnapshotRequiresActiveBinding(t *testing.T) {
	st := bootstrapFlow(t)

	// A freshly registered device's binding starts pending_initial.
	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/devices",
		map[string]string{"Authorization": "Bearer " + st.sessionToken},
		map[string]string{"name": "Safari@Home", "browser": "safari"})
	if code != http.StatusCreated {
		t.Fatalf("register device 2 = %d %v", code, body)
	}
	pendingToken, _ := body["token"].(string)

	code, body = doJSON(t, "POST", st.ts.URL+"/api/v1/device/bindings",
		map[string]string{"Authorization": "Bearer " + pendingToken},
		map[string]string{"space_id": st.spaceID})
	if code != http.StatusCreated {
		t.Fatalf("bind space = %d %v", code, body)
	}
	pendingBinding, _ := body["id"].(string)

	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/sync/bindings/"+pendingBinding+"/snapshot",
		map[string]string{"Authorization": "Bearer " + pendingToken}, nil)
	if code != http.StatusConflict || errCode(t, body) != "BINDING_NOT_ACTIVE" {
		t.Fatalf("pending binding snapshot = %d %v", code, body)
	}
}
