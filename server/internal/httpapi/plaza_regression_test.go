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

// A snapshot update leaves a trail, and a preview answers with the counts an
// apply would report without keeping any of them.
func TestPlazaVersionHistoryAndPreview(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bob := plazaAuth(f.bobToken)
	alice := plazaAuth(f.sessionToken)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob versions")

	folder := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "folder", "title": "版本集", "parent": plazaMain,
	})
	first := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "一", "url": "https://one.example",
		"parent": plazaNodeParent(folder),
	})

	code, pub := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "root_node_id": folder, "title": "版本集"})
	if code != http.StatusCreated {
		t.Fatalf("publish = %d %v", code, pub)
	}
	pubID := pub["id"].(string)
	applyBody := map[string]any{"space_id": f.spaceID, "parent": plazaMain, "strategy": "merge"}

	countBefore := len(plazaNodes(t, f, f.sessionToken, f.spaceID))
	code, prev := doJSON(t, "POST", f.ts.URL+"/api/v1/publications/"+pubID+"/apply/preview",
		alice, applyBody)
	if code != http.StatusOK {
		t.Fatalf("preview = %d %v", code, prev)
	}
	if prev["created"].(float64) != 2 || prev["updated"].(float64) != 0 || prev["kept"].(float64) != 0 {
		t.Fatalf("preview counts = %v, want created=2", prev)
	}
	if got := len(plazaNodes(t, f, f.sessionToken, f.spaceID)); got != countBefore {
		t.Fatalf("preview wrote %d nodes, want the tree untouched", got-countBefore)
	}

	if c, _ := doJSON(t, "POST", f.ts.URL+"/api/v1/publications/"+pubID+"/apply", alice, applyBody); c != http.StatusOK {
		t.Fatalf("apply = %d", c)
	}

	if c, body := doJSON(t, "PATCH", f.ts.URL+"/api/v1/spaces/"+bobSpace+"/nodes/"+first, bob,
		map[string]any{"title": "一改"}); c != http.StatusOK {
		t.Fatalf("rename = %d %v", c, body)
	}
	plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "二", "url": "https://two.example",
		"parent": plazaNodeParent(folder),
	})
	if c, body := doJSON(t, "PATCH", f.ts.URL+"/api/v1/publications/"+pubID, bob,
		map[string]any{"snapshot": true}); c != http.StatusOK || body["version"].(float64) != 2 {
		t.Fatalf("snapshot = %d %v", c, body)
	}

	code, list := doJSON(t, "GET", f.ts.URL+"/api/v1/publications/"+pubID+"/versions", alice, nil)
	if code != http.StatusOK {
		t.Fatalf("versions = %d %v", code, list)
	}
	raw, err := json.Marshal(list["versions"])
	if err != nil {
		t.Fatalf("marshal versions: %v", err)
	}
	var versions []map[string]any
	if err := json.Unmarshal(raw, &versions); err != nil {
		t.Fatalf("unmarshal versions: %v", err)
	}
	if len(versions) != 2 {
		t.Fatalf("version history = %v, want two entries", versions)
	}
	if versions[0]["version"].(float64) != 2 || versions[1]["version"].(float64) != 1 {
		t.Fatalf("versions not newest first: %v", versions)
	}
	if versions[1]["note"] != "初始发布" {
		t.Fatalf("first version note = %v", versions[1]["note"])
	}

	// The update preview sees the rename and the new entry, and still writes
	// nothing.
	countMid := len(plazaNodes(t, f, f.sessionToken, f.spaceID))
	code, prev = doJSON(t, "POST", f.ts.URL+"/api/v1/publications/"+pubID+"/apply/preview",
		alice, applyBody)
	if code != http.StatusOK {
		t.Fatalf("update preview = %d %v", code, prev)
	}
	if prev["created"].(float64) != 1 || prev["updated"].(float64) != 1 || prev["kept"].(float64) != 1 {
		t.Fatalf("update preview counts = %v, want created=1 updated=1 kept=1", prev)
	}
	if got := len(plazaNodes(t, f, f.sessionToken, f.spaceID)); got != countMid {
		t.Fatalf("update preview changed the tree: %d -> %d", countMid, got)
	}
}

// A consumer who applied a publication updates the same nodes when the
// publisher releases a new version — not a second copy beside them.
func TestPlazaReApplyUpdatesMappedNodes(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bob := plazaAuth(f.bobToken)
	alice := plazaAuth(f.sessionToken)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob evolving")

	folder := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "folder", "title": "合集", "parent": plazaMain,
	})
	source := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "旧标题", "url": "https://old.example",
		"parent": plazaNodeParent(folder),
	})

	code, pub := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "root_node_id": folder, "title": "合集"})
	if code != http.StatusCreated {
		t.Fatalf("publish = %d %v", code, pub)
	}
	pubID := pub["id"].(string)
	applyURL := f.ts.URL + "/api/v1/publications/" + pubID + "/apply"
	applyBody := map[string]any{"space_id": f.spaceID, "parent": plazaMain, "strategy": "merge"}

	if c, res := doJSON(t, "POST", applyURL, alice, applyBody); c != http.StatusOK ||
		res["created"].(float64) != 2 {
		t.Fatalf("first apply = %d %v", c, res)
	}

	importedID := ""
	for _, n := range plazaNodes(t, f, f.sessionToken, f.spaceID) {
		if n["title"] == "旧标题" {
			importedID = n["id"].(string)
		}
	}
	if importedID == "" {
		t.Fatal("first apply did not copy the bookmark")
	}

	// The publisher renames the source and re-captures.
	if c, _ := doJSON(t, "PATCH", f.ts.URL+"/api/v1/spaces/"+bobSpace+"/nodes/"+source, bob,
		map[string]any{"title": "新标题"}); c != http.StatusOK {
		t.Fatalf("rename source = %d", c)
	}
	if c, body := doJSON(t, "PATCH", f.ts.URL+"/api/v1/publications/"+pubID, bob,
		map[string]any{"snapshot": true}); c != http.StatusOK || body["version"].(float64) != 2 {
		t.Fatalf("snapshot update = %d %v", c, body)
	}

	// The consumer is told there is something to update.
	code, detail := doJSON(t, "GET", f.ts.URL+"/api/v1/publications/"+pubID, alice, nil)
	if code != http.StatusOK {
		t.Fatalf("detail = %d %v", code, detail)
	}
	imp, _ := detail["import"].(map[string]any)
	if imp == nil || imp["has_update"] != true || imp["last_version"].(float64) != 1 {
		t.Fatalf("detail import state = %v, want has_update with last_version 1", detail["import"])
	}

	code, res := doJSON(t, "POST", applyURL, alice, applyBody)
	if code != http.StatusOK {
		t.Fatalf("second apply = %d %v", code, res)
	}
	if res["created"].(float64) != 0 || res["updated"].(float64) != 1 {
		t.Fatalf("update apply = %v, want created=0 updated=1", res)
	}

	// Identity survived: the same node carries the new title, and no second
	// copy appeared beside it.
	var renamed map[string]any
	count := 0
	for _, n := range plazaNodes(t, f, f.sessionToken, f.spaceID) {
		if n["id"] == importedID {
			renamed = n
		}
		if n["title"] == "新标题" {
			count++
		}
	}
	if renamed == nil || renamed["title"] != "新标题" {
		t.Fatalf("mapped node %s was not updated in place: %v", importedID, renamed)
	}
	if count != 1 {
		t.Fatalf("updated node appears %d times, want 1", count)
	}

	code, detail = doJSON(t, "GET", f.ts.URL+"/api/v1/publications/"+pubID, alice, nil)
	if code != http.StatusOK {
		t.Fatalf("detail after update = %d %v", code, detail)
	}
	imp, _ = detail["import"].(map[string]any)
	if imp == nil || imp["has_update"] != false || imp["last_version"].(float64) != 2 {
		t.Fatalf("detail import state = %v, want version 2 with no update pending", detail["import"])
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

// The plaza query searches inside published trees, filters by facet, pages,
// and keeps the caller's own private publications on the same rules.
func TestPlazaSearchFacetsPagingAndMine(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	bob := plazaAuth(f.bobToken)
	alice := plazaAuth(f.sessionToken)
	bobSpace := plazaCreateSpace(t, f, f.bobToken, "Bob search")

	front := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "folder", "title": "前端", "parent": plazaMain,
	})
	plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "Svelte 教程", "url": "https://svelte.dev",
		"parent": plazaNodeParent(front),
	})
	back := plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "folder", "title": "后端", "parent": plazaMain,
	})
	plazaCreateNode(t, f, f.bobToken, bobSpace, map[string]any{
		"type": "bookmark", "title": "Postgres", "url": "https://www.postgresql.org",
		"parent": plazaNodeParent(back),
	})

	code, pubA := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "root_node_id": front, "title": "前端收藏", "tags": []string{"前端"}})
	if code != http.StatusCreated {
		t.Fatalf("publish A = %d %v", code, pubA)
	}
	code, pubB := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "root_node_id": back, "title": "后端收藏", "tags": []string{"后端"}})
	if code != http.StatusCreated {
		t.Fatalf("publish B = %d %v", code, pubB)
	}
	code, pubC := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", alice,
		map[string]any{"space_id": f.spaceID, "title": "Alice 的合集", "tags": []string{"前端"}})
	if code != http.StatusCreated {
		t.Fatalf("publish C = %d %v", code, pubC)
	}
	// Bob's private one must obey the same filters as everything else.
	code, pubD := doJSON(t, "POST", f.ts.URL+"/api/v1/publications", bob,
		map[string]any{"space_id": bobSpace, "title": "后端草稿", "visibility": "private"})
	if code != http.StatusCreated {
		t.Fatalf("publish D = %d %v", code, pubD)
	}

	list := func(query string, h map[string]string) ([]map[string]any, float64) {
		t.Helper()
		code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/plaza/publications"+query, h, nil)
		if code != http.StatusOK {
			t.Fatalf("list %s = %d %v", query, code, body)
		}
		raw, err := json.Marshal(body["publications"])
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		var rows []map[string]any
		if err := json.Unmarshal(raw, &rows); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		total, _ := body["total"].(float64)
		return rows, total
	}
	titles := func(rows []map[string]any) []string {
		out := make([]string, 0, len(rows))
		for _, r := range rows {
			out = append(out, r["title"].(string))
		}
		return out
	}

	// A term that appears nowhere in the metadata, only as a bookmark inside a
	// published tree, still finds the publication — and says where it hit.
	rows, _ := list("?q=postgresql", alice)
	if len(rows) != 1 || rows[0]["title"] != "后端收藏" {
		t.Fatalf("content search = %v, want 后端收藏", titles(rows))
	}
	matches, _ := json.Marshal(rows[0]["matches"])
	if !strings.Contains(string(matches), "Postgres") {
		t.Fatalf("content search did not report the hit path: %v", rows[0]["matches"])
	}

	rows, _ = list("?tag=%E5%89%8D%E7%AB%AF", alice)
	if len(rows) != 2 {
		t.Fatalf("tag filter = %v, want the two 前端 collections", titles(rows))
	}
	for _, r := range rows {
		if !containsString(r["tags"], "前端") {
			t.Fatalf("tag filter returned a publication without it: %v", r["tags"])
		}
	}

	rows, _ = list("?publisher=bob&q=%E6%94%B6%E8%97%8F", alice)
	if len(rows) != 2 {
		t.Fatalf("publisher filter = %v, want bob's two collections", titles(rows))
	}

	rows, total := list("?q=%E6%94%B6%E8%97%8F&limit=1", alice)
	if len(rows) != 1 {
		t.Fatalf("paged result = %v, want one row", titles(rows))
	}
	if total != 2 {
		t.Fatalf("total = %v, want the unpaged count of 2", total)
	}

	rows, _ = list("?mine=1", alice)
	for _, r := range rows {
		if r["is_mine"] != true {
			t.Fatalf("mine filter returned someone else's publication: %v", r["title"])
		}
	}
	if len(rows) != 1 || rows[0]["title"] != "Alice 的合集" {
		t.Fatalf("mine filter = %v, want only Alice 的合集", titles(rows))
	}

	// Bob sees his own private publication through the same query path, and
	// only when the term actually matches it.
	if _, total = list("?q=%E8%8D%89%E7%A8%BF", bob); total != 1 {
		t.Fatalf("owner search for their private publication = %v, want 1", total)
	}
	if _, total = list("?q=%E8%8D%89%E7%A8%BF", alice); total != 0 {
		t.Fatalf("a private publication reached another user: %v", total)
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

func containsString(raw any, want string) bool {
	list, _ := raw.([]any)
	for _, item := range list {
		if s, _ := item.(string); s == want {
			return true
		}
	}
	return false
}
