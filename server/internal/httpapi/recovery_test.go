package httpapi

// Mapping-lost recovery over the public API (doc 06 §12).
//
// The extension used to run its own planner for this case. Before that copy
// can be removed, the server side has to provably cover it: a device that
// woke up with no trustworthy Canonical ↔ Browser mapping must be re-matched,
// not mass-recreated; the server's own nodes must survive; data only the
// browser has must still get uploaded; and the baseline the device resumes at
// must be the snapshot point, so anything the space gained during the
// recovery still arrives through the ordinary stream.

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"pontis/internal/reconcile"
)

// lostMappingSnapshot is the same browser tree re-declared with fresh local
// refs and no canonical ids — what a replica whose mapping table was wiped
// actually has to say.
func lostMappingSnapshot(nodes ...reconcile.ClientNodeJSON) reconcile.ClientSnapshotJSON {
	return browserSnapshotWith(nodes...)
}

// runRecovery drives a whole `recovery` reconciliation and reports the apply
// steps the server handed back plus the watermark the binding was completed at.
func runRecovery(t *testing.T, ts *httptest.Server, auth map[string]string,
	bindingID string, snap reconcile.ClientSnapshotJSON) (map[string]any, int64) {
	t.Helper()
	base := ts.URL + "/api/v1/sync"

	created := mustCall(t, http.MethodPost, base+"/bindings/"+bindingID+"/reconciliations", auth,
		map[string]string{"type": "recovery", "reason": "mapping lost"})
	sessionID := fieldString(sessionOf(t, created), "id")

	mustCall(t, http.MethodPost, base+"/bindings/"+bindingID+"/client-snapshots", auth, snap)
	mustCall(t, http.MethodPost, base+"/bindings/"+bindingID+"/server-snapshots", auth, nil)

	planned := mustCall(t, http.MethodPost, base+"/reconciliations/"+sessionID+"/plan", auth, nil)
	if fieldString(sessionOf(t, planned), "state") == string(reconcile.StateWaitingUser) {
		// An unattended round takes the safe default on every issue, which for
		// an ambiguous identity is "create a duplicate", never a guess.
		decisions := map[string]string{}
		for _, raw := range issuesOf(planned) {
			issue := raw.(map[string]any)
			decisions[fieldString(issue, "id")] = fieldString(issue, "default_choice")
		}
		mustCall(t, http.MethodPut, base+"/reconciliations/"+sessionID+"/decisions", auth,
			map[string]any{"decisions": decisions})
	}
	mustCall(t, http.MethodPost, base+"/reconciliations/"+sessionID+"/commit", auth, nil)
	// The preview a user approves must match what the commit does, and a
	// recovery commits no canonical change (doc 06 §11). It used to advertise
	// mass creates plus deletes for the nodes it was only re-mapping.
	assertEmptyCanonicalPlan(t, planned)
	steps := mustCall(t, http.MethodGet, base+"/reconciliations/"+sessionID+"/steps", auth, nil)

	done := mustCall(t, http.MethodPost, base+"/reconciliations/"+sessionID+"/complete", auth, nil)
	binding, _ := done["binding"].(map[string]any)
	if binding == nil {
		t.Fatalf("recovery complete returned no binding: %v", done)
	}
	if state := fieldString(binding, "state"); state != "active" {
		t.Fatalf("binding state after recovery = %s, want active", state)
	}
	return steps, fieldInt(t, binding, "applied_revision")
}

func stepKinds(t *testing.T, steps map[string]any) map[string]int {
	t.Helper()
	list, _ := steps["steps"].([]any)
	if list == nil {
		t.Fatalf("steps payload has no step list: %v", steps)
	}
	counts := map[string]int{}
	for _, raw := range list {
		step := raw.(map[string]any)
		kind := fieldString(step, "kind")
		counts[kind]++
		if kind == "delete" {
			t.Errorf("a recovery plan would delete canonical node %v", step)
		}
	}
	return counts
}

func TestMappingLostRecoveryReMatchesWithoutTouchingTheCanonicalTree(t *testing.T) {
	ts, sessionToken, spaceID, sessionAuth := bootstrapInstance(t)
	auth, bindingID := pairDevice(t, ts, sessionToken, spaceID, "Edge@Home")

	initializeBinding(t, ts, auth, bindingID, browserSnapshotWith(
		reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "folder", Title: "Reading"},
		reconcile.ClientNodeJSON{LocalRef: "l_3", ParentLocalRef: "l_2", Type: "bookmark",
			Title: "Example", URL: "https://example.com"},
		reconcile.ClientNodeJSON{LocalRef: "l_4", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Go", URL: "https://go.example"},
	))
	before := nodeTitles(t, ts, sessionAuth, spaceID)
	if len(before) != 3 {
		t.Fatalf("canonical nodes before the loss = %d %v, want 3", len(before), before)
	}

	steps, baseline := runRecovery(t, ts, auth, bindingID, lostMappingSnapshot(
		reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "folder", Title: "Reading"},
		reconcile.ClientNodeJSON{LocalRef: "l_3", ParentLocalRef: "l_2", Type: "bookmark",
			Title: "Example", URL: "https://example.com"},
		reconcile.ClientNodeJSON{LocalRef: "l_4", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Go", URL: "https://go.example"},
		// Content only this browser has.
		reconcile.ClientNodeJSON{LocalRef: "l_5", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Fresh", URL: "https://fresh.example"},
	))

	counts := stepKinds(t, steps)
	// doc 06 §12's failure mode is a flood of CREATEs for nodes the space
	// already holds: the three re-declared nodes come back as identity
	// assignments, and nothing in the browser is asked to be removed.
	if counts["assign_identity"] < 3 {
		t.Errorf("recovery re-mapped %d nodes, want the 3 the browser still holds (steps %v)",
			counts["assign_identity"], counts)
	}
	if counts["create"] != 0 || counts["delete"] != 0 {
		t.Errorf("recovery steps should only re-map, got %v", counts)
	}
	if baseline <= 0 {
		t.Errorf("recovery completed at baseline %d, want a positive revision", baseline)
	}

	// A recovery commits no canonical change (doc 06 §11): browser-only data
	// is protected through the Recovery Intent review, not by writing nodes
	// here. What this pins is the destructive half — the space must come out
	// of a mapping loss with exactly what it had.
	after := nodeTitles(t, ts, sessionAuth, spaceID)
	if len(after) != len(before) {
		t.Fatalf("canonical tree changed during recovery: before %v after %v", before, after)
	}
	for _, keep := range before {
		if !slices.Contains(after, keep) {
			t.Errorf("recovery lost %q (has %v)", keep, after)
		}
	}
}

// assertEmptyCanonicalPlan pins that a reconciliation which commits no
// canonical change also previews none. The answer a user approves before a
// recovery must not list creates and deletes that will never happen.
func assertEmptyCanonicalPlan(t *testing.T, planned map[string]any) {
	t.Helper()
	plan, ok := planned["plan"].(map[string]any)
	if !ok {
		t.Fatalf("planned answer carries no plan preview: %v", planned)
	}
	stats, ok := plan["stats"].(map[string]any)
	if !ok {
		t.Fatalf("plan preview carries no stats: %v", plan)
	}
	for _, field := range []string{"creates", "updates", "moves", "deletes"} {
		if n, _ := stats[field].(float64); n != 0 {
			t.Errorf("recovery plan advertises %d %s, want no canonical change (warnings %v)",
				int(n), field, plan["warnings"])
		}
	}
	if ops, ok := plan["operations"].([]any); ok && len(ops) != 0 {
		t.Errorf("recovery plan lists %d operations, want none", len(ops))
	}
}

// TestRecoveryResumesAtTheSnapshotPoint pins the difference between an initial
// merge and a recovery: the recovering device re-declared the state it was
// planned against, so it may only be released as far as that snapshot.
// Anything the space gained while the recovery ran is still an incoming change.
func TestRecoveryResumesAtTheSnapshotPoint(t *testing.T) {
	ts, sessionToken, spaceID, sessionAuth := bootstrapInstance(t)
	lostAuth, lostBinding := pairDevice(t, ts, sessionToken, spaceID, "Edge@Home")
	initializeBinding(t, ts, lostAuth, lostBinding, browserSnapshotWith(
		reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Example", URL: "https://example.com"},
	))

	otherAuth, otherBinding := pairDevice(t, ts, sessionToken, spaceID, "Chrome@Work")
	_, otherBase := initializeBinding(t, ts, otherAuth, otherBinding, emptyBrowserSnapshot())
	other := &replica{bindingID: otherBinding, auth: otherAuth, epoch: 1,
		applied: otherBase, received: otherBase}

	base := ts.URL + "/api/v1/sync"
	created := mustCall(t, http.MethodPost, base+"/bindings/"+lostBinding+"/reconciliations", lostAuth,
		map[string]string{"type": "recovery", "reason": "mapping lost"})
	sessionID := fieldString(sessionOf(t, created), "id")
	mustCall(t, http.MethodPost, base+"/bindings/"+lostBinding+"/client-snapshots", lostAuth,
		lostMappingSnapshot(reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1",
			Type: "bookmark", Title: "Example", URL: "https://example.com"}))
	// The point the plan was built against is the frozen server snapshot, and
	// that is where a recovering device may be released to — not the commit
	// head, which also contains the other device's newer work.
	snapshot := mustCall(t, http.MethodPost, base+"/bindings/"+lostBinding+"/server-snapshots", lostAuth, nil)
	target := fieldInt(t, snapshot, "revision")
	mustCall(t, http.MethodPost, base+"/reconciliations/"+sessionID+"/plan", lostAuth, nil)
	mustCall(t, http.MethodPost, base+"/reconciliations/"+sessionID+"/commit", lostAuth, nil)

	// The space moves while the recovering device is still applying its steps.
	other.create(t, ts, "Arrived During Recovery", "https://during.example")

	mustCall(t, http.MethodGet, base+"/reconciliations/"+sessionID+"/steps", lostAuth, nil)
	done := mustCall(t, http.MethodPost, base+"/reconciliations/"+sessionID+"/complete", lostAuth, nil)
	binding, _ := done["binding"].(map[string]any)
	if binding == nil {
		t.Fatalf("complete returned no binding: %v", done)
	}
	resumed := fieldInt(t, binding, "applied_revision")
	if resumed != target {
		t.Fatalf("recovery completed at %d, want the snapshot point %d it was planned against", resumed, target)
	}

	// So the change that landed mid-flight must still come down the stream.
	lost := &replica{bindingID: lostBinding, auth: lostAuth, epoch: 1,
		applied: resumed, received: resumed}
	body := lost.round(t, ts, nil)
	titles := map[string]bool{}
	for _, raw := range body["changes"].([]any) {
		change := raw.(map[string]any)
		if payload, ok := change["payload"].(map[string]any); ok {
			titles[fieldString(payload, "title")] = true
		}
	}
	if !titles["Arrived During Recovery"] {
		t.Errorf("the recovering device never pulled the change that arrived mid-recovery: %v", titles)
	}
	if got := nodeTitles(t, ts, sessionAuth, spaceID); len(got) != 2 {
		t.Fatalf("canonical nodes = %d %v, want 2", len(got), got)
	}
}
