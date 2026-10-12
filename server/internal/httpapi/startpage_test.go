package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The start page is one read, gated by one question: does this device already
// sync the space the folder lives in? These tests hold that boundary and the
// shape of the answer.

func getRaw(t *testing.T, url string, headers map[string]string) (int, http.Header, string) {
	t.Helper()
	req, err := http.NewRequest("GET", url, nil)
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
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, resp.Header, string(body)
}

// startPageFlow is an account with a paired, bound and activated device, and
// a tree two levels deep:
//
//	Entries (folder, the usual source)
//	  Daily (folder) → MDN, Deep
//	  GitHub
//	Outside — a bookmark hanging off the root slot, above every source
type startPageFlow struct {
	st         *flowState
	session    map[string]string
	device     map[string]string
	spaceID    string
	entries    string
	daily      string
	github     string
	outside    string
	otherSpace string
}

func bootstrapStartPageFlow(t *testing.T) *startPageFlow {
	t.Helper()
	st := bootstrapFlow(t)
	f := &startPageFlow{
		st:      st,
		session: map[string]string{"Authorization": "Bearer " + st.sessionToken},
		device:  map[string]string{"Authorization": "Bearer " + st.deviceToken},
		spaceID: st.spaceID,
	}

	create := func(typ, title, url, parent string) string {
		t.Helper()
		body := map[string]any{"type": typ, "title": title, "url": url}
		if parent == "" {
			body["parent"] = map[string]string{"type": "root", "key": "main"}
		} else {
			body["parent"] = map[string]string{"type": "node", "id": parent}
		}
		code, out := doJSON(t, "POST", st.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes", f.session, body)
		if code != http.StatusCreated {
			t.Fatalf("create %s = %d %v", title, code, out)
		}
		return out["id"].(string)
	}
	f.entries = create("folder", "Entries", "", "")
	f.daily = create("folder", "Daily", "", f.entries)
	// Created in this order and expected back in it: the start page shows the
	// tree as the workbench ordered it (§6.2).
	create("bookmark", "MDN", "https://developer.mozilla.org", f.daily)
	create("bookmark", "Deep", "https://deep.example", f.daily)
	f.github = create("bookmark", "GitHub", "https://github.com/", f.entries)
	f.outside = create("bookmark", "Outside", "https://outside.example", "")

	// A second space the device never bound: the start page must not be a way
	// around that.
	code, out := doJSON(t, "POST", st.ts.URL+"/api/v1/spaces", f.session, map[string]string{"name": "Unbound"})
	if code != http.StatusCreated {
		t.Fatalf("create second space = %d %v", code, out)
	}
	f.otherSpace, _ = out["id"].(string)
	return f
}

func (f *startPageFlow) snapshotURL(spaceID, folderID string) string {
	return f.st.ts.URL + "/api/v1/device/start-page/snapshot?space_id=" + spaceID + "&folder_id=" + folderID
}

func (f *startPageFlow) snapshot(t *testing.T, folderID string) (int, http.Header, string) {
	t.Helper()
	return getRaw(t, f.snapshotURL(f.spaceID, folderID), f.device)
}

func snapshotBody(t *testing.T, body string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode snapshot: %v\n%s", err, body)
	}
	return out
}

func nodeSummaries(t *testing.T, body string) []map[string]any {
	t.Helper()
	raw, err := json.Marshal(snapshotBody(t, body)["nodes"])
	if err != nil {
		t.Fatal(err)
	}
	var nodes []map[string]any
	if err := json.Unmarshal(raw, &nodes); err != nil {
		t.Fatalf("nodes: %v", err)
	}
	return nodes
}

func nodeIDs(t *testing.T, body string) []string {
	t.Helper()
	nodes := nodeSummaries(t, body)
	ids := make([]string, 0, len(nodes))
	for _, n := range nodes {
		ids = append(ids, n["id"].(string))
	}
	return ids
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if id == want {
			return true
		}
	}
	return false
}

// A device that does not sync the space gets the same refusal whether the
// space is real or invented.
func TestStartPageNeedsABindingForTheSpace(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, body := doJSON(t, "GET", f.snapshotURL(f.otherSpace, f.entries), f.device, nil)
	if code != http.StatusNotFound || errCode(t, body) != "START_PAGE_PERMISSION_REQUIRED" {
		t.Fatalf("unbound space = %d %v", code, body)
	}
	if _, body := doJSON(t, "GET", f.snapshotURL("space-that-never-was", f.entries), f.device, nil); errCode(t, body) != "START_PAGE_PERMISSION_REQUIRED" {
		t.Fatalf("unknown space leaked a different answer: %v", body)
	}
}

func TestStartPageSourceIsScopedToTheFolder(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, header, body := f.snapshot(t, f.entries)
	if code != http.StatusOK {
		t.Fatalf("snapshot = %d %s", code, body)
	}
	ids := nodeIDs(t, body)
	for _, want := range []string{f.daily, f.github} {
		if !containsID(ids, want) {
			t.Errorf("nodes = %v, missing %v", ids, want)
		}
	}
	// Everything above the source stays where it is (§11.3): the breadcrumb
	// starts at the folder that was asked for, and the page cannot climb.
	if containsID(ids, f.outside) {
		t.Errorf("nodes = %v reached outside the source", ids)
	}
	if containsID(ids, f.entries) {
		t.Errorf("nodes = %v includes the source itself", ids)
	}

	snap := snapshotBody(t, body)
	if snap["instance_id"] != f.st.srv.InstanceID || snap["schema_version"] != float64(1) {
		t.Errorf("envelope = %v", snap)
	}
	meta, _ := snap["snapshot"].(map[string]any)
	if meta["complete"] != true {
		t.Errorf("snapshot = %v, want complete", meta)
	}
	// Epoch and revision stay integers, the encoding the sync protocol already
	// uses for watermarks: one number, one representation.
	if _, ok := meta["revision"].(float64); !ok {
		t.Errorf("revision = %#v, want a number", meta["revision"])
	}
	if got := header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store for a private tree", got)
	}
	if header.Get("ETag") == "" {
		t.Error("snapshot carried no ETag")
	}
}

// SP-03: a snapshot that nests has to say who every node belongs to, or the
// page cannot tell the second level from the first.
func TestStartPageKeepsParentageAndOrder(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	_, _, body := f.snapshot(t, f.entries)

	byID := map[string]map[string]any{}
	for _, n := range nodeSummaries(t, body) {
		byID[n["id"].(string)] = n
	}
	if got := byID[f.daily]["parent_id"]; got != f.entries {
		t.Errorf("Daily parent = %v, want the source", got)
	}
	if got := byID[f.github]["parent_id"]; got != f.entries {
		t.Errorf("GitHub parent = %v, want the source", got)
	}
	if byID[f.daily]["type"] != "folder" || byID[f.github]["type"] != "bookmark" {
		t.Errorf("types = %v / %v", byID[f.daily]["type"], byID[f.github]["type"])
	}
	// The folder entry can show how many direct children it has without
	// walking the tree, and a bookmark has none.
	if got := byID[f.daily]["child_count"]; got != float64(2) {
		t.Errorf("Daily child_count = %v, want 2", got)
	}
	if _, ok := byID[f.github]["child_count"]; ok {
		t.Errorf("GitHub carries a child_count: %v", byID[f.github])
	}

	var dailyKids []string
	for _, n := range nodeSummaries(t, body) {
		if n["parent_id"] == f.daily {
			dailyKids = append(dailyKids, n["title"].(string))
		}
	}
	if len(dailyKids) != 2 || dailyKids[0] != "MDN" || dailyKids[1] != "Deep" {
		t.Errorf("children of Daily = %v, want [MDN Deep]", dailyKids)
	}
}

// Drilling in is just another read of a deeper folder, still bounded.
func TestStartPageDrillDownStaysInsideTheSource(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	_, _, body := f.snapshot(t, f.daily)
	ids := nodeIDs(t, body)
	// Daily holds two bookmarks and nothing else. Entries is its parent and
	// GitHub its sibling: neither belongs in this answer (§11.3).
	if len(ids) != 2 {
		t.Fatalf("nodes under Daily = %v, want 2", ids)
	}
	if containsID(ids, f.entries) || containsID(ids, f.github) {
		t.Fatalf("reading Daily leaked the parent level: %v", ids)
	}
}

// SP-02: an empty folder is a folder the reader may choose. It renders as
// empty, not as a failure and not as a missing key.
func TestStartPageEmptySourceReturnsAnEmptyArray(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	code, out := doJSON(t, "POST", f.st.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes", f.session,
		map[string]any{"type": "folder", "title": "Nothing yet", "url": "",
			"parent": map[string]string{"type": "root", "key": "main"}})
	if code != http.StatusCreated {
		t.Fatalf("create folder = %d %v", code, out)
	}
	empty := out["id"].(string)

	code, _, body := f.snapshot(t, empty)
	if code != http.StatusOK {
		t.Fatalf("snapshot = %d %s", code, body)
	}
	// The absence of a key and an empty list are different answers to a client
	// that has to tell "empty folder" from "unreadable response".
	if !strings.Contains(body, `"nodes":[]`) {
		t.Fatalf("body = %s, want an empty array rather than null", body)
	}
}

func TestStartPageSourceMustBeAFolder(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, body := doJSON(t, "GET", f.snapshotURL(f.spaceID, f.github), f.device, nil)
	if code != http.StatusNotFound || errCode(t, body) != "START_PAGE_SOURCE_UNAVAILABLE" {
		t.Fatalf("bookmark source = %d %v", code, body)
	}
	if _, body := doJSON(t, "GET", f.snapshotURL(f.spaceID, "node-that-never-was"), f.device, nil); errCode(t, body) != "START_PAGE_SOURCE_UNAVAILABLE" {
		t.Fatalf("unknown folder = %v", body)
	}
}

// SP-04: a source is its node id. Renaming follows it; a same-named folder
// elsewhere does not become the source.
func TestStartPageSourceIdentity(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, out := doJSON(t, "PATCH", f.st.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+f.entries, f.session,
		map[string]any{"title": "Everyday entries"})
	if code != http.StatusOK {
		t.Fatalf("rename = %d %v", code, out)
	}
	_, _, body := f.snapshot(t, f.entries)
	src := snapshotBody(t, body)["source"].(map[string]any)
	if src["folder_title"] != "Everyday entries" {
		t.Fatalf("source = %v, the name did not follow the node", src)
	}

	code, _ = doJSON(t, "DELETE", f.st.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+f.entries, f.session, nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	// A folder with the old title now exists where the old one was. It is a
	// different node, so the old id is unavailable, not re-bound (§5.2).
	if _, out := doJSON(t, "POST", f.st.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes", f.session,
		map[string]any{"type": "folder", "title": "Everyday entries", "url": "",
			"parent": map[string]string{"type": "root", "key": "main"}}); out["error"] != nil {
		t.Fatalf("create the look-alike: %v", out)
	}
	code2, afterDelete := doJSON(t, "GET", f.snapshotURL(f.spaceID, f.entries), f.device, nil)
	if code2 != http.StatusNotFound || errCode(t, afterDelete) != "START_PAGE_SOURCE_UNAVAILABLE" {
		t.Fatalf("after deletion = %d %v, must not claim the same-named folder", code2, afterDelete)
	}
}

// SP-14: the conditional response is the one place the server could answer
// without reading anything, so it is where a revocation would be missed.
func TestStartPageConditionalRequestStillChecksTheBinding(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, header, _ := f.snapshot(t, f.entries)
	if code != http.StatusOK {
		t.Fatalf("snapshot = %d", code)
	}
	etag := header.Get("ETag")
	conditional := map[string]string{"Authorization": "Bearer " + f.st.deviceToken, "If-None-Match": etag}

	status, _, body := getRaw(t, f.snapshotURL(f.spaceID, f.entries), conditional)
	if status != http.StatusNotModified || body != "" {
		t.Fatalf("unchanged read = %d %q, want 304 with no body", status, body)
	}

	// Unbind the device: same tree, same tag, no longer any right to read it.
	code, out := doJSON(t, "GET", f.st.ts.URL+"/api/v1/device/bindings", f.device, nil)
	if code != http.StatusOK {
		t.Fatalf("list bindings = %d %v", code, out)
	}
	bindings, _ := out["bindings"].([]any)
	bindingID := bindings[0].(map[string]any)["id"].(string)
	if code, _ := doJSON(t, "DELETE", f.st.ts.URL+"/api/v1/device/bindings/"+bindingID, f.device, nil); code != http.StatusNoContent && code != http.StatusOK {
		t.Fatalf("unbind = %d", code)
	}

	status, _, body = getRaw(t, f.snapshotURL(f.spaceID, f.entries), conditional)
	if status == http.StatusNotModified {
		t.Fatal("an unbound device got 304: the client would keep showing private bookmarks off a cache hit")
	}
	if status != http.StatusNotFound || !strings.Contains(body, "START_PAGE_PERMISSION_REQUIRED") {
		t.Fatalf("after unbind = %d %s", status, body)
	}
}

// SP-09: a device credential cannot reach a folder in someone else's tree.
func TestStartPageCannotReadForeignIds(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	// A folder id from a space this device does not sync. The space check runs
	// first, so the answer is about the space and never about whether the
	// folder exists.
	code, body := doJSON(t, "GET", f.snapshotURL(f.otherSpace, f.outside), f.device, nil)
	if code != http.StatusNotFound || errCode(t, body) != "START_PAGE_PERMISSION_REQUIRED" {
		t.Fatalf("cross-space read = %d %v", code, body)
	}
}

// Reading the start page must leave no trace in sync state: no binding is
// created, and no watermark moves (§5.3, SP-08).
func TestStartPageReadChangesNoSyncState(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	before, out := doJSON(t, "GET", f.st.ts.URL+"/api/v1/device/bindings", f.device, nil)
	if before != http.StatusOK {
		t.Fatalf("bindings = %d %v", before, out)
	}

	if code, _, _ := f.snapshot(t, f.entries); code != http.StatusOK {
		t.Fatalf("snapshot = %d", code)
	}

	after, out2 := doJSON(t, "GET", f.st.ts.URL+"/api/v1/device/bindings", f.device, nil)
	if after != http.StatusOK {
		t.Fatalf("bindings = %d %v", after, out2)
	}
	a, _ := json.Marshal(out)
	b, _ := json.Marshal(out2)
	if string(a) != string(b) {
		t.Fatalf("reading the start page changed sync state:\n%s\n%s", a, b)
	}
}
