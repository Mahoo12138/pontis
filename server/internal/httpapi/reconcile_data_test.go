package httpapi

// A node whose id is the empty string is data no device can address. It exists
// only in databases written before /sync started refusing a create that carries
// no node_id; this covers what the reconciliation engine does when it meets one.

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"pontis/internal/reconcile"
)

// planOverUnaddressableNode seeds one bookmark, drops a row with an empty id
// beside it, and asks the server to plan the binding's first reconciliation.
func planOverUnaddressableNode(t *testing.T, corrupt bool) (*Server, string, int, map[string]any) {
	t.Helper()
	srv, ts, db := newTestServerWithDB(t)

	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/setup", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusCreated {
		t.Fatalf("setup = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("login = %d %v", code, body)
	}
	sessionToken := fieldString(body, "token")
	sessionAuth := map[string]string{"Authorization": "Bearer " + sessionToken}
	space := mustCall(t, "POST", ts.URL+"/api/v1/spaces", sessionAuth, map[string]string{"name": "Personal"})
	spaceID := fieldString(space, "id")

	auth, binding := pairDevice(t, ts, sessionToken, spaceID, "Chrome@Data")
	base := ts.URL + "/api/v1/sync"

	if corrupt {
		// Inserted before the server snapshot is frozen, so the plan really
		// walks over the row.
		if _, err := db.ExecContext(context.Background(),
			`INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
			                    created_revision, title_revision, url_revision, structure_revision,
			                    created_at, updated_at)
			 VALUES (?, '', 'bookmark', 'Nameless', 'https://nameless.example', NULL, 'main', 9,
			         1, 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
			spaceID); err != nil {
			t.Fatalf("seed the unaddressable row: %v", err)
		}
	}

	created := mustCall(t, "POST", base+"/bindings/"+binding+"/reconciliations", auth,
		map[string]any{"type": "initial", "reason": "first synchronization"})
	sessionID := fieldString(sessionOf(t, created), "id")

	// The browser holds one real bookmark, so the plan has something to do.
	mustCall(t, "POST", base+"/bindings/"+binding+"/client-snapshots", auth,
		reconcile.ClientSnapshotJSON{
			Epoch: 1, Revision: 0,
			Roots: []reconcile.ClientRootJSON{{LocalRef: "l_1", RootKey: "main", Title: "Sync"}},
			Nodes: []reconcile.ClientNodeJSON{{
				LocalRef: "l_2", ParentLocalRef: "l_1", Type: "bookmark", Title: "Example", URL: "https://example.com",
			}},
		})
	mustCall(t, "POST", base+"/bindings/"+binding+"/server-snapshots", auth, nil)

	code, body = doJSON(t, "POST", base+"/reconciliations/"+sessionID+"/plan", auth, nil)
	return srv, sessionID, code, body
}

func TestReconciliationPlansOverUnaddressableNode(t *testing.T) {
	_, _, code, body := planOverUnaddressableNode(t, false)
	if code != http.StatusOK {
		t.Fatalf("plan without the corrupt row = %d %v, want 200", code, body)
	}

	_, _, code, body = planOverUnaddressableNode(t, true)
	if code != http.StatusOK {
		t.Fatalf("one unaddressable row broke the whole reconciliation: %d %v", code, body)
	}
	// The plan still merges everything it can, and says what it left out.
	plan, _ := body["plan"].(map[string]any)
	warnings, _ := plan["warnings"].([]any)
	found := false
	for _, raw := range warnings {
		if w, _ := raw.(string); strings.Contains(w, "carry no id") {
			found = true
		}
	}
	if !found {
		t.Errorf("plan warnings = %v, want one naming the skipped unaddressable node", warnings)
	}
}
