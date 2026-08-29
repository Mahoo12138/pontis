package httpapi

import (
	"net/http"
	"testing"
)

func TestPlazaPublishAndApply(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	alice := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bob := map[string]string{"Authorization": "Bearer " + f.bobToken}

	// Bob owns a space with content to publish.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", bob,
		map[string]string{"name": "Bob's Collection"})
	if code != http.StatusCreated {
		t.Fatalf("bob space = %d %v", code, body)
	}
	bobSpace := body["id"].(string)
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/spaces/"+bobSpace+"/nodes", bob, map[string]any{
		"type": "bookmark", "title": "Bob's Go Book", "url": "https://go.dev",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	if code != http.StatusCreated {
		t.Fatalf("bob node = %d %v", code, body)
	}

	// Publish.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "title": "Go 资源合集", "description": "精选", "tags": []string{"Go"}})
	if code != http.StatusCreated {
		t.Fatalf("publish = %d %v", code, body)
	}
	pubID := body["id"].(string)
	if body["bookmark_count"].(float64) != 1 {
		t.Fatalf("published counts wrong: %v", body)
	}

	// Alice sees it in the plaza index.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/plaza/publications?q=go", alice, nil)
	if code != http.StatusOK {
		t.Fatalf("plaza list = %d %v", code, body)
	}
	pubs := body["publications"].([]any)
	found := false
	for _, p := range pubs {
		if p.(map[string]any)["id"] == pubID {
			found = true
		}
	}
	if !found {
		t.Fatalf("publication missing from plaza: %v", pubs)
	}

	// Detail is readable by alice (plaza visibility).
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/publications/"+pubID, alice, nil)
	if code != http.StatusOK {
		t.Fatalf("detail = %d %v", code, body)
	}

	// Alice applies it into her space (merge).
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/publications/"+pubID+"/apply", alice,
		map[string]any{"space_id": f.spaceID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "merge"})
	if code != http.StatusOK {
		t.Fatalf("apply = %d %v", code, body)
	}
	if body["created"].(float64) != 1 || body["kept"].(float64) != 0 {
		t.Fatalf("apply counters = %v, want created=1 kept=0", body)
	}

	// Applying again merges: the same raw URL is kept, nothing created.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/publications/"+pubID+"/apply", alice,
		map[string]any{"space_id": f.spaceID, "parent": map[string]string{"type": "root", "key": "main"}, "strategy": "merge"})
	if code != http.StatusOK || body["kept"].(float64) != 1 || body["created"].(float64) != 0 {
		t.Fatalf("second apply = %d %v", code, body)
	}

	// Node counts in alice's space reflect exactly one import.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes", alice, nil)
	if code != http.StatusOK {
		t.Fatalf("nodes = %d %v", code, body)
	}
	if got := len(body["nodes"].([]any)); got != 1 {
		t.Fatalf("alice node count = %d, want 1", got)
	}

	// Bob updates metadata; alice cannot.
	code, _ = doJSON(t, "PATCH", f.ts.URL+"/api/v1/publications/"+pubID, alice,
		map[string]any{"title": "hijack"})
	if code != http.StatusForbidden {
		t.Fatalf("alice patch = %d", code)
	}
	code, body = doJSON(t, "PATCH", f.ts.URL+"/api/v1/publications/"+pubID, bob,
		map[string]any{"visibility": "private"})
	if code != http.StatusOK || body["visibility"] != "private" {
		t.Fatalf("bob visibility = %d %v", code, body)
	}

	// Private publications leave the plaza index but stay in 我的发布.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/plaza/publications", alice, nil)
	if code != http.StatusOK {
		t.Fatalf("plaza list 2 = %d", code)
	}
	for _, p := range body["publications"].([]any) {
		if p.(map[string]any)["id"] == pubID {
			t.Fatalf("private publication still in plaza index")
		}
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/plaza/publications", bob, nil)
	found = false
	for _, p := range body["publications"].([]any) {
		if p.(map[string]any)["id"] == pubID {
			found = true
		}
	}
	if !found {
		t.Fatalf("owner lost sight of private publication")
	}

	// Unpublish removes it entirely.
	code = doEmpty(t, "DELETE", f.ts.URL+"/api/v1/publications/"+pubID, bob)
	if code != http.StatusNoContent {
		t.Fatalf("unpublish = %d", code)
	}
	code, _ = doJSON(t, "GET", f.ts.URL+"/api/v1/publications/"+pubID, bob, nil)
	if code != http.StatusNotFound {
		t.Fatalf("gone publication = %d", code)
	}
}
