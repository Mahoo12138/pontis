package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Regression coverage for issue #6: what a publication copies, how it
// converges on re-apply, and what it must never expose.

func plazaAuth(token string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + token}
}

var plazaMain = map[string]string{"type": "root", "key": "main"}

func plazaNodeParent(id string) map[string]string {
	return map[string]string{"type": "node", "id": id}
}

func plazaCreateSpace(t *testing.T, f *libraryFlow, token, name string) string {
	t.Helper()
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", plazaAuth(token),
		map[string]string{"name": name})
	if code != http.StatusCreated {
		t.Fatalf("create space = %d %v", code, body)
	}
	return body["id"].(string)
}

func plazaCreateNode(t *testing.T, f *libraryFlow, token, space string, body map[string]any) string {
	t.Helper()
	code, resp := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces/"+space+"/nodes", plazaAuth(token), body)
	if code != http.StatusCreated {
		t.Fatalf("create node = %d %v", code, resp)
	}
	return resp["id"].(string)
}

func plazaNodes(t *testing.T, f *libraryFlow, token, space string) []map[string]any {
	t.Helper()
	code, resp := doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/"+space+"/nodes", plazaAuth(token), nil)
	if code != http.StatusOK {
		t.Fatalf("list nodes = %d %v", code, resp)
	}
	raw, err := json.Marshal(resp["nodes"])
	if err != nil {
		t.Fatalf("marshal nodes: %v", err)
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal nodes: %v", err)
	}
	return out
}

// A folder publication carries its root folder: applying it must reproduce the
// folder, not scatter its contents at the target.
func TestPlazaFolderPublicationCopiesItsRoot(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bob := plazaAuth(f.bobToken)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob tools")

	folder := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "folder", "title": "超好用工具", "parent": plazaMain,
	})
	bookmark := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "Stanza", "url": "https://www.stanza.co",
		"parent": plazaNodeParent(folder),
	})
	sub := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "folder", "title": "阅读", "parent": plazaNodeParent(folder),
	})
	plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "OEIS", "url": "https://oeis.org",
		"parent": plazaNodeParent(sub),
	})

	code, pub := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob, map[string]any{
		"space_id": bobSpace, "root_node_id": folder, "title": "超好用工具",
	})
	if code != http.StatusCreated {
		t.Fatalf("publish = %d %v", code, pub)
	}
	pubID := pub["id"].(string)
	if pub["folder_count"].(float64) != 2 || pub["bookmark_count"].(float64) != 2 {
		t.Fatalf("published counts = %v, want 2 folders / 2 bookmarks", pub)
	}

	apply := func() map[string]any {
		code, res := doJSON(t, "POST", f.ts.URL+"/api/v1/publications/"+pubID+"/apply",
			plazaAuth(f.sessionToken), map[string]any{
				"space_id": f.spaceID, "parent": plazaMain, "strategy": "merge",
			})
		if code != http.StatusOK {
			t.Fatalf("apply = %d %v", code, res)
		}
		return res
	}

	before := plazaNodes(t, f, f.sessionToken, f.spaceID)
	if got := apply()["created"].(float64); got != 4 {
		t.Fatalf("first apply created = %v, want 4", got)
	}
	nodes := plazaNodes(t, f, f.sessionToken, f.spaceID)
	if len(nodes) != len(before)+4 {
		t.Fatalf("node count after apply = %d, want %d", len(nodes), len(before)+4)
	}

	var imported map[string]any
	for _, n := range nodes {
		if n["title"] == "超好用工具" {
			imported = n
		}
	}
	if imported == nil {
		t.Fatalf("imported tree lost its root folder: %v", nodes)
	}
	if imported["type"] != "folder" || imported["root_key"] != "main" {
		t.Fatalf("published root is not a folder at main: %v", imported)
	}
	children := 0
	for _, n := range nodes {
		if n["parent_id"] == imported["id"] {
			children++
		}
	}
	if children != 2 {
		t.Fatalf("imported folder has %d children, want 2", children)
	}

	// Re-applying must converge: the nested bookmark and folder already exist
	// at their locations, so nothing new is created.
	second := apply()
	if got := second["created"].(float64); got != 0 {
		t.Fatalf("re-apply created = %v (%v), want 0", got, second)
	}
	if got := len(plazaNodes(t, f, f.sessionToken, f.spaceID)); got != len(nodes) {
		t.Fatalf("re-apply changed node count %d -> %d", len(nodes), got)
	}

	// Neither the publish response nor the detail may carry the source's
	// canonical ids — the publish response is a separate code path, so both
	// are checked.
	code, detail := doJSON(t, "GET", f.ts.URL+"/api/v1/publications/"+pubID,
		plazaAuth(f.sessionToken), nil)
	if code != http.StatusOK {
		t.Fatalf("detail = %d %v", code, detail)
	}
	sourceIDs := []string{folder, bookmark, sub}
	for name, body := range map[string]any{"publish response": pub, "detail response": detail} {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		for _, id := range sourceIDs {
			if strings.Contains(string(raw), id) {
				t.Fatalf("%s leaked canonical node id %s", name, id)
			}
		}
	}
}

// A single bookmark is a one-node publication: applying it yields that node.
func TestPlazaSingleBookmarkPublication(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob single")
	bookmark := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "SoAli.net", "url": "https://soali.net", "parent": plazaMain,
	})

	code, pub := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", plazaAuth(f.bobToken),
		map[string]any{"space_id": bobSpace, "root_node_id": bookmark, "title": "SoAli.net"})
	if code != http.StatusCreated {
		t.Fatalf("publish = %d %v", code, pub)
	}

	before := len(plazaNodes(t, f, f.sessionToken, f.spaceID))
	code, res := doJSON(t, "POST", f.ts.URL+"/api/v1/publications/"+pub["id"].(string)+"/apply",
		plazaAuth(f.sessionToken), map[string]any{
			"space_id": f.spaceID, "parent": plazaMain, "strategy": "merge",
		})
	if code != http.StatusOK {
		t.Fatalf("apply = %d %v", code, res)
	}
	if res["created"].(float64) != 1 {
		t.Fatalf("single bookmark apply = %v, want created=1", res)
	}
	nodes := plazaNodes(t, f, f.sessionToken, f.spaceID)
	if len(nodes) != before+1 {
		t.Fatalf("node count = %d, want %d", len(nodes), before+1)
	}
}

// Re-capturing a publication whose source is gone has to fail loudly rather
// than store an empty tree.
func TestPlazaSnapshotUpdateRefusesDeletedSource(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bob := plazaAuth(f.bobToken)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob doomed")
	folder := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "folder", "title": "会消失", "parent": plazaMain,
	})
	plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "RMBG", "url": "https://rmbg.dev",
		"parent": plazaNodeParent(folder),
	})

	code, pub := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "root_node_id": folder, "title": "会消失"})
	if code != http.StatusCreated {
		t.Fatalf("publish = %d %v", code, pub)
	}
	pubID := pub["id"].(string)

	if c := doEmpty(t, "DELETE", f.ts.URL+"/api/v1/spaces/"+bobSpace+"/nodes/"+folder, bob); c >= 300 {
		t.Fatalf("delete source folder = %d", c)
	}
	code, body := doJSON(t, "PATCH", f.ts.URL+"/api/v1/publications/"+pubID, bob,
		map[string]any{"snapshot": true})
	if code != http.StatusNotFound {
		t.Fatalf("snapshot after source delete = %d %v, want 404", code, body)
	}

	code, detail := doJSON(t, "GET", f.ts.URL+"/api/v1/publications/"+pubID, bob, nil)
	if code != http.StatusOK {
		t.Fatalf("detail = %d %v", code, detail)
	}
	if detail["version"].(float64) != 1 {
		t.Fatalf("failed update bumped version to %v", detail["version"])
	}
	if detail["bookmark_count"].(float64) != 1 {
		t.Fatalf("snapshot row was rewritten: %v", detail)
	}
}

// An apply that names a root slot the space does not have is a bad request,
// not a server fault: the web import picker can send it while its target
// select is still settling.
func TestPlazaApplyRejectsUnknownTargetRoot(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bob := plazaAuth(f.bobToken)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob target")
	plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "UU", "url": "https://uutool.cn", "parent": plazaMain,
	})

	code, pub := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "title": "小工具"})
	if code != http.StatusCreated {
		t.Fatalf("publish = %d %v", code, pub)
	}
	code, body := doJSON(t, "POST",
		f.ts.URL+"/api/v1/publications/"+pub["id"].(string)+"/apply", plazaAuth(f.sessionToken),
		map[string]any{"space_id": f.spaceID, "parent": map[string]string{"type": "root"}, "strategy": "merge"})
	if code != http.StatusBadRequest {
		t.Fatalf("apply with empty root key = %d %v, want 400", code, body)
	}
	if err, _ := body["error"].(map[string]any); err["code"] != "TARGET_NOT_FOUND" {
		t.Fatalf("apply error = %v, want TARGET_NOT_FOUND", body)
	}
}

// Private publications are reachable only by their owner, and the plaza search
// query filters them like any other row.
func TestPlazaPrivatePublicationHonoursSearch(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bob := plazaAuth(f.bobToken)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob private")
	plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "CodeKey", "url": "https://ckey.run", "parent": plazaMain,
	})

	code, pub := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "title": "私有合集", "visibility": "private"})
	if code != http.StatusCreated {
		t.Fatalf("publish private = %d %v", code, pub)
	}
	pubID := pub["id"].(string)

	list := func(token, query string) []any {
		t.Helper()
		url := f.ts.URL + "/api/v1/plaza/publications"
		if query != "" {
			url += "?q=" + query
		}
		code, body := doJSON(t, "GET", url, plazaAuth(token), nil)
		if code != http.StatusOK {
			t.Fatalf("list = %d %v", code, body)
		}
		pubs, _ := body["publications"].([]any)
		return pubs
	}
	contains := func(pubs []any) bool {
		for _, p := range pubs {
			if p.(map[string]any)["id"] == pubID {
				return true
			}
		}
		return false
	}

	if contains(list(f.sessionToken, "")) {
		t.Fatal("private publication reached another user's plaza index")
	}
	if !contains(list(f.bobToken, "私有")) {
		t.Fatal("owner's search missed their own private publication")
	}
	if contains(list(f.bobToken, "nomatch-xyz")) {
		t.Fatal("private publication ignored the search query")
	}

	// Flipping it public through the same PATCH endpoint makes it discoverable.
	code, body := doJSON(t, "PATCH", f.ts.URL+"/api/v1/publications/"+pubID, bob,
		map[string]any{"visibility": "plaza"})
	if code != http.StatusOK || body["visibility"] != "plaza" {
		t.Fatalf("publish toggle = %d %v", code, body)
	}
	if !contains(list(f.sessionToken, "私有")) {
		t.Fatal("publication stayed out of the plaza index after going public")
	}

	code, body = doJSON(t, "PATCH", f.ts.URL+"/api/v1/publications/"+pubID, bob,
		map[string]any{"visibility": "anyone-with-link"})
	if code != http.StatusBadRequest {
		t.Fatalf("invalid visibility = %d %v, want 400", code, body)
	}
}
