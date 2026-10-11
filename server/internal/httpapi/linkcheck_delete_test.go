package httpapi

import (
	"fmt"
	"net/http"
	"testing"

	"pontis/internal/jobs"
)

// The link check's findings are stored, so by the time a user acts on them the
// tree may have moved (doc 12 §2): a bookmark that was repaired since the scan
// is not the bookmark the page is pointing at. These tests drive the real
// delete path and assert the re-check decides each node individually.

func deleteBroken(t *testing.T, f *libraryFlow, h map[string]string, jobID string, nodeIDs []string) (int, map[string]any) {
	t.Helper()
	return doJSON(t, "POST",
		f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/organizer/link-check/delete", h,
		map[string]any{"job_id": jobID, "node_ids": nodeIDs})
}

// deletedOf reads the response's deleted ids. A missing key or a null is a
// failure here: the page iterates both arrays.
func deletedOf(t *testing.T, body map[string]any) []string {
	t.Helper()
	items, ok := body["deleted"].([]any)
	if !ok {
		t.Fatalf("deleted is %#v, want an array", body["deleted"])
	}
	var out []string
	for _, it := range items {
		out = append(out, it.(string))
	}
	return out
}

// reasonsOf maps each refused node to its reason and detail.
func reasonsOf(t *testing.T, body map[string]any) map[string][2]string {
	t.Helper()
	items, ok := body["skipped"].([]any)
	if !ok {
		t.Fatalf("skipped is %#v, want an array", body["skipped"])
	}
	out := map[string][2]string{}
	for _, it := range items {
		m := it.(map[string]any)
		detail, _ := m["detail"].(string)
		out[m["node_id"].(string)] = [2]string{m["reason"].(string), detail}
	}
	return out
}

func spaceNodeMap(t *testing.T, f *libraryFlow, h map[string]string, spaceID string) map[string]map[string]any {
	t.Helper()
	code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/"+spaceID+"/nodes", h, nil)
	if code != http.StatusOK {
		t.Fatalf("nodes of %s = %d %v", spaceID, code, body)
	}
	out := map[string]map[string]any{}
	for _, n := range body["nodes"].([]any) {
		m := n.(map[string]any)
		out[m["id"].(string)] = m
	}
	return out
}

func TestLinkCheckDeleteReChecksEachFindingBeforeDeleting(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	const repaired, vanished, broken = "https://a.example/404", "https://b.example/404", "https://c.example/404"
	seedBookmarks(t, f, h, repaired, vanished, broken)
	useChecker(t, f, classifyChecker())

	jobID, total := enqueueLinkCheck(t, f, h)
	if total != 3 {
		t.Fatalf("total = %d, want the three bookmarks the run snapshotted", total)
	}
	startQueue(t, f.srv)
	body := waitForDone(t, f, h, 3)
	waitForJobStatus(t, f.srv, jobID, jobs.StatusSucceeded)

	byURL := map[string]string{}
	for _, rr := range body["results"].([]any) {
		m := rr.(map[string]any)
		byURL[m["checked_url"].(string)] = m["node_id"].(string)
	}
	nodePath := func(id string) string {
		return f.ts.URL + "/api/v1/spaces/" + f.spaceID + "/nodes/" + id
	}

	// 1. The user fixed this bookmark after the scan: same node id, and as far
	// as the finding is concerned a different bookmark.
	if code, resp := doJSON(t, "PATCH", nodePath(byURL[repaired]), h,
		map[string]any{"url": "https://a.example/repaired"}); code != http.StatusOK {
		t.Fatalf("repair = %d %v", code, resp)
	}
	// 2. This one is already gone — another tab, or a sync, took it.
	if code := doEmpty(t, "DELETE", nodePath(byURL[vanished]), h); code != http.StatusNoContent {
		t.Fatalf("pre-delete = %d, want 204", code)
	}
	// 3. A node of someone else's space: it exists, it is just not this run's.
	code, bobSpace := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", bearer(f.bobToken),
		map[string]string{"name": "Bobs"})
	if code != http.StatusCreated {
		t.Fatalf("bob space = %d %v", code, bobSpace)
	}
	bobSpaceID := bobSpace["id"].(string)
	code, foreign := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces/"+bobSpaceID+"/nodes",
		bearer(f.bobToken),
		map[string]any{"type": "bookmark", "title": "not yours", "url": "https://x.example/404",
			"parent": map[string]string{"type": "root", "key": "main"}})
	if code != http.StatusCreated {
		t.Fatalf("bob node = %d %v", code, foreign)
	}
	foreignID := foreign["id"].(string)

	code, body = deleteBroken(t, f, h, jobID,
		[]string{byURL[repaired], byURL[vanished], byURL[broken], foreignID})
	if code != http.StatusOK {
		t.Fatalf("delete = %d %v", code, body)
	}

	if got := deletedOf(t, body); !equalStrings(got, []string{byURL[broken]}) {
		t.Errorf("deleted = %v, want only the bookmark still holding its scanned url", got)
	}
	reasons := reasonsOf(t, body)
	if r := reasons[byURL[repaired]]; r[0] != "url_changed" {
		t.Errorf("repaired node refused as %v, want url_changed", r)
	} else if r[1] != "https://a.example/repaired" {
		t.Errorf("url_changed detail = %q, want the url it holds now", r[1])
	}
	if r := reasons[byURL[vanished]]; r[0] != "node_gone" {
		t.Errorf("pre-deleted node refused as %v, want node_gone", r)
	}
	if r := reasons[foreignID]; r[0] != "not_in_run" {
		t.Errorf("another space's node refused as %v, want not_in_run", r)
	}

	left := spaceNodeMap(t, f, h, f.spaceID)
	if _, ok := left[byURL[broken]]; ok {
		t.Error("the matched bookmark survived a delete that reported it gone")
	}
	if n, ok := left[byURL[repaired]]; !ok || n["url"] != "https://a.example/repaired" {
		t.Errorf("the repaired bookmark was touched: %v", n)
	}
	// Bob still has his own node: a batch aimed at alice's space cannot reach it.
	if bobNodes := spaceNodeMap(t, f, bearer(f.bobToken), bobSpaceID); len(bobNodes) != 1 {
		t.Errorf("bob's space now holds %d nodes, want his bookmark untouched", len(bobNodes))
	}

	// The list the page reads is re-checked too: a finding whose bookmark is
	// gone, or no longer holds the scanned url, is not something it can offer
	// to delete. The run's own progress counters stay as they were.
	after := linkCheckResults(t, f, h)
	if got := int(after["done"].(float64)); got != 3 {
		t.Errorf("done = %d, want the run's three checks still counted", got)
	}
	listed := map[string]bool{}
	for _, rr := range after["results"].([]any) {
		listed[rr.(map[string]any)["node_id"].(string)] = true
	}
	for id, why := range map[string]string{
		byURL[broken]:   "deleted",
		byURL[repaired]: "repaired since the scan",
		byURL[vanished]: "deleted before the batch",
	} {
		if listed[id] {
			t.Errorf("results still list the bookmark that was %s", why)
		}
	}
	if len(listed) != 0 {
		t.Errorf("results = %v, want every stale finding dropped", listed)
	}
}

// TestLinkCheckDeleteRefusesASupersededRun is the version half of the re-check:
// the findings on screen must belong to the run the server still treats as
// current, or the page is deleting on evidence it never showed the user.
func TestLinkCheckDeleteRefusesASupersededRun(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	seedBookmarks(t, f, h, "https://gone.example/404")
	useChecker(t, f, classifyChecker())

	oldJob, _ := enqueueLinkCheck(t, f, h)
	startQueue(t, f.srv)
	done := waitForDone(t, f, h, 1)
	nodeID := done["results"].([]any)[0].(map[string]any)["node_id"].(string)

	// A second run takes the space over; its snapshot has no result yet.
	newJob, _ := enqueueLinkCheck(t, f, h)
	if newJob == oldJob {
		t.Fatal("the second run reused the first job id")
	}

	code, body := deleteBroken(t, f, h, oldJob, []string{nodeID})
	if code != http.StatusConflict || errCode(t, body) != "LINK_RUN_STALE" {
		t.Fatalf("delete against a superseded run = %d %v, want 409 LINK_RUN_STALE", code, body)
	}
	if len(spaceNodeMap(t, f, h, f.spaceID)) != 1 {
		t.Error("a refused request still deleted something")
	}
}

func TestLinkCheckDeleteRejectsABatchItCannotVerify(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	seedBookmarks(t, f, h, "https://gone.example/404")
	useChecker(t, f, classifyChecker())
	jobID, _ := enqueueLinkCheck(t, f, h)

	if code, body := deleteBroken(t, f, h, jobID, nil); code != http.StatusBadRequest ||
		errCode(t, body) != "BATCH_REQUIRED" {
		t.Errorf("empty batch = %d %v, want 400 BATCH_REQUIRED", code, body)
	}
	if code, body := deleteBroken(t, f, h, "", []string{"n-1"}); code != http.StatusBadRequest ||
		errCode(t, body) != "BATCH_REQUIRED" {
		t.Errorf("missing run = %d %v, want 400 BATCH_REQUIRED", code, body)
	}
	// A space that never ran a link check has nothing to delete against.
	code, fresh := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", h,
		map[string]string{"name": "Unchecked"})
	if code != http.StatusCreated {
		t.Fatalf("second space = %d %v", code, fresh)
	}
	uncheckedURL := f.ts.URL + "/api/v1/spaces/" + fresh["id"].(string) + "/organizer/link-check/delete"
	if code, body := doJSON(t, "POST", uncheckedURL, h,
		map[string]any{"job_id": "job-never-ran", "node_ids": []string{"n-1"}}); code != http.StatusNotFound ||
		errCode(t, body) != "LINK_RUN_NOT_FOUND" {
		t.Errorf("space with no run = %d %v, want 404 LINK_RUN_NOT_FOUND", code, body)
	}
	// And a batch aimed at someone else's space is refused by the access layer
	// before any of this matters.
	if code, body := doJSON(t, "POST",
		f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/organizer/link-check/delete", bearer(f.bobToken),
		map[string]any{"job_id": jobID, "node_ids": []string{"n-1"}}); code != http.StatusForbidden {
		t.Errorf("bob deleting in alice's space = %d %v, want 403", code, body)
	}

	// An id the run never recorded is refused rather than handed to the tree.
	code, body := deleteBroken(t, f, h, jobID, []string{"0198c0de-7000-7000-8000-0000000000ff"})
	if code != http.StatusOK {
		t.Fatalf("delete = %d %v", code, body)
	}
	if got := deletedOf(t, body); len(got) != 0 {
		t.Errorf("deleted = %v for a node the run never recorded", got)
	}

	tooMany := make([]string, maxLinkDeletionBatch+1)
	for i := range tooMany {
		tooMany[i] = fmt.Sprintf("n-%d", i)
	}
	if code, body := deleteBroken(t, f, h, jobID, tooMany); code != http.StatusBadRequest ||
		errCode(t, body) != "BATCH_TOO_LARGE" {
		t.Errorf("oversized batch = %d %v, want 400 BATCH_TOO_LARGE", code, body)
	}
}
