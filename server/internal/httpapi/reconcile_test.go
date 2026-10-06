package httpapi

import (
	"net/http"
	"testing"
)

// bootstrapPendingFlow wires the bootstrapped instance plus one extra
// device whose binding stays pending_initial, ready for an initial
// reconciliation.
func bootstrapPendingFlow(t *testing.T) (*flowState, map[string]string, string) {
	t.Helper()
	st := bootstrapFlow(t)

	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/devices",
		map[string]string{"Authorization": "Bearer " + st.sessionToken},
		map[string]string{"name": "Firefox@Laptop", "browser": "firefox", "platform": "linux"})
	if code != http.StatusCreated {
		t.Fatalf("register device = %d %v", code, body)
	}
	token, _ := body["token"].(string)

	code, body = doJSON(t, "POST", st.ts.URL+"/api/v1/device/bindings",
		map[string]string{"Authorization": "Bearer " + token},
		map[string]string{"space_id": st.spaceID})
	if code != http.StatusCreated {
		t.Fatalf("bind space = %d %v", code, body)
	}
	pendingBindingID, _ := body["id"].(string)
	return st, map[string]string{"Authorization": "Bearer " + token}, pendingBindingID
}

func TestReconciliationFlowOverHTTP(t *testing.T) {
	st, dev, bindingID := bootstrapPendingFlow(t)
	ts := st.ts.URL

	// Open the initial reconciliation.
	code, body := doJSON(t, "POST", ts+"/api/v1/sync/bindings/"+bindingID+"/reconciliations", dev,
		map[string]string{"type": "initial", "reason": "first pairing"})
	if code != http.StatusCreated {
		t.Fatalf("create reconciliation = %d %v", code, body)
	}
	sessionID, _ := body["id"].(string)
	if sessionID == "" || body["state"] != "running" {
		t.Fatalf("session = %v", body)
	}

	// Submit the browser snapshot (local refs only, doc 08 §10).
	clientSnapshot := map[string]any{
		"epoch": 0, "revision": 0,
		"roots": []any{map[string]any{"local_ref": "l_bar", "root_key": "main", "title": "Bar"}},
		"nodes": []any{
			map[string]any{"local_ref": "l_f1", "parent_local_ref": "l_bar", "type": "folder", "title": "Development"},
			map[string]any{"local_ref": "l_b1", "parent_local_ref": "l_f1", "type": "bookmark", "title": "GitHub", "url": "https://github.com"},
		},
	}
	code, body = doJSON(t, "POST", ts+"/api/v1/sync/bindings/"+bindingID+"/client-snapshots", dev, clientSnapshot)
	if code != http.StatusCreated {
		t.Fatalf("client snapshot = %d %v", code, body)
	}

	// Planning before the server snapshot fails with a stable code.
	code, body = doJSON(t, "POST", ts+"/api/v1/sync/reconciliations/"+sessionID+"/plan", dev, nil)
	if code != http.StatusConflict || errCode(t, body) != "SNAPSHOT_MISSING" {
		t.Fatalf("plan without snapshot = %d %v", code, body)
	}

	// Freeze the server snapshot and read it back paginated.
	code, body = doJSON(t, "POST", ts+"/api/v1/sync/bindings/"+bindingID+"/server-snapshots", dev, nil)
	if code != http.StatusCreated {
		t.Fatalf("server snapshot = %d %v", code, body)
	}
	snapshotID, _ := body["snapshot_id"].(string)
	if snapshotID == "" || body["revision"].(float64) != 0 {
		t.Fatalf("snapshot = %v", body)
	}
	code, body = doJSON(t, "GET", ts+"/api/v1/sync/server-snapshots/"+snapshotID+"/nodes?limit=500", dev, nil)
	if code != http.StatusOK {
		t.Fatalf("snapshot nodes = %d %v", code, body)
	}
	nodes, _ := body["nodes"].([]any)
	if len(nodes) != 1 { // the root slot row
		t.Fatalf("snapshot nodes = %v", body)
	}

	// Plan: an empty server turns the whole browser tree into creates.
	code, body = doJSON(t, "POST", ts+"/api/v1/sync/reconciliations/"+sessionID+"/plan", dev, nil)
	if code != http.StatusOK {
		t.Fatalf("plan = %d %v", code, body)
	}
	if body["state"] != "running" || body["phase"] != "planned" {
		t.Fatalf("planned session = %v", body)
	}

	// Commit imports the browser tree into the canonical space.
	code, body = doJSON(t, "POST", ts+"/api/v1/sync/reconciliations/"+sessionID+"/commit", dev, nil)
	if code != http.StatusOK || body["committed"] != true {
		t.Fatalf("commit = %d %v", code, body)
	}
	commitRevision := int64(body["commit_revision"].(float64))
	if commitRevision != 2 {
		t.Fatalf("commit revision = %d, want 2", commitRevision)
	}

	// Steps hand out the identities for the freshly imported nodes.
	code, body = doJSON(t, "GET", ts+"/api/v1/sync/reconciliations/"+sessionID+"/steps", dev, nil)
	if code != http.StatusOK {
		t.Fatalf("steps = %d %v", code, body)
	}
	steps, _ := body["steps"].([]any)
	identity := map[string]string{}
	for _, raw := range steps {
		step := raw.(map[string]any)
		if step["kind"] != "assign_identity" {
			t.Fatalf("unexpected step %v", step)
		}
		identity[step["local_ref"].(string)] = step["canonical_id"].(string)
	}
	if len(identity) != 2 {
		t.Fatalf("identity assignments = %v", identity)
	}

	// Complete resets the binding baseline and activates it.
	code, body = doJSON(t, "POST", ts+"/api/v1/sync/reconciliations/"+sessionID+"/complete", dev, nil)
	if code != http.StatusOK || body["state"] != "completed" {
		t.Fatalf("complete = %d %v", code, body)
	}

	// The next sync round starts from the new baseline: no backlog.
	code, body = doJSON(t, "POST", ts+"/api/v1/sync/bindings/"+bindingID, dev, map[string]any{
		"protocol_version": 1, "epoch": 1,
		"applied_revision": commitRevision, "received_revision": commitRevision,
	})
	if code != http.StatusOK {
		t.Fatalf("sync after complete = %d %v", code, body)
	}
	if body["server_revision"].(float64) != float64(commitRevision) {
		t.Fatalf("sync after complete = %v, want head %d", body, commitRevision)
	}
	changes, _ := body["changes"].([]any)
	if len(changes) != 0 {
		t.Fatalf("changes after baseline reset = %v", changes)
	}
}
