package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func getSystemStatus(t *testing.T, ts *httptest.Server) map[string]any {
	t.Helper()
	code, body := doJSON(t, "GET", ts.URL+"/api/v1/system/status", nil, nil)
	if code != http.StatusOK {
		t.Fatalf("system status = %d %v", code, body)
	}
	return body
}

func statusBool(t *testing.T, body map[string]any, key string) bool {
	t.Helper()
	v, ok := body[key].(bool)
	if !ok {
		t.Fatalf("system status %q = %#v, want bool (body %v)", key, body[key], body)
	}
	return v
}

func openRegistration(t *testing.T, srv *Server) {
	t.Helper()
	if err := srv.Accounts.UpsertSettings(context.Background(),
		map[string]string{"registration_mode": "open"}, time.Now().UTC()); err != nil {
		t.Fatalf("open registration: %v", err)
	}
}

func setupAdmin(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/setup", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusCreated {
		t.Fatalf("setup = %d %v", code, body)
	}
	return sessionTokenOf(t, ts, "alice")
}

func sessionTokenOf(t *testing.T, ts *httptest.Server, username string) string {
	t.Helper()
	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": username, "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("login as %s = %d %v", username, code, body)
	}
	token, _ := body["token"].(string)
	if token == "" {
		t.Fatalf("login as %s returned no token: %v", username, body)
	}
	return token
}

// TestSystemStatusIsPublicBeforeSetup is the case the login page depends on:
// with no session and no admin, /system/status still answers, and it says the
// instance needs setup rather than 401ing like /settings does.
func TestSystemStatusIsPublicBeforeSetup(t *testing.T) {
	_, ts := newTestServer(t)

	body := getSystemStatus(t, ts)
	if statusBool(t, body, "initialized") {
		t.Fatalf("empty instance reported initialized: %v", body)
	}
	if body["registration_mode"] != "closed" {
		t.Fatalf("registration_mode = %v, want closed", body["registration_mode"])
	}
	if statusBool(t, body, "allow_registration") {
		t.Fatalf("uninitialized instance offered registration: %v", body)
	}
}

func TestSystemStatusFollowsSetupAndMode(t *testing.T) {
	_, ts := newTestServer(t)
	setupAdmin(t, ts)

	body := getSystemStatus(t, ts)
	if !statusBool(t, body, "initialized") {
		t.Fatalf("after setup still reports uninitialized: %v", body)
	}
	if statusBool(t, body, "allow_registration") {
		t.Fatalf("closed instance offered registration: %v", body)
	}

	// The gate follows the operator's setting, not a deploy flag.
	admin := map[string]string{"Authorization": "Bearer " + sessionTokenOf(t, ts, "alice")}
	if code, body := doJSON(t, "PATCH", ts.URL+"/api/v1/settings", admin,
		map[string]any{"registration_mode": "open"}); code != http.StatusOK {
		t.Fatalf("open registration = %d %v", code, body)
	}
	if !statusBool(t, getSystemStatus(t, ts), "allow_registration") {
		t.Fatalf("open instance did not offer registration")
	}
}

// TestRegisterRefusesUninitializedInstance guards the role side effect:
// auth.Service makes the first account of an instance an admin, so registration
// must never be the path that creates it — even if registration_mode somehow
// reads `open` on an instance nobody has bootstrapped.
func TestRegisterRefusesUninitializedInstance(t *testing.T) {
	srv, ts := newTestServer(t)
	openRegistration(t, srv)

	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/register", nil,
		map[string]string{"username": "mallory", "password": "password123"})
	if code != http.StatusConflict || errCode(t, body) != "NOT_INITIALIZED" {
		t.Fatalf("register on empty instance = %d %v", code, body)
	}
	// Nothing was created, so no admin was handed out to whoever got there first.
	if code, _ := doJSON(t, "POST", ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "mallory", "password": "password123"}); code != http.StatusUnauthorized {
		t.Fatalf("login as refused registrant = %d, want 401", code)
	}
}

func TestRegisterClosedMode(t *testing.T) {
	_, ts := newTestServer(t)
	setupAdmin(t, ts)

	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/register", nil,
		map[string]string{"username": "bob", "password": "password123"})
	if code != http.StatusForbidden || errCode(t, body) != "REGISTRATION_CLOSED" {
		t.Fatalf("register while closed = %d %v", code, body)
	}
	if code, _ := doJSON(t, "POST", ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "bob", "password": "password123"}); code != http.StatusUnauthorized {
		t.Fatalf("login as refused registrant = %d, want 401", code)
	}
}

// TestRegisterCreatesUserWithDefaultSpace covers the whole promise of doc 09 §4:
// a role=user account, on an instance that already has an admin, that lands on
// one ordinary Space instead of an empty list.
func TestRegisterCreatesUserWithDefaultSpace(t *testing.T) {
	srv, ts := newTestServer(t)
	setupAdmin(t, ts)
	openRegistration(t, srv)

	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/register", nil, map[string]string{
		"username": "bob", "password": "password123", "display_name": "Bob", "email": "bob@example.com",
	})
	if code != http.StatusCreated {
		t.Fatalf("register = %d %v", code, body)
	}
	if body["role"] != "user" {
		t.Fatalf("registered account role = %v, want user", body["role"])
	}
	if body["username"] != "bob" || body["display_name"] != "Bob" {
		t.Fatalf("registered account = %v", body)
	}

	// The new account can sign in, and its first screen has a Space in it.
	token := sessionTokenOf(t, ts, "bob")
	code, spaces := doJSON(t, "GET", ts.URL+"/api/v1/spaces",
		map[string]string{"Authorization": "Bearer " + token}, nil)
	if code != http.StatusOK {
		t.Fatalf("list spaces as bob = %d %v", code, spaces)
	}
	list, _ := spaces["spaces"].([]any)
	if len(list) != 1 {
		t.Fatalf("bob's spaces = %v, want exactly the default one", spaces)
	}
	spaceID := list[0].(map[string]any)["id"].(string)
	if list[0].(map[string]any)["name"] != defaultSpaceName {
		t.Fatalf("default space name = %v, want %q", list[0], defaultSpaceName)
	}

	// The account points at it, so a client does not have to guess which Space
	// a registered user started with.
	u, err := srv.Auth.UserByID(context.Background(), body["id"].(string))
	if err != nil {
		t.Fatalf("reload registered user: %v", err)
	}
	if string(u.DefaultSpaceID) != spaceID {
		t.Fatalf("default_space_id = %q, want %q", u.DefaultSpaceID, spaceID)
	}
}

func TestRegisterValidationAndDuplicates(t *testing.T) {
	srv, ts := newTestServer(t)
	setupAdmin(t, ts)
	openRegistration(t, srv)

	code, body := doJSON(t, "POST", ts.URL+"/api/v1/auth/register", nil,
		map[string]string{"username": "bob", "password": "short"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_PASSWORD" {
		t.Fatalf("weak password = %d %v", code, body)
	}

	// Case-insensitive collision with the admin's name.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/auth/register", nil,
		map[string]string{"username": "ALICE", "password": "password123"})
	if code != http.StatusConflict || errCode(t, body) != "USERNAME_TAKEN" {
		t.Fatalf("duplicate username = %d %v", code, body)
	}

	// A role in the body is refused by the strict decoder: registration cannot
	// ask for one.
	code, body = doJSON(t, "POST", ts.URL+"/api/v1/auth/register", nil,
		map[string]any{"username": "carol", "password": "password123", "role": "admin"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_JSON" {
		t.Fatalf("role in the body = %d %v, want the decoder to refuse it", code, body)
	}
}
