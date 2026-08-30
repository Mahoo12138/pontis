package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pontis/internal/auth"
	"pontis/internal/backup"
	"pontis/internal/device"
	"pontis/internal/jobs"
	"pontis/internal/library"
	"pontis/internal/organizer"
	"pontis/internal/plaza"
	"pontis/internal/schedule"
	"pontis/internal/transfer"
	"pontis/internal/space"
	"pontis/internal/store/sqlite"
	"pontis/internal/sync"
	"pontis/internal/token"
)

func newTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	db, err := sqlite.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := sqlite.Migrate(context.Background(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	instanceID, err := sqlite.InstanceID(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	backupSvc, err := backup.NewService(sqlite.NewBackupStore(db), sqlite.NewLibraryStore(db),
		filepath.Join(t.TempDir(), "backups"))
	if err != nil {
		t.Fatalf("backup service: %v", err)
	}

	// The schedule service shares the job service so run-now and the tick
	// loop can enqueue real jobs (same wiring as the app composition root).
	jobSvc := jobs.NewService(sqlite.NewJobStore(db), 1)

	srv := &Server{
		Auth:       auth.NewService(sqlite.NewAuthStore(db), 24*time.Hour),
		Devices:    device.NewService(sqlite.NewDeviceStore(db)),
		Spaces:     space.NewService(sqlite.NewSpaceStore(db)),
		Sync:       sync.NewService(sqlite.NewSyncStore(db)),
		Library:    library.NewService(sqlite.NewLibraryStore(db), sqlite.NewStore(db)),
		Tokens:     token.NewService(sqlite.NewTokenStore(db)),
		Organizer:  organizer.NewService(sqlite.NewLibraryStore(db)),
		Transfer:  transfer.NewService(sqlite.NewLibraryStore(db), sqlite.NewStore(db)),
		Plaza:      plaza.NewService(sqlite.NewPublicationStore(db), library.NewService(sqlite.NewLibraryStore(db), sqlite.NewStore(db)), sqlite.NewStore(db)),
		Backups:    backupSvc,
		Accounts:   sqlite.NewAccountStore(db),
		Jobs:       jobSvc,
		Schedules:  schedule.NewService(sqlite.NewScheduleStore(db), jobSvc),
		InstanceID: instanceID,
		Logger:     slog.New(slog.DiscardHandler),
	}
	ts := httptest.NewServer(srv.Router())
	t.Cleanup(ts.Close)
	return srv, ts
}

func doJSON(t *testing.T, method, url string, headers map[string]string, body any) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req, err := http.NewRequest(method, url, &buf)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp.StatusCode, out
}

func errCode(t *testing.T, body map[string]any) string {
	t.Helper()
	e, ok := body["error"].(map[string]any)
	if !ok {
		t.Fatalf("no error envelope in %v", body)
	}
	code, _ := e["code"].(string)
	return code
}

// fullFlow wires a bootstrapped instance: admin user, session token, one
// space, one registered device (with secret) bound to the space.
type flowState struct {
	ts           *httptest.Server
	srv          *Server
	sessionToken string
	spaceID      string
	deviceToken  string
	bindingID    string
}

func bootstrapFlow(t *testing.T) *flowState {
	t.Helper()
	srv, ts := newTestServer(t)
	st := &flowState{ts: ts, srv: srv}

	// First setup.
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/setup", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusCreated {
		t.Fatalf("setup status = %d body = %v", code, body)
	}

	// Second setup is permanently disabled.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/auth/setup", nil,
		map[string]string{"username": "eve", "password": "password123"})
	if code != http.StatusConflict || errCode(t, body) != "ALREADY_INITIALIZED" {
		t.Fatalf("second setup = %d %v", code, body)
	}

	// Login.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("login status = %d body = %v", code, body)
	}
	st.sessionToken, _ = body["token"].(string)

	// Create space.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/spaces",
		map[string]string{"Authorization": "Bearer " + st.sessionToken},
		map[string]string{"name": "Personal"})
	if code != http.StatusCreated {
		t.Fatalf("create space = %d %v", code, body)
	}
	st.spaceID, _ = body["id"].(string)

	// Register device; secret returns exactly once.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/devices",
		map[string]string{"Authorization": "Bearer " + st.sessionToken},
		map[string]string{"name": "Edge@Home", "browser": "edge", "platform": "windows"})
	if code != http.StatusCreated {
		t.Fatalf("register device = %d %v", code, body)
	}
	st.deviceToken, _ = body["token"].(string)

	// Device binds the space.
	deviceAuth := map[string]string{"Authorization": "Bearer " + st.deviceToken}
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/device/bindings", deviceAuth,
		map[string]string{"space_id": st.spaceID})
	if code != http.StatusCreated {
		t.Fatalf("bind space = %d %v", code, body)
	}
	st.bindingID, _ = body["id"].(string)

	// Initial sync verification is out of scope here; activate directly.
	if err := srv.Devices.ActivateBinding(context.Background(), st.bindingID); err != nil {
		t.Fatalf("activate binding: %v", err)
	}
	return st
}

func TestMeta(t *testing.T) {
	_, ts := newTestServer(t)
	code, body := doJSON(t, "GET", ts.URL+"/api/v1/meta", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("meta status = %d", code)
	}
	if body["instance_id"] == "" || body["instance_id"] == nil {
		t.Error("instance_id missing")
	}
	versions, _ := body["sync_protocol_versions"].([]any)
	if len(versions) != 1 || versions[0].(float64) != 1 {
		t.Errorf("sync protocol versions = %v", versions)
	}
}

func TestSetupLoginDeviceBindingSyncFlow(t *testing.T) {
	st := bootstrapFlow(t)
	deviceAuth := map[string]string{"Authorization": "Bearer " + st.deviceToken}

	// Device space catalog.
	code, body := doJSON(t, "GET", st.ts.URL+"/api/v1/device/spaces", deviceAuth, nil)
	if code != http.StatusOK {
		t.Fatalf("device spaces = %d %v", code, body)
	}
	spaces, _ := body["spaces"].([]any)
	if len(spaces) != 1 {
		t.Fatalf("device spaces = %v", spaces)
	}

	// List bindings.
	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/device/bindings", deviceAuth, nil)
	if code != http.StatusOK {
		t.Fatalf("list bindings = %d %v", code, body)
	}
	bindings, _ := body["bindings"].([]any)
	if len(bindings) != 1 {
		t.Fatalf("bindings = %v", bindings)
	}

	// Sync: create one folder under the main root slot.
	syncBody := map[string]any{
		"protocol_version":  1,
		"epoch":             1,
		"applied_revision":  0,
		"received_revision": 0,
		"max_changes":       500,
		"operations": []map[string]any{{
			"op_id":         "op-1",
			"client_seq":    1,
			"base_revision": 0,
			"type":          "create",
			"node_id":       "11111111-1111-7111-8111-111111111111",
			"node_type":     "folder",
			"title":         "Development",
			"parent":        map[string]string{"type": "root", "key": "main"},
		}},
	}
	code, body = doJSON(t, "POST",
		st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID, deviceAuth, syncBody)
	if code != http.StatusOK {
		t.Fatalf("sync = %d %v", code, body)
	}

	results, _ := body["operation_results"].([]any)
	if len(results) != 1 {
		t.Fatalf("operation_results = %v", body)
	}
	res := results[0].(map[string]any)
	if res["status"] != "APPLIED" {
		t.Errorf("op status = %v, want APPLIED", res["status"])
	}
	if body["server_revision"].(float64) != 1 {
		t.Errorf("server_revision = %v", body["server_revision"])
	}

	// Client's own change flows back in the stream.
	changes, _ := body["changes"].([]any)
	if len(changes) != 1 || changes[0].(map[string]any)["type"] != "create" {
		t.Errorf("changes = %v", changes)
	}
}

func TestSyncProtocolErrorEnvelope(t *testing.T) {
	st := bootstrapFlow(t)
	deviceAuth := map[string]string{"Authorization": "Bearer " + st.deviceToken}

	// Wrong epoch -> 409 EPOCH_MISMATCH in the unified envelope.
	syncBody := map[string]any{
		"protocol_version":  1,
		"epoch":             2,
		"applied_revision":  0,
		"received_revision": 0,
	}
	code, body := doJSON(t, "POST",
		st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID, deviceAuth, syncBody)
	if code != http.StatusConflict || errCode(t, body) != "EPOCH_MISMATCH" {
		t.Fatalf("epoch mismatch = %d %v", code, body)
	}

	// Unknown protocol version -> 400.
	syncBody["epoch"] = 1
	syncBody["protocol_version"] = 99
	code, body = doJSON(t, "POST",
		st.ts.URL+"/api/v1/sync/bindings/"+st.bindingID, deviceAuth, syncBody)
	if code != http.StatusBadRequest || errCode(t, body) != "SYNC_PROTOCOL_UNSUPPORTED" {
		t.Fatalf("protocol version = %d %v", code, body)
	}
}

func TestSyncBindingOwnershipEnforced(t *testing.T) {
	st := bootstrapFlow(t)
	ts := st.ts

	// Register a second device on the same instance via the admin session.
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/devices",
		map[string]string{"Authorization": "Bearer " + st.sessionToken},
		map[string]string{"name": "Firefox@Home", "browser": "firefox"})
	if code != http.StatusCreated {
		t.Fatalf("register device 2 = %d %v", code, body)
	}
	otherToken, _ := body["token"].(string)

	syncBody := map[string]any{
		"protocol_version":  1,
		"epoch":             1,
		"applied_revision":  0,
		"received_revision": 0,
	}
	code, body = doJSON(t, "POST",
		ts.URL+"/api/v1/sync/bindings/"+st.bindingID,
		map[string]string{"Authorization": "Bearer " + otherToken}, syncBody)
	if code != http.StatusForbidden || errCode(t, body) != "NOT_BINDING_OWNER" {
		t.Fatalf("foreign binding sync = %d %v", code, body)
	}

	// Unknown binding id -> 404.
	code, body = doJSON(t, "POST",
		ts.URL+"/api/v1/sync/bindings/00000000-0000-7000-8000-000000000000",
		map[string]string{"Authorization": "Bearer " + otherToken}, syncBody)
	if code != http.StatusNotFound || errCode(t, body) != "BINDING_NOT_FOUND" {
		t.Fatalf("unknown binding = %d %v", code, body)
	}
}

func TestSessionAuthRequired(t *testing.T) {
	_, ts := newTestServer(t)

	// No session: spaces requires auth.
	code, body := doJSON(t, "GET", ts.URL+"/api/v1/spaces", nil, nil)
	if code != http.StatusUnauthorized || errCode(t, body) != "UNAUTHENTICATED" {
		t.Fatalf("unauthenticated spaces = %d %v", code, body)
	}

	// Bogus bearer token.
	code, body = doJSON(t, "GET", ts.URL+"/api/v1/auth/me",
		map[string]string{"Authorization": "Bearer bogus"}, nil)
	if code != http.StatusUnauthorized || errCode(t, body) != "SESSION_INVALID" {
		t.Fatalf("bogus session = %d %v", code, body)
	}

	// Device credential is not accepted as a session.
	st := bootstrapFlow(t)
	code, body = doJSON(t, "GET", st.ts.URL+"/api/v1/auth/me",
		map[string]string{"Authorization": "Bearer " + st.deviceToken}, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("device token as session = %d %v", code, body)
	}
}

func TestLoginWrongPassword(t *testing.T) {
	st := bootstrapFlow(t)
	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "alice", "password": "wrong-password"})
	if code != http.StatusUnauthorized || errCode(t, body) != "INVALID_CREDENTIALS" {
		t.Fatalf("wrong password = %d %v", code, body)
	}
}

func TestUnknownFieldRejected(t *testing.T) {
	st := bootstrapFlow(t)
	// DisallowUnknownFields guards against wire schema drift.
	req := strings.NewReader(`{"username":"alice","password":"password123","extra":1}`)
	resp, err := http.Post(st.ts.URL+"/api/v1/auth/login", "application/json", req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown field status = %d, want 400", resp.StatusCode)
	}
}

func TestSpaceValidation(t *testing.T) {
	st := bootstrapFlow(t)
	authz := map[string]string{"Authorization": "Bearer " + st.sessionToken}

	code, body := doJSON(t, "POST", st.ts.URL+"/api/v1/spaces", authz,
		map[string]string{"name": ""})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_NAME" {
		t.Fatalf("empty name = %d %v", code, body)
	}

	// Create up to the limit: bootstrap created 1 space, 15 more reach 16.
	for i := 0; i < 15; i++ {
		code, _ = doJSON(t, "POST", st.ts.URL+"/api/v1/spaces", authz,
			map[string]string{"name": fmt.Sprintf("Space %d", i+2)})
		if code != http.StatusCreated {
			t.Fatalf("space %d status = %d", i+2, code)
		}
	}
	code, body = doJSON(t, "POST", st.ts.URL+"/api/v1/spaces", authz,
		map[string]string{"name": "One too many"})
	if code != http.StatusConflict || errCode(t, body) != "TOO_MANY_SPACES" {
		t.Fatalf("limit = %d %v", code, body)
	}
}
