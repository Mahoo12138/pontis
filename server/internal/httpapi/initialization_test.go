package httpapi

// First-use tests (doc 08 §9-§14, doc 06 §4): a new device goes from an empty
// instance to a working incremental sync using nothing but the public API. The
// fixture activates nothing by hand and writes no database rows, so an
// unreachable initialization step fails here rather than being skipped.

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"pontis/internal/reconcile"
	"pontis/internal/sync"
)

// emptyBrowserSnapshot is a device that has nothing to merge: the browser
// container it mounts, and no nodes.
func emptyBrowserSnapshot() reconcile.ClientSnapshotJSON {
	return reconcile.ClientSnapshotJSON{
		Epoch:    1,
		Revision: 1,
		Roots: []reconcile.ClientRootJSON{
			{LocalRef: "l_1", RootKey: "main", Title: "Bookmarks Bar"},
		},
	}
}

// browserSnapshotWith is the same mount plus the tree a fresh browser holds.
func browserSnapshotWith(nodes ...reconcile.ClientNodeJSON) reconcile.ClientSnapshotJSON {
	snap := emptyBrowserSnapshot()
	snap.Nodes = nodes
	return snap
}

// mustCall fires one request and fails the test unless the status is 2xx.
func mustCall(t *testing.T, method, url string, auth map[string]string, body any) map[string]any {
	t.Helper()
	code, out := doJSON(t, method, url, auth, body)
	if code < 200 || code > 299 {
		t.Fatalf("%s %s = %d %v", method, url, code, out)
	}
	return out
}

func sessionOf(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	sess, ok := body["session"].(map[string]any)
	if !ok {
		t.Fatalf("no session in %v", body)
	}
	return sess
}

func fieldString(obj map[string]any, key string) string {
	v, _ := obj[key].(string)
	return v
}

func fieldInt(t *testing.T, obj map[string]any, key string) int64 {
	t.Helper()
	v, ok := obj[key].(float64)
	if !ok {
		t.Fatalf("field %q is not a number in %v", key, obj)
	}
	return int64(v)
}

func issuesOf(body map[string]any) []any {
	issues, _ := body["issues"].([]any)
	return issues
}

// pairDevice registers a device through the web session and binds it to the
// space, exactly as the extension pairing flow does.
func pairDevice(t *testing.T, ts *httptest.Server, sessionToken, spaceID, name string) (deviceAuth map[string]string, bindingID string) {
	t.Helper()
	body := mustCall(t, "POST", ts.URL+"/api/v1/devices",
		map[string]string{"Authorization": "Bearer " + sessionToken},
		map[string]string{"name": name, "browser": "chrome", "platform": "macos"})
	token := fieldString(body, "token")
	if token == "" {
		t.Fatal("device registration returned no credential")
	}
	deviceAuth = map[string]string{"Authorization": "Bearer " + token}
	binding := mustCall(t, "POST", ts.URL+"/api/v1/device/bindings", deviceAuth,
		map[string]string{"space_id": spaceID})
	return deviceAuth, fieldString(binding, "id")
}

// initializeBinding drives the documented first-use lifecycle over the public
// API: session, both snapshots, plan, commit, steps, complete. A pending
// binding has no other way to become active (doc 08 §11), and the shared
// fixture is not allowed to shortcut it.
func initializeBinding(t *testing.T, ts *httptest.Server, deviceAuth map[string]string,
	bindingID string, snap reconcile.ClientSnapshotJSON) (sessionID string, commitRevision int64) {
	t.Helper()
	base := ts.URL + "/api/v1/sync"

	created := mustCall(t, "POST", base+"/bindings/"+bindingID+"/reconciliations", deviceAuth,
		map[string]string{"type": "initial", "reason": "first synchronization"})
	sessionID = fieldString(sessionOf(t, created), "id")

	mustCall(t, "POST", base+"/bindings/"+bindingID+"/client-snapshots", deviceAuth, snap)
	mustCall(t, "POST", base+"/bindings/"+bindingID+"/server-snapshots", deviceAuth, nil)

	planned := mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/plan", deviceAuth, nil)
	if fieldString(sessionOf(t, planned), "state") == string(reconcile.StateWaitingUser) {
		// An unattended first synchronization takes the safe default on every
		// issue: duplicate create, never a guess (doc 06 §6).
		decisions := map[string]string{}
		for _, raw := range issuesOf(planned) {
			issue := raw.(map[string]any)
			decisions[fieldString(issue, "id")] = fieldString(issue, "default_choice")
		}
		planned = mustCall(t, "PUT", base+"/reconciliations/"+sessionID+"/decisions", deviceAuth,
			map[string]any{"decisions": decisions})
	}

	committed := mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/commit", deviceAuth, nil)
	commitRevision = fieldInt(t, sessionOf(t, committed), "commit_revision")

	if fieldString(sessionOf(t, planned), "phase") != string(reconcile.PhasePlanned) {
		t.Fatalf("planned session phase = %v, want %s", sessionOf(t, planned)["phase"], reconcile.PhasePlanned)
	}

	steps := mustCall(t, "GET", base+"/reconciliations/"+sessionID+"/steps", deviceAuth, nil)
	if _, ok := steps["steps"].([]any); !ok {
		t.Fatalf("steps payload has no step list: %v", steps)
	}

	done := mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/complete", deviceAuth, nil)
	if state := fieldString(sessionOf(t, done), "state"); state != string(reconcile.StateCompleted) {
		t.Fatalf("session state after complete = %s", state)
	}
	// A finished session has no phase left to resume from, so the field is
	// absent rather than an empty string every client must special-case.
	if _, hasPhase := sessionOf(t, done)["phase"]; hasPhase {
		t.Fatalf("completed session carries a phase: %v", sessionOf(t, done))
	}
	binding, _ := done["binding"].(map[string]any)
	if binding == nil {
		t.Fatalf("complete returned no binding: %v", done)
	}
	if state := fieldString(binding, "state"); state != "active" {
		t.Fatalf("binding state after complete = %s, want active", state)
	}
	return sessionID, commitRevision
}

// replica is one device's view of the sync stream. Watermarks move exactly
// the way the protocol says they may: applied only for changes it applied,
// client_seq only forward (doc 04 §8).
type replica struct {
	bindingID string
	auth      map[string]string
	epoch     int64
	applied   int64
	received  int64
	seq       int64
}

func (r *replica) round(t *testing.T, ts *httptest.Server, ops []map[string]any) map[string]any {
	t.Helper()
	if ops == nil {
		ops = []map[string]any{}
	}
	body := mustCall(t, "POST", ts.URL+"/api/v1/sync/bindings/"+r.bindingID, r.auth, map[string]any{
		"protocol_version":  sync.ProtocolVersion,
		"epoch":             r.epoch,
		"applied_revision":  r.applied,
		"received_revision": r.received,
		"operations":        ops,
	})
	r.received = fieldInt(t, body, "through_revision")
	if len(ops) > 0 {
		r.applied = r.received
	}
	return body
}

// create pushes one bookmark and returns its canonical id.
func (r *replica) create(t *testing.T, ts *httptest.Server, title, url string) string {
	t.Helper()
	nodeID := uuid.Must(uuid.NewV7()).String()
	body := r.round(t, ts, []map[string]any{{
		"op_id":         uuid.Must(uuid.NewV7()).String(),
		"client_seq":    r.seq + 1,
		"base_revision": r.applied,
		"type":          "create",
		"node_id":       nodeID,
		"node_type":     "bookmark",
		"title":         title,
		"url":           url,
		"parent":        map[string]any{"type": "root", "key": "main"},
	}})
	results, _ := body["operation_results"].([]any)
	if len(results) != 1 {
		t.Fatalf("create %s returned %d results: %v", title, len(results), results)
	}
	if status := results[0].(map[string]any)["status"]; status != string(sync.StatusApplied) {
		t.Fatalf("create %s status = %v", title, status)
	}
	r.seq++
	return nodeID
}

// nodeTitles lists the canonical tree through the web API.
func nodeTitles(t *testing.T, ts *httptest.Server, sessionAuth map[string]string, spaceID string) []string {
	t.Helper()
	body := mustCall(t, "GET", ts.URL+"/api/v1/spaces/"+spaceID+"/nodes", sessionAuth, nil)
	rows, _ := body["nodes"].([]any)
	out := make([]string, 0, len(rows))
	for _, raw := range rows {
		out = append(out, fieldString(raw.(map[string]any), "title"))
	}
	return out
}

// createsInPlan reads the create count out of the plan preview an endpoint
// attached to its answer.
func createsInPlan(t *testing.T, body map[string]any) int {
	t.Helper()
	plan, ok := body["plan"].(map[string]any)
	if !ok {
		t.Fatalf("answer carries no plan preview: %v", body)
	}
	stats, ok := plan["stats"].(map[string]any)
	if !ok {
		t.Fatalf("plan carries no stats: %v", plan)
	}
	return int(fieldInt(t, stats, "creates"))
}

// bootstrapInstance brings up an empty instance over the public API and opens
// one space: the state a brand new Pontis server is in.
func bootstrapInstance(t *testing.T) (ts *httptest.Server, sessionToken, spaceID string, sessionAuth map[string]string) {
	t.Helper()
	_, ts, _ = newTestServerWithDB(t)
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
	sessionToken = fieldString(body, "token")
	sessionAuth = map[string]string{"Authorization": "Bearer " + sessionToken}
	space := mustCall(t, "POST", ts.URL+"/api/v1/spaces", sessionAuth, map[string]string{"name": "Personal"})
	return ts, sessionToken, fieldString(space, "id"), sessionAuth
}

// TestFirstUseGoesFromEmptyInstanceToIncrementalSync is the acceptance path of
// the initialization lifecycle: two devices, one space, nothing but public
// endpoints, and a normal /sync round afterwards on both.
func TestFirstUseGoesFromEmptyInstanceToIncrementalSync(t *testing.T) {
	ts, sessionToken, spaceID, sessionAuth := bootstrapInstance(t)

	// Device one has a browser full of bookmarks and a brand new space.
	aAuth, aBinding := pairDevice(t, ts, sessionToken, spaceID, "Edge@Home")

	// While the binding is pending, neither sync nor snapshot is reachable.
	if code, body := doJSON(t, "POST", ts.URL+"/api/v1/sync/bindings/"+aBinding, aAuth, map[string]any{
		"protocol_version": sync.ProtocolVersion, "epoch": 1,
		"applied_revision": 0, "received_revision": 0,
		"operations": []map[string]any{{
			"op_id": uuid.Must(uuid.NewV7()).String(), "client_seq": 1, "base_revision": 0,
			"type": "create", "node_id": uuid.Must(uuid.NewV7()).String(),
			"node_type": "bookmark", "title": "Too soon", "url": "https://too-soon.example",
			"parent": map[string]any{"type": "root", "key": "main"},
		}},
	}); code != http.StatusConflict || errCode(t, body) != "BINDING_NOT_ACTIVE" {
		t.Fatalf("sync on a pending binding = %d %v, want 409 BINDING_NOT_ACTIVE", code, body)
	}
	if code, body := doJSON(t, "GET", ts.URL+"/api/v1/sync/bindings/"+aBinding+"/snapshot", aAuth, nil); code != http.StatusConflict ||
		errCode(t, body) != "BINDING_NOT_ACTIVE" {
		t.Fatalf("snapshot on a pending binding = %d %v, want 409 BINDING_NOT_ACTIVE", code, body)
	}

	_, firstRevision := initializeBinding(t, ts, aAuth, aBinding, browserSnapshotWith(
		reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "folder", Title: "Reading"},
		reconcile.ClientNodeJSON{LocalRef: "l_3", ParentLocalRef: "l_2", Type: "bookmark",
			Title: "Example", URL: "https://example.com"},
		reconcile.ClientNodeJSON{LocalRef: "l_4", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Go", URL: "https://go.example"},
	))

	// The browser's tree is now the server's canonical tree.
	if got := nodeTitles(t, ts, sessionAuth, spaceID); len(got) != 3 {
		t.Fatalf("canonical nodes after the first merge = %d %v, want 3", len(got), got)
	}

	// The device continues on the ordinary stream, from the baseline the
	// reconciliation left it at: its own watermarks start at the commit
	// revision, so the merged tree is not handed back as incoming changes.
	a := &replica{bindingID: aBinding, auth: aAuth, epoch: 1, applied: firstRevision, received: firstRevision}
	head := fieldInt(t, a.round(t, ts, nil), "through_revision")
	if head != firstRevision {
		t.Fatalf("device one pulls to %d, want its baseline %d", head, firstRevision)
	}
	a.create(t, ts, "Later", "https://later.example")

	// Device two joins the same space: its own first synchronization has to
	// hand it the tree that is already there, then the same stream.
	bAuth, bBinding := pairDevice(t, ts, sessionToken, spaceID, "Chrome@Work")
	base := ts.URL + "/api/v1/sync"
	created := mustCall(t, "POST", base+"/bindings/"+bBinding+"/reconciliations", bAuth,
		map[string]string{"type": "initial", "reason": "first synchronization"})
	sessionID := fieldString(sessionOf(t, created), "id")
	mustCall(t, "POST", base+"/bindings/"+bBinding+"/client-snapshots", bAuth, emptyBrowserSnapshot())
	snap := mustCall(t, "POST", base+"/bindings/"+bBinding+"/server-snapshots", bAuth, nil)
	snapshotID := fieldString(snap, "snapshot_id")
	// Walk the frozen tree page by page: the cursors must cover every row
	// exactly once, and the non-root rows must be the tree that was merged
	// plus the bookmark device one pushed over /sync afterwards.
	if got := int(fieldInt(t, snap, "node_count")); got < 4 {
		t.Fatalf("server snapshot holds %d rows, want at least the 4 merged nodes", got)
	}
	frozen := map[string]bool{}
	rows := 0
	for cursor := ""; ; {
		url := base + "/server-snapshots/" + snapshotID + "/nodes?limit=2"
		if cursor != "" {
			url += "&cursor=" + cursor
		}
		page := mustCall(t, "GET", url, bAuth, nil)
		nodes, _ := page["nodes"].([]any)
		for _, raw := range nodes {
			row := raw.(map[string]any)
			rows++
			if fieldString(row, "type") != string(reconcile.NodeRoot) {
				frozen[fieldString(row, "title")] = true
			}
		}
		cursor = fieldString(page, "next_cursor")
		if cursor == "" {
			break
		}
	}
	if rows != int(fieldInt(t, snap, "node_count")) {
		t.Fatalf("paging read %d rows, the snapshot metadata says %d", rows, snap["node_count"])
	}
	for _, title := range []string{"Reading", "Example", "Go", "Later"} {
		if !frozen[title] {
			t.Errorf("the frozen tree is missing %q (it has %v)", title, frozen)
		}
	}

	planned := mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/plan", bAuth, nil)
	if planned["plan"] == nil {
		t.Fatalf("plan preview carries no plan: %v", planned)
	}
	committed := mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/commit", bAuth, nil)
	commitRevision := fieldInt(t, sessionOf(t, committed), "commit_revision")
	steps := mustCall(t, "GET", base+"/reconciliations/"+sessionID+"/steps", bAuth, nil)
	// The browser has nothing the server lacks, so the steps only bring the
	// canonical tree into the browser.
	for _, raw := range steps["steps"].([]any) {
		step := raw.(map[string]any)
		if step["kind"] == "delete" {
			t.Errorf("steps would destroy canonical node %v for a device with an empty browser", step)
		}
	}
	mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/complete", bAuth, nil)

	// Both devices are now ordinary replicas on one stream.
	b := &replica{bindingID: bBinding, auth: bAuth, epoch: 1, applied: commitRevision, received: commitRevision}
	if got := fieldInt(t, b.round(t, ts, nil), "through_revision"); got != commitRevision {
		t.Fatalf("device two pulls to %d, want the baseline %d it was completed at", got, commitRevision)
	}
	a.create(t, ts, "Shared", "https://shared.example")
	shared := fieldInt(t, b.round(t, ts, nil), "through_revision")
	if shared <= commitRevision {
		t.Fatalf("device two never receives device one's bookmark (still at %d)", shared)
	}
	if got := nodeTitles(t, ts, sessionAuth, spaceID); len(got) != 5 {
		t.Fatalf("canonical nodes at the end = %d %v, want 5", len(got), got)
	}
}

// TestSyncRejectsCreateWithoutNodeID covers the id a device owes the node it
// creates (doc 04): it is how the ack and the change stream name that bookmark
// afterwards. An empty node_id used to be stored as a node whose primary key
// is the empty string — no device could ever address, rename or delete it, and
// the next unnamed create would collide with the row already there.
func TestSyncRejectsCreateWithoutNodeID(t *testing.T) {
	ts, sessionToken, spaceID, sessionAuth := bootstrapInstance(t)
	auth, binding := pairDevice(t, ts, sessionToken, spaceID, "Chrome@Guard")
	_, baseline := initializeBinding(t, ts, auth, binding, emptyBrowserSnapshot())

	r := &replica{bindingID: binding, auth: auth, epoch: 1, applied: baseline, received: baseline}
	body := r.round(t, ts, []map[string]any{{
		"op_id": uuid.Must(uuid.NewV7()).String(), "client_seq": 1, "base_revision": baseline,
		"type": "create", "node_id": "", "node_type": "bookmark",
		"title": "Nameless", "url": "https://nameless.example",
		"parent": map[string]any{"type": "root", "key": "main"},
	}})
	results, _ := body["operation_results"].([]any)
	if len(results) != 1 {
		t.Fatalf("unnamed create returned %d results: %v", len(results), results)
	}
	res := results[0].(map[string]any)
	if res["status"] != string(sync.StatusRejected) || res["reason"] != sync.ReasonInvalidPayload {
		t.Errorf("unnamed create = %v %v, want %s %s",
			res["status"], res["reason"], sync.StatusRejected, sync.ReasonInvalidPayload)
	}
	if got := nodeTitles(t, ts, sessionAuth, spaceID); len(got) != 0 {
		t.Errorf("the tree kept the nameless node: %v", got)
	}
}

// TestSyncYieldsToAnOpenReconciliation covers doc 08 §8: a binding cannot run
// normal sync writes and a reconciliation at the same time. Reads stay open —
// the engine re-freezes its target and PLAN_STALE protects the commit.
func TestSyncYieldsToAnOpenReconciliation(t *testing.T) {
	st := bootstrapFlow(t)
	auth := map[string]string{"Authorization": "Bearer " + st.deviceToken}
	r := &replica{bindingID: st.bindingID, auth: auth, epoch: 1, applied: st.baseline, received: st.baseline}

	created := mustCall(t, "POST", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID+"/reconciliations", auth,
		map[string]string{"type": "recovery", "reason": "manual reconnection"})
	sessionID := fieldString(sessionOf(t, created), "id")
	t.Cleanup(func() {
		// The session must be finished or every later test on this binding
		// would see it as busy; this is the documented way out.
		_, _ = doJSON(t, "POST", st.ts.URL+"/api/v1/sync/reconciliations/"+sessionID+"/complete", auth, nil)
	})

	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID, auth, map[string]any{
		"protocol_version": sync.ProtocolVersion, "epoch": 1,
		"applied_revision": r.applied, "received_revision": r.received,
		"operations": []map[string]any{{
			"op_id": uuid.Must(uuid.NewV7()).String(), "client_seq": 1, "base_revision": r.applied,
			"type": "create", "node_id": uuid.Must(uuid.NewV7()).String(),
			"node_type": "bookmark", "title": "Midflight", "url": "https://midflight.example",
			"parent": map[string]any{"type": "root", "key": "main"},
		}},
	})
	if code != http.StatusConflict || errCode(t, body) != sync.CodeReconciliationInProgress {
		t.Fatalf("sync during a reconciliation = %d %v, want 409 %s",
			code, body, sync.CodeReconciliationInProgress)
	}

	// The tree is still readable while the session is open.
	if code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID+"/snapshot", auth, nil); code != http.StatusOK {
		t.Fatalf("snapshot during a reconciliation = %d %v", code, body)
	}
	if got := fieldInt(t, r.round(t, st.ts, nil), "through_revision"); got != st.baseline {
		t.Fatalf("pull during a reconciliation reached %d, want %d", got, st.baseline)
	}

	// Closing the lifecycle frees the binding for normal sync again.
	mustCall(t, "POST", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID+"/client-snapshots", auth, emptyBrowserSnapshot())
	mustCall(t, "POST", st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID+"/server-snapshots", auth, nil)
	planned := mustCall(t, "POST", st.ts.URL+"/api/v1/sync/reconciliations/"+sessionID+"/plan", auth, nil)
	if fieldString(sessionOf(t, planned), "phase") != string(reconcile.PhasePlanned) {
		t.Fatalf("recovery session phase after plan = %v", sessionOf(t, planned))
	}
	mustCall(t, "POST", st.ts.URL+"/api/v1/sync/reconciliations/"+sessionID+"/commit", auth, nil)
	mustCall(t, "POST", st.ts.URL+"/api/v1/sync/reconciliations/"+sessionID+"/complete", auth, nil)

	r.create(t, st.ts, "Afterwards", "https://afterwards.example")
}

// TestFirstReconciliationRejectsClaimedCanonicalIDs: a device with no mapping
// is not believed about identity (doc 06 §11). The one reconciliation where
// the client has nothing to map from must declare refs only.
func TestFirstReconciliationRejectsClaimedCanonicalIDs(t *testing.T) {
	ts, sessionToken, spaceID, _ := bootstrapInstance(t)

	// The space already has a node, so a claimed id could resolve to something
	// real: the first reconciliation still refuses the claim.
	firstAuth, firstBinding := pairDevice(t, ts, sessionToken, spaceID, "Edge@Home")
	_, head := initializeBinding(t, ts, firstAuth, firstBinding, browserSnapshotWith(
		reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Existing", URL: "https://existing.example"},
	))
	_ = head

	impostorAuth, impostorBinding := pairDevice(t, ts, sessionToken, spaceID, "Firefox@Laptop")
	base := ts.URL + "/api/v1/sync"
	mustCall(t, "POST", base+"/bindings/"+impostorBinding+"/reconciliations", impostorAuth,
		map[string]string{"type": "initial", "reason": "first synchronization"})

	claimed := uuid.Must(uuid.NewV7()).String()
	code, body := doJSON(t, "POST", base+"/bindings/"+impostorBinding+"/client-snapshots", impostorAuth,
		browserSnapshotWith(reconcile.ClientNodeJSON{
			LocalRef: "l_2", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Claimed", URL: "https://claimed.example", CanonicalID: claimed,
		}))
	if code != http.StatusBadRequest || errCode(t, body) != "CLIENT_SNAPSHOT_INVALID" {
		t.Fatalf("first snapshot with a canonical id = %d %v, want 400 CLIENT_SNAPSHOT_INVALID", code, body)
	}

	// The same device is accepted once it drops the claim, so the rule is the
	// claim itself and not the endpoint.
	mustCall(t, "POST", base+"/bindings/"+impostorBinding+"/client-snapshots", impostorAuth,
		browserSnapshotWith(reconcile.ClientNodeJSON{
			LocalRef: "l_2", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Claimed", URL: "https://claimed.example",
		}))
}

// TestAmbiguousFirstMergeAsksTheUserBeforeItGuesses covers the one case the
// engine refuses to decide alone (doc 06 §6, doc 08 §11-§12): the browser holds
// a bookmark the canonical tree has twice. It asks, it only accepts an answer it
// offered, and the answer it takes by default duplicates rather than merges.
func TestAmbiguousFirstMergeAsksTheUserBeforeItGuesses(t *testing.T) {
	ts, sessionToken, spaceID, sessionAuth := bootstrapInstance(t)
	dupURL := "https://twice.example"

	aAuth, aBinding := pairDevice(t, ts, sessionToken, spaceID, "Edge@Home")
	initializeBinding(t, ts, aAuth, aBinding, browserSnapshotWith(
		reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Twice", URL: dupURL},
		reconcile.ClientNodeJSON{LocalRef: "l_3", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Twice", URL: dupURL},
	))

	bAuth, bBinding := pairDevice(t, ts, sessionToken, spaceID, "Firefox@Laptop")
	base := ts.URL + "/api/v1/sync"
	created := mustCall(t, "POST", base+"/bindings/"+bBinding+"/reconciliations", bAuth,
		map[string]string{"type": "initial", "reason": "first synchronization"})
	sessionID := fieldString(sessionOf(t, created), "id")
	mustCall(t, "POST", base+"/bindings/"+bBinding+"/client-snapshots", bAuth, browserSnapshotWith(
		reconcile.ClientNodeJSON{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "bookmark",
			Title: "Twice", URL: dupURL},
	))
	mustCall(t, "POST", base+"/bindings/"+bBinding+"/server-snapshots", bAuth, nil)

	planned := mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/plan", bAuth, nil)
	if state := fieldString(sessionOf(t, planned), "state"); state != string(reconcile.StateWaitingUser) {
		t.Fatalf("session state with an unresolved identity = %s, want %s",
			state, reconcile.StateWaitingUser)
	}
	issues := issuesOf(planned)
	if len(issues) != 1 {
		t.Fatalf("issues = %v, want the one ambiguous bookmark", issues)
	}
	issue := issues[0].(map[string]any)
	issueID := fieldString(issue, "id")
	if got := fieldString(issue, "type"); got != reconcile.IssueAmbiguousIdentity {
		t.Errorf("issue type = %s, want %s", got, reconcile.IssueAmbiguousIdentity)
	}
	payload, _ := issue["payload"].(map[string]any)
	candidates, _ := payload["candidates"].([]any)
	if len(candidates) != 2 {
		t.Fatalf("candidates = %v, want the two identical canonical bookmarks", payload["candidates"])
	}
	// An empty default is the safe one: keep both bookmarks.
	if fieldString(issue, "default_choice") != "" {
		t.Errorf("default choice = %v, want the empty one (duplicate rather than merge)", issue["default_choice"])
	}
	if got := createsInPlan(t, planned); got != 1 {
		t.Errorf("creates while the ambiguity is open = %d, want the duplicate the default makes", got)
	}
	// An empty list is empty on the wire, never null (doc 04 §6).
	if _, ok := planned["plan"].(map[string]any)["warnings"].([]any); !ok {
		t.Errorf("plan warnings = %#v, want an array", planned["plan"].(map[string]any)["warnings"])
	}

	// Only a candidate the server offered is a legal answer.
	code, body := doJSON(t, "PUT", base+"/reconciliations/"+sessionID+"/decisions", bAuth,
		map[string]any{"decisions": map[string]string{
			issueID: uuid.Must(uuid.NewV7()).String(),
		}})
	if code != http.StatusBadRequest || errCode(t, body) != "RECONCILIATION_DECISION_INVALID" {
		t.Fatalf("decision outside the candidate set = %d %v, want 400 RECONCILIATION_DECISION_INVALID",
			code, body)
	}

	chosen := candidates[0].(string)
	// An issue id from somewhere else is not an answer to anything.
	if code, body := doJSON(t, "PUT", base+"/reconciliations/"+sessionID+"/decisions", bAuth,
		map[string]any{"decisions": map[string]string{
			uuid.Must(uuid.NewV7()).String(): chosen,
		}}); code != http.StatusConflict || errCode(t, body) != "RECONCILIATION_PHASE_INVALID" {
		t.Fatalf("decision on an unknown issue = %d %v, want 409 RECONCILIATION_PHASE_INVALID", code, body)
	}

	decided := mustCall(t, "PUT", base+"/reconciliations/"+sessionID+"/decisions", bAuth,
		map[string]any{"decisions": map[string]string{issueID: chosen}})
	if left := issuesOf(decided); len(left) != 0 {
		t.Fatalf("issues after the decision = %v, want none", left)
	}
	if state := fieldString(sessionOf(t, decided), "state"); state != string(reconcile.StateRunning) {
		t.Fatalf("state after the last issue = %s, want %s", state, reconcile.StateRunning)
	}
	if got := createsInPlan(t, decided); got != 0 {
		t.Errorf("creates after the decision = %d, want 0: the bookmark keeps the canonical id it was matched to", got)
	}
	// With nothing left to ask, the session no longer takes decisions.
	if code, body := doJSON(t, "PUT", base+"/reconciliations/"+sessionID+"/decisions", bAuth,
		map[string]any{"decisions": map[string]string{issueID: chosen}}); code != http.StatusConflict ||
		errCode(t, body) != "RECONCILIATION_PHASE_INVALID" {
		t.Fatalf("decision on a running session = %d %v, want 409 RECONCILIATION_PHASE_INVALID", code, body)
	}

	mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/commit", bAuth, nil)
	steps := mustCall(t, "GET", base+"/reconciliations/"+sessionID+"/steps", bAuth, nil)
	mapped := false
	for _, raw := range steps["steps"].([]any) {
		step := raw.(map[string]any)
		if step["kind"] == "delete" {
			t.Errorf("the decided merge would destroy canonical node %v", step)
		}
		if step["local_ref"] == "l_2" && step["canonical_id"] == chosen {
			mapped = true
		}
	}
	if !mapped {
		t.Errorf("no step maps the browser bookmark onto the chosen id %s: %v", chosen, steps["steps"])
	}
	mustCall(t, "POST", base+"/reconciliations/"+sessionID+"/complete", bAuth, nil)

	// The space holds exactly the bookmarks it already had: deciding an
	// identity merges, it does not add.
	if got := nodeTitles(t, ts, sessionAuth, spaceID); len(got) != 2 {
		t.Fatalf("canonical nodes after the decided merge = %d %v, want the 2 that already existed",
			len(got), got)
	}
}

// TestReconciliationResourcesAreOwnedByTheirDevice checks that a session id
// and a snapshot id are not capabilities (doc 22 D.6).
func TestReconciliationResourcesAreOwnedByTheirDevice(t *testing.T) {
	ts, sessionToken, spaceID, _ := bootstrapInstance(t)

	ownerAuth, ownerBinding := pairDevice(t, ts, sessionToken, spaceID, "Edge@Home")
	intruderAuth, _ := pairDevice(t, ts, sessionToken, spaceID, "Chrome@Work")

	base := ts.URL + "/api/v1/sync"
	created := mustCall(t, "POST", base+"/bindings/"+ownerBinding+"/reconciliations", ownerAuth,
		map[string]string{"type": "initial", "reason": "first synchronization"})
	sessionID := fieldString(sessionOf(t, created), "id")
	mustCall(t, "POST", base+"/bindings/"+ownerBinding+"/client-snapshots", ownerAuth, emptyBrowserSnapshot())
	snap := mustCall(t, "POST", base+"/bindings/"+ownerBinding+"/server-snapshots", ownerAuth, nil)
	snapshotID := fieldString(snap, "snapshot_id")

	for _, url := range []string{
		base + "/reconciliations/" + sessionID,
		base + "/reconciliations/" + sessionID + "/steps",
		base + "/server-snapshots/" + snapshotID,
		base + "/server-snapshots/" + snapshotID + "/nodes",
	} {
		if code, body := doJSON(t, "GET", url, intruderAuth, nil); code != http.StatusForbidden ||
			errCode(t, body) != "NOT_BINDING_OWNER" {
			t.Errorf("GET %s with another device = %d %v, want 403 NOT_BINDING_OWNER", url, code, body)
		}
	}
	// Writing to someone else's lifecycle is refused the same way.
	if code, body := doJSON(t, "POST", base+"/reconciliations/"+sessionID+"/commit", intruderAuth, nil); code != http.StatusForbidden {
		t.Errorf("commit with another device = %d %v, want 403", code, body)
	}
	// An unknown id is a 404, not a 403: it leaks nothing about existence.
	if code, body := doJSON(t, "GET", base+"/reconciliations/does-not-exist", ownerAuth, nil); code != http.StatusNotFound ||
		errCode(t, body) != "RECONCILIATION_NOT_FOUND" {
		t.Errorf("unknown session = %d %v, want 404 RECONCILIATION_NOT_FOUND", code, body)
	}
}
