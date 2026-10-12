package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The start page is a read that is bounded by an approval rather than by the
// tree the caller can name. These tests are mostly about what does not come
// back.

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

// startPageFlow is one account with a paired device and a tree:
//
//	Entries (folder) — the usual source
//	  Daily (folder) → MDN, Deep
//	  GitHub
//	Outside — a bookmark hanging off the root slot, above every source
type startPageFlow struct {
	t           *testing.T
	ts          *httptest.Server
	instanceID  string
	session     map[string]string
	device      map[string]string
	deviceToken string
	deviceID    string
	spaceID     string
	bobSession  map[string]string

	entries string
	daily   string
	mdn     string
	deep    string
	github  string
	outside string
}

func bootstrapStartPageFlow(t *testing.T) *startPageFlow {
	t.Helper()
	base := bootstrapLibraryFlow(t)
	f := &startPageFlow{
		t:           t,
		ts:          base.ts,
		instanceID:  base.srv.InstanceID,
		session:     map[string]string{"Authorization": "Bearer " + base.sessionToken},
		device:      map[string]string{"Authorization": "Bearer " + base.deviceToken},
		deviceToken: base.deviceToken,
		spaceID:     base.spaceID,
		bobSession:  map[string]string{"Authorization": "Bearer " + base.bobToken},
	}
	f.deviceID = f.deviceIDs()[0]

	create := func(typ, title, url, parent string) string {
		t.Helper()
		body := map[string]any{"type": typ, "title": title, "url": url}
		if parent == "" {
			body["parent"] = map[string]string{"type": "root", "key": "main"}
		} else {
			body["parent"] = map[string]string{"type": "node", "id": parent}
		}
		code, out := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes", f.session, body)
		if code != http.StatusCreated {
			t.Fatalf("create %s = %d %v", title, code, out)
		}
		return out["id"].(string)
	}
	f.entries = create("folder", "Entries", "", "")
	f.daily = create("folder", "Daily", "", f.entries)
	// The two children are created in this order and must come back in it:
	// the start page shows the tree as the workbench ordered it (§6.2).
	f.mdn = create("bookmark", "MDN", "https://developer.mozilla.org", f.daily)
	f.deep = create("bookmark", "Deep", "https://deep.example", f.daily)
	f.github = create("bookmark", "GitHub", "https://github.com/", f.entries)
	f.outside = create("bookmark", "Outside", "https://outside.example", "")
	return f
}

// deviceIDs lists the account's device ids, newest binding target first.
func (f *startPageFlow) deviceIDs() []string {
	f.t.Helper()
	code, out := doJSON(f.t, "GET", f.ts.URL+"/api/v1/devices/overview", f.session, nil)
	if code != http.StatusOK {
		f.t.Fatalf("device overview = %d %v", code, out)
	}
	devices, _ := out["devices"].([]any)
	ids := make([]string, 0, len(devices))
	for _, d := range devices {
		row, ok := d.(map[string]any)
		if !ok {
			continue
		}
		if id, ok := row["id"].(string); ok && id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		f.t.Fatalf("no devices in %v", out)
	}
	return ids
}

// bindingsOf counts how many spaces one device is subscribed to.
func (f *startPageFlow) bindingsOf(deviceID string) int {
	f.t.Helper()
	_, out := doJSON(f.t, "GET", f.ts.URL+"/api/v1/devices/overview", f.session, nil)
	devices, _ := out["devices"].([]any)
	for _, d := range devices {
		row, ok := d.(map[string]any)
		if !ok || row["id"] != deviceID {
			continue
		}
		list, _ := row["bindings"].([]any)
		return len(list)
	}
	f.t.Fatalf("device %s not in the overview", deviceID)
	return 0
}

func (f *startPageFlow) authorizeWith(auth map[string]string, deviceID, spaceID, folderID string) (int, map[string]any) {
	f.t.Helper()
	return doJSON(f.t, "POST", f.ts.URL+"/api/v1/start-page-grants", auth,
		map[string]string{"device_id": deviceID, "space_id": spaceID, "folder_id": folderID})
}

func (f *startPageFlow) authorize(deviceID, folderID string) (int, map[string]any) {
	return f.authorizeWith(f.session, deviceID, f.spaceID, folderID)
}

func (f *startPageFlow) grantID() string {
	f.t.Helper()
	code, out := doJSON(f.t, "GET", f.ts.URL+"/api/v1/start-page-grants", f.session, nil)
	if code != http.StatusOK {
		f.t.Fatalf("list grants = %d %v", code, out)
	}
	grants, _ := out["grants"].([]any)
	if len(grants) == 0 {
		f.t.Fatalf("no grants listed: %v", out)
	}
	id, _ := grants[0].(map[string]any)["grant_id"].(string)
	if id == "" {
		f.t.Fatalf("grant has no id: %v", grants[0])
	}
	return id
}

// deviceSnapshot reads the approved source through the device credential.
func (f *startPageFlow) deviceSnapshot() (int, http.Header, string) {
	f.t.Helper()
	return getRaw(f.t, f.ts.URL+"/api/v1/device/start-page/snapshot", f.device)
}

func (f *startPageFlow) mustDeviceSnapshot() string {
	f.t.Helper()
	code, _, body := f.deviceSnapshot()
	if code != http.StatusOK {
		f.t.Fatalf("snapshot = %d %s", code, body)
	}
	return body
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

// SP-01: a paired device with no approved source is the state that shows the
// configuration entry, not an error the page can only report.
func TestDeviceStartPageWithoutAGrant(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	for _, path := range []string{"/api/v1/device/start-page", "/api/v1/device/start-page/snapshot"} {
		code, body := doJSON(t, "GET", f.ts.URL+path, f.device, nil)
		if code != http.StatusNotFound || errCode(t, body) != "START_PAGE_NOT_CONFIGURED" {
			t.Errorf("%s = %d %v, want 404 START_PAGE_NOT_CONFIGURED", path, code, body)
		}
	}
}

func TestStartPageGrantIsApprovedByTheAccountNotTheDevice(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	// The credential that reads the source may not widen it. Left to the
	// session middleware a pdv_ secret fails as SESSION_INVALID, which an
	// extension would answer by re-pairing.
	code, body := f.authorizeWith(f.device, f.deviceID, f.spaceID, f.entries)
	if code != http.StatusForbidden || errCode(t, body) != "START_PAGE_PERMISSION_REQUIRED" {
		t.Fatalf("device-authored grant = %d %v", code, body)
	}
	if _, out := doJSON(t, "GET", f.ts.URL+"/api/v1/device/start-page", f.device, nil); out["error"] == nil {
		t.Fatal("a device-authored grant took effect")
	}

	code, _ = f.authorizeWith(nil, f.deviceID, f.spaceID, f.entries)
	if code != http.StatusUnauthorized {
		t.Fatalf("anonymous grant = %d %v", code, body)
	}
}

func TestStartPageSourceIsScopedToTheFolder(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, out := f.authorize(f.deviceID, f.entries)
	if code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}
	if out["folder_id"] != f.entries || out["grant_version"] != float64(1) {
		t.Fatalf("grant = %v", out)
	}
	if out["space_name"] != "Personal" {
		t.Errorf("source = %v, want the space named for the picker", out)
	}

	code, header, body := f.deviceSnapshot()
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
	// starts at the folder the account approved, and the page cannot climb.
	if containsID(ids, f.outside) {
		t.Errorf("nodes = %v reached outside the source", ids)
	}
	if containsID(ids, f.entries) {
		t.Errorf("nodes = %v includes the source itself", ids)
	}

	snap := snapshotBody(t, body)
	if snap["instance_id"] != f.instanceID || snap["schema_version"] != float64(1) {
		t.Errorf("envelope = %v", snap)
	}
	meta, _ := snap["snapshot"].(map[string]any)
	if meta["complete"] != true {
		t.Errorf("snapshot = %v, want complete", meta)
	}
	// Epoch and revision stay integers, the encoding the sync protocol
	// already uses for watermarks: one number, one representation.
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
	if code, out := f.authorize(f.deviceID, f.entries); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}
	body := f.mustDeviceSnapshot()

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

	// Siblings come back in canonical order, and no entry is duplicated.
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

// SP-02: an empty folder is a folder the user configured. It renders as empty,
// not as a failure and not as a missing key.
func TestStartPageEmptySourceReturnsAnEmptyArray(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	code, out := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes", f.session,
		map[string]any{"type": "folder", "title": "Nothing yet", "url": "",
			"parent": map[string]string{"type": "root", "key": "main"}})
	if code != http.StatusCreated {
		t.Fatalf("create folder = %d %v", code, out)
	}
	empty := out["id"].(string)

	if code, out := f.authorize(f.deviceID, empty); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}
	code, _, body := f.deviceSnapshot()
	if code != http.StatusOK {
		t.Fatalf("snapshot = %d %s", code, body)
	}
	// The absence of a key and an empty list are different answers to a
	// client that has to tell "empty folder" from "unreadable response".
	if !strings.Contains(body, `"nodes":[]`) {
		t.Fatalf("body = %s, want an empty array rather than null", body)
	}
}

// SP-09: a folder id on the request is not how a device names its source, and
// another account's ids resolve to nothing at all.
func TestStartPageDeviceSnapshotIgnoresWhatTheRequestAsksFor(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	if code, out := f.authorize(f.deviceID, f.entries); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}

	// The grant names Entries; the query trying to reach a different folder
	// has to be read as noise, not as a target.
	code, _, body := getRaw(t, f.ts.URL+"/api/v1/device/start-page/snapshot?space_id=other&folder_id="+f.daily, f.device)
	if code != http.StatusOK {
		t.Fatalf("snapshot with forged params = %d %s", code, body)
	}
	if ids := nodeIDs(t, body); !containsID(ids, f.github) {
		t.Fatalf("forged parameters moved the source: %v", ids)
	}

	code, out := f.authorizeWith(f.bobSession, f.deviceID, f.spaceID, f.entries)
	if code != http.StatusNotFound || errCode(t, out) != "START_PAGE_PERMISSION_REQUIRED" {
		t.Fatalf("bob authorizing alice's device = %d %v", code, out)
	}
	_, bobSpace := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", f.bobSession, map[string]string{"name": "Bob"})
	if id, ok := bobSpace["id"].(string); ok {
		// Bob owns a space now. Pointing alice's device at it still resolves
		// to nothing: the device is not his to configure.
		code, out = f.authorizeWith(f.bobSession, f.deviceID, id, f.entries)
		if code != http.StatusNotFound {
			t.Fatalf("cross-account grant = %d %v", code, out)
		}
	}
}

func TestStartPageSourceMustBeAFolder(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, out := f.authorize(f.deviceID, f.github)
	if code != http.StatusNotFound || errCode(t, out) != "START_PAGE_SOURCE_UNAVAILABLE" {
		t.Fatalf("bookmark source = %d %v", code, out)
	}
	// Refusing must not leave a half-approved source behind.
	if _, res := doJSON(t, "GET", f.ts.URL+"/api/v1/device/start-page", f.device, nil); res["error"] == nil {
		t.Fatal("a bookmark became the device's source")
	}
}

// SP-05/SP-06: the grant follows the folder it names — not its title, and not
// another folder that happens to appear with the same one.
func TestStartPageSourceIdentity(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	if code, out := f.authorize(f.deviceID, f.entries); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}

	code, out := doJSON(t, "PATCH", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+f.entries, f.session,
		map[string]any{"title": "Everyday entries"})
	if code != http.StatusOK {
		t.Fatalf("rename = %d %v", code, out)
	}
	body := f.mustDeviceSnapshot()
	src := snapshotBody(t, body)["source"].(map[string]any)
	if src["folder_title"] != "Everyday entries" {
		t.Fatalf("source = %v, the name did not follow the node", src)
	}

	code, _ = doJSON(t, "DELETE", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+f.entries, f.session, nil)
	if code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	// A folder with the old title now exists where the old one was. It is a
	// different node, so the source is unavailable, not re-bound (§5.2).
	if _, out := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes", f.session,
		map[string]any{"type": "folder", "title": "Everyday entries", "url": "",
			"parent": map[string]string{"type": "root", "key": "main"}}); out["error"] != nil {
		t.Fatalf("create the look-alike: %v", out)
	}

	code, body2 := doJSON(t, "GET", f.ts.URL+"/api/v1/device/start-page/snapshot", f.device, nil)
	if code != http.StatusNotFound || errCode(t, body2) != "START_PAGE_SOURCE_UNAVAILABLE" {
		t.Fatalf("after deletion = %d %v, must not claim the same-named folder", code, body2)
	}
	// No fallback to the space either: the page cannot decide to show
	// everything because the one folder it was allowed to show is gone.
	_, body3 := doJSON(t, "GET", f.ts.URL+"/api/v1/device/start-page", f.device, nil)
	if errCode(t, body3) != "START_PAGE_SOURCE_UNAVAILABLE" {
		t.Fatalf("source description = %v", body3)
	}
}

// SP-07's server half: the source follows its node when the node is moved
// inside the same space, and the subtree that comes back is the folder's own.
func TestStartPageSurvivesAMoveInsideTheSpace(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	if code, out := f.authorize(f.deviceID, f.daily); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}
	if code, out := doJSON(t, "PATCH", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+f.daily+"/move", f.session,
		map[string]any{"parent": map[string]string{"type": "root", "key": "main"}}); code != http.StatusOK {
		t.Fatalf("move = %d %v", code, out)
	}
	body := f.mustDeviceSnapshot()
	// Daily still holds exactly MDN and Deep. The folder it used to sit in is
	// above the source and stays out; Entries' own bookmark did not follow.
	ids := nodeIDs(t, body)
	if len(ids) != 2 || !containsID(ids, f.mdn) || !containsID(ids, f.deep) {
		t.Fatalf("nodes after the move = %v, want MDN and Deep", ids)
	}
}

func TestStartPageChangingSourceBumpsTheVersion(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	if code, out := f.authorize(f.deviceID, f.entries); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}
	// Re-approving the same folder is not a change: a client that saves the
	// form twice must not be told its cache went stale.
	code, out := f.authorize(f.deviceID, f.entries)
	if code != http.StatusOK || out["grant_version"] != float64(1) {
		t.Fatalf("re-approve = %d %v", code, out)
	}

	_, first, _ := f.deviceSnapshot()
	if code, out := f.authorize(f.deviceID, f.daily); code != http.StatusOK || out["grant_version"] != float64(2) {
		t.Fatalf("move source = %d %v", code, out)
	}
	code, header, body := f.deviceSnapshot()
	if code != http.StatusOK {
		t.Fatalf("snapshot after move = %d %s", code, body)
	}
	if header.Get("ETag") == first.Get("ETag") {
		t.Fatal("a different source produced the same ETag")
	}
	if ids := nodeIDs(t, body); len(ids) != 2 || containsID(ids, f.github) {
		t.Fatalf("nodes after moving the source = %v", ids)
	}
}

// SP-14: the conditional response is the one place the server could answer
// without reading anything, so it is where a revocation would be missed.
func TestStartPageConditionalRequestStillChecksTheGrant(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	if code, out := f.authorize(f.deviceID, f.entries); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}
	code, header, _ := f.deviceSnapshot()
	if code != http.StatusOK {
		t.Fatalf("snapshot = %d", code)
	}
	etag := header.Get("ETag")

	conditional := map[string]string{
		"Authorization": "Bearer " + f.deviceToken,
		"If-None-Match": etag,
	}
	code, _, body := getRaw(t, f.ts.URL+"/api/v1/device/start-page/snapshot", conditional)
	if code != http.StatusNotModified || body != "" {
		t.Fatalf("unchanged read = %d %q, want 304 with no body", code, body)
	}

	// Same tree, same tag, no longer any authority to read it.
	if code, _ := doJSON(t, "DELETE", f.ts.URL+"/api/v1/start-page-grants/"+f.grantID(), f.session, nil); code != http.StatusNoContent {
		t.Fatalf("revoke = %d", code)
	}
	code, _, body = getRaw(t, f.ts.URL+"/api/v1/device/start-page/snapshot", conditional)
	if code == http.StatusNotModified {
		t.Fatal("a revoked grant got 304: the client would keep showing private bookmarks off a cache hit")
	}
	if code != http.StatusNotFound || !strings.Contains(body, "START_PAGE_NOT_CONFIGURED") {
		t.Fatalf("after revoke = %d %s", code, body)
	}
}

// SP-08: choosing a display source must not subscribe the device to anything.
func TestStartPageGrantCreatesNoBinding(t *testing.T) {
	f := bootstrapStartPageFlow(t)

	code, out := doJSON(t, "POST", f.ts.URL+"/api/v1/devices", f.session,
		map[string]any{"name": "Chrome@Laptop", "browser": "chrome", "platform": "macos"})
	if code != http.StatusCreated {
		t.Fatalf("register device = %d %v", code, out)
	}
	token, _ := out["token"].(string)
	// The account's device list grows by one; find it by name rather than
	// assuming the overview keeps any particular order.
	laptopID := ""
	_, overview := doJSON(t, "GET", f.ts.URL+"/api/v1/devices/overview", f.session, nil)
	for _, d := range overview["devices"].([]any) {
		row := d.(map[string]any)
		if row["name"] == "Chrome@Laptop" {
			laptopID = row["id"].(string)
		}
	}
	if laptopID == "" {
		t.Fatalf("the new device is not in the overview: %v", overview)
	}
	if f.bindingsOf(laptopID) != 0 {
		t.Fatalf("a freshly registered device already binds a space")
	}

	if code, out := f.authorize(laptopID, f.entries); code != http.StatusOK {
		t.Fatalf("authorize the unbound device = %d %v", code, out)
	}

	// It can read its source without ever having synced.
	code, _, body := getRaw(t, f.ts.URL+"/api/v1/device/start-page/snapshot",
		map[string]string{"Authorization": "Bearer " + token})
	if code != http.StatusOK {
		t.Fatalf("snapshot on an unbound device = %d %s", code, body)
	}
	if !containsID(nodeIDs(t, body), f.github) {
		t.Fatalf("nodes = %v", nodeIDs(t, body))
	}
	// And reading it still has not bound anything (§5.3).
	if got := f.bindingsOf(laptopID); got != 0 {
		t.Fatalf("the start-page source created %d bindings", got)
	}
}

// The web page is a signed-in account reading its own tree: ownership is the
// boundary there, and no device grant is involved (§13.1).
func TestWebStartPageSnapshotUsesSessionOwnership(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	url := f.ts.URL + "/api/v1/start-page/snapshot?space_id=" + f.spaceID + "&folder_id=" + f.entries

	code, _, body := getRaw(t, url, f.session)
	if code != http.StatusOK {
		t.Fatalf("owner read = %d %s", code, body)
	}
	if !containsID(nodeIDs(t, body), f.daily) {
		t.Fatalf("nodes = %v", nodeIDs(t, body))
	}

	// A different account asking for the same ids gets the refusal it would
	// get for ids it invented: the response never says which one it was.
	code, _, body = getRaw(t, url, f.bobSession)
	if code != http.StatusNotFound {
		t.Fatalf("cross-account web read = %d %s", code, body)
	}
	if errCode(t, snapshotMap(t, body)) != "START_PAGE_PERMISSION_REQUIRED" {
		t.Fatalf("cross-account code = %s", errCode(t, snapshotMap(t, body)))
	}

	// A browser that has not chosen a source yet is told so, rather than
	// being served some folder the server guessed for it (§15).
	code, _, body = getRaw(t, f.ts.URL+"/api/v1/start-page/snapshot", f.session)
	if code != http.StatusBadRequest || !strings.Contains(body, "START_PAGE_NOT_CONFIGURED") {
		t.Fatalf("unconfigured web read = %d %s", code, body)
	}
}

func snapshotMap(t *testing.T, body string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode: %v\n%s", err, body)
	}
	return out
}

func TestWebStartPageSnapshotNeedsNoDevice(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	// A session read carries no grant, so the grant fields stay empty rather
	// than naming a device the browser never paired.
	code, out := f.authorize(f.deviceID, f.entries)
	if code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}
	body := f.mustDeviceSnapshot()
	if v := snapshotBody(t, body)["source"].(map[string]any)["grant_id"]; v == "" || v == nil {
		t.Fatalf("device snapshot lost its grant id: %v", v)
	}

	url := f.ts.URL + "/api/v1/start-page/snapshot?space_id=" + f.spaceID + "&folder_id=" + f.entries
	_, _, webBody := getRaw(t, url, f.session)
	src := snapshotBody(t, webBody)["source"].(map[string]any)
	if src["grant_id"] != "" {
		t.Fatalf("a session read invented a grant: %v", src)
	}
	if src["folder_id"] != f.entries || src["space_id"] != f.spaceID {
		t.Fatalf("source = %v", src)
	}
}

func TestStartPageGrantListingAndRevocation(t *testing.T) {
	f := bootstrapStartPageFlow(t)
	if code, out := f.authorize(f.deviceID, f.entries); code != http.StatusOK {
		t.Fatalf("authorize = %d %v", code, out)
	}

	code, out := doJSON(t, "GET", f.ts.URL+"/api/v1/start-page-grants", f.session, nil)
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, out)
	}
	grants, _ := out["grants"].([]any)
	if len(grants) != 1 {
		t.Fatalf("grants = %v", grants)
	}
	row := grants[0].(map[string]any)
	if row["device_id"] != f.deviceID || row["space_name"] != "Personal" {
		t.Fatalf("grant row = %v", row)
	}
	// The settings page lists sources by name; a row that only carries ids
	// would ask the client to read a tree it was never granted.
	if row["folder_title"] != "Entries" {
		t.Fatalf("grant row has no folder name: %v", row)
	}

	id := row["grant_id"].(string)
	// Someone else's account cannot revoke it, and the refusal is the same as
	// for an id that never existed.
	if code, _ := doJSON(t, "DELETE", f.ts.URL+"/api/v1/start-page-grants/"+id, f.bobSession, nil); code != http.StatusNotFound {
		t.Fatalf("bob revoking = %d", code)
	}
	if code, _ := doJSON(t, "DELETE", f.ts.URL+"/api/v1/start-page-grants/"+id, f.session, nil); code != http.StatusNoContent {
		t.Fatalf("revoke = %d", code)
	}
	if code, _ := doJSON(t, "DELETE", f.ts.URL+"/api/v1/start-page-grants/"+id, f.session, nil); code != http.StatusNotFound {
		t.Fatalf("second revoke = %d", code)
	}
	// Revoking the display authorization changes nothing about sync: the
	// device keeps the binding it already had (§5.3).
	if got := f.bindingsOf(f.deviceID); got == 0 {
		t.Fatal("the fixture device lost its binding, so this test proved nothing")
	}
}
