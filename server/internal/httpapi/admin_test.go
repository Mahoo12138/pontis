package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestAdminUserManagement(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	adminHeader := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bobHeader := map[string]string{"Authorization": "Bearer " + f.bobToken}

	// Bob (plain user) cannot list or mutate.
	code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/admin/users", bobHeader, nil)
	if code != http.StatusForbidden || errCode(t, body) != "ADMIN_REQUIRED" {
		t.Fatalf("bob list = %d %v", code, body)
	}

	// Admin lists both users with stats.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/admin/users", adminHeader, nil)
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, body)
	}
	users := body["users"].([]any)
	if len(users) != 2 {
		t.Fatalf("expected 2 users, got %d", len(users))
	}
	var bobID string
	for _, u := range users {
		m := u.(map[string]any)
		if m["username"] == "bob" {
			bobID = m["id"].(string)
			if m["role"] != "user" || m["status"] != "active" {
				t.Fatalf("bob row wrong: %v", m)
			}
		}
	}
	if bobID == "" {
		t.Fatalf("bob missing from list")
	}

	// Self-mutation is refused.
	_, me := doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", adminHeader, nil)
	selfID := me["id"].(string)
	code, body = doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+selfID, adminHeader,
		map[string]any{"status": "disabled"})
	if code != http.StatusConflict || errCode(t, body) != "SELF_MUTATION" {
		t.Fatalf("self disable = %d %v", code, body)
	}

	// Disable bob: his session dies immediately.
	code, _ = doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+bobID, adminHeader,
		map[string]any{"status": "disabled"})
	if code != http.StatusOK {
		t.Fatalf("disable bob = %d", code)
	}
	code, _ = doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", bobHeader, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("disabled bob session still valid: %d", code)
	}

	// Promote bob; role persists.
	code, body = doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+bobID, adminHeader,
		map[string]any{"role": "admin"})
	if code != http.StatusOK || body["role"] != "admin" {
		t.Fatalf("promote = %d %v", code, body)
	}

	// A disabled account cannot log in at all.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "bob", "password": "password123"})
	if code != http.StatusUnauthorized || errCode(t, body) != "ACCOUNT_DISABLED" {
		t.Fatalf("disabled login = %d %v", code, body)
	}

	// Re-enable bob before the reset flow.
	code, _ = doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+bobID, adminHeader,
		map[string]any{"status": "active"})
	if code != http.StatusOK {
		t.Fatalf("enable bob = %d", code)
	}

	// Reset link: create, then consume via the public reset endpoint.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users/"+bobID+"/reset-link", adminHeader, nil)
	if code != http.StatusCreated {
		t.Fatalf("reset link = %d %v", code, body)
	}
	link := body["reset_link"].(string)
	idx := strings.Index(link, "token=")
	if idx < 0 {
		t.Fatalf("reset link missing token: %s", link)
	}
	raw := link[idx+len("token="):]

	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/auth/reset", nil,
		map[string]string{"token": raw, "new_password": "bob-new-pass-1"})
	if code != http.StatusOK {
		t.Fatalf("reset = %d %v", code, body)
	}

	// The token is single-use.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/auth/reset", nil,
		map[string]string{"token": raw, "new_password": "bob-new-pass-2"})
	if code != http.StatusForbidden || errCode(t, body) != "RESET_TOKEN_INVALID" {
		t.Fatalf("token reuse = %d %v", code, body)
	}

	// Bob logs in with the new password.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "bob", "password": "bob-new-pass-1"})
	if code != http.StatusOK {
		t.Fatalf("login with new password = %d %v", code, body)
	}
}

func TestAdminCreateUser(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	admin := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bob := map[string]string{"Authorization": "Bearer " + f.bobToken}

	// Creating accounts is admin-only, and it does not depend on
	// registration_mode — this is the path a closed instance still has.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users", bob,
		map[string]string{"username": "mallory", "password": "password123"})
	if code != http.StatusForbidden || errCode(t, body) != "ADMIN_REQUIRED" {
		t.Fatalf("bob creates = %d %v", code, body)
	}

	// The body is the register/setup body: a requested role is refused rather
	// than silently ignored, so creation can never grant admin.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users", admin,
		map[string]string{"username": "carol", "password": "password123", "role": "admin"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_JSON" {
		t.Fatalf("role at creation = %d %v", code, body)
	}

	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users", admin,
		map[string]string{"username": "carol", "password": "password123", "display_name": "Carol"})
	if code != http.StatusCreated {
		t.Fatalf("create carol = %d %v", code, body)
	}
	if body["role"] != "user" || body["status"] != "active" || body["id"] == "" {
		t.Fatalf("carol = %v", body)
	}

	// Same validation as registration: taken username, bad username, weak password.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users", admin,
		map[string]string{"username": "carol", "password": "password123"})
	if code != http.StatusConflict || errCode(t, body) != "USERNAME_TAKEN" {
		t.Fatalf("duplicate username = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users", admin,
		map[string]string{"username": "ab!", "password": "password123"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_USERNAME" {
		t.Fatalf("bad username = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users", admin,
		map[string]string{"username": "dave", "password": "short"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_PASSWORD" {
		t.Fatalf("short password = %d %v", code, body)
	}

	// The account is immediately usable, and opens with the default Space a
	// registered account gets.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "carol", "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("carol login = %d %v", code, body)
	}
	carol := map[string]string{"Authorization": "Bearer " + body["token"].(string)}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/spaces", carol, nil)
	if code != http.StatusOK {
		t.Fatalf("carol spaces = %d %v", code, body)
	}
	spaces := body["spaces"].([]any)
	if len(spaces) != 1 || spaces[0].(map[string]any)["name"] != defaultSpaceName {
		t.Fatalf("carol default space = %v", body)
	}

	// She appears in the admin list next to the seeded accounts.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/admin/users", admin, nil)
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, body)
	}
	if len(body["users"].([]any)) != 3 {
		t.Fatalf("users = %v", body["users"])
	}
}

// deviceRoute is one device-credential endpoint plus the status it returns
// while the account is usable. The transfer case sends an empty body on
// purpose: it must reach the handler and be refused for its contents, which
// proves the gate is not what produced that code.
type deviceRoute struct {
	method     string
	path       string
	body       any
	wantActive int
}

func TestAdminDisableStopsDeviceCredentials(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	admin := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bob := map[string]string{"Authorization": "Bearer " + f.bobToken}

	// Bob ends up with a space, a registered device and an active binding.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", bob, map[string]string{"name": "Bobs"})
	if code != http.StatusCreated {
		t.Fatalf("bob space = %d %v", code, body)
	}
	bobSpace, _ := body["id"].(string)

	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/devices", bob,
		map[string]string{"name": "Edge@Bob", "browser": "edge", "platform": "macos"})
	if code != http.StatusCreated {
		t.Fatalf("bob device = %d %v", code, body)
	}
	deviceAuth := map[string]string{"Authorization": "Bearer " + body["token"].(string)}

	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/device/bindings", deviceAuth,
		map[string]string{"space_id": bobSpace})
	if code != http.StatusCreated {
		t.Fatalf("bob binding = %d %v", code, body)
	}
	bindingID, _ := body["id"].(string)
	// The binding becomes active the only way it can: a completed initial
	// reconciliation over the public API (doc 08 §11).
	_, _ = initializeBinding(t, f.ts, deviceAuth, bindingID, emptyBrowserSnapshot())

	routes := []deviceRoute{
		{"GET", "/api/v1/device/spaces", nil, http.StatusOK},
		{"GET", "/api/v1/device/bindings", nil, http.StatusOK},
		{"POST", "/api/v1/sync/bindings/" + bindingID, map[string]any{
			"protocol_version": 1, "epoch": 1, "applied_revision": 0, "received_revision": 0,
		}, http.StatusOK},
		{"GET", "/api/v1/sync/bindings/" + bindingID + "/snapshot", nil, http.StatusOK},
		{"POST", "/api/v1/sync/transfers", map[string]any{}, http.StatusBadRequest},
		// The reconciliation lifecycle came after the credential gate was
		// written, so it is asserted here rather than trusted by construction.
		{"POST", "/api/v1/sync/bindings/" + bindingID + "/reconciliations",
			map[string]string{"type": "recovery", "reason": "manual reconnection"}, http.StatusCreated},
	}

	for _, rt := range routes {
		status, out := doJSON(t, rt.method, f.ts.URL+rt.path, deviceAuth, rt.body)
		if status != rt.wantActive {
			t.Fatalf("while active %s %s = %d %v, want %d", rt.method, rt.path, status, out, rt.wantActive)
		}
	}

	// An API token is the same account wearing a different credential. Create
	// one while Bob is enabled and prove it works, so a refusal below means
	// "disabled", not "this token was never usable" (R08).
	_, tokenSecret := createToken(t, f, f.bobToken, "ci-reader", []string{"bookmarks:read"}, "all")
	apiAuth := map[string]string{"Authorization": "Bearer " + tokenSecret}
	if status, out := doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/"+bobSpace+"/nodes", apiAuth, nil); status != http.StatusOK {
		t.Fatalf("api token while enabled = %d %v, want 200", status, out)
	}

	_, me := doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", bob, nil)
	bobID := me["id"].(string)
	if status, _ := doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+bobID, admin,
		map[string]any{"status": "disabled"}); status != http.StatusOK {
		t.Fatalf("disable bob = %d", status)
	}

	// Logging the user out only killed the web session. The extension keeps
	// a secret that still has to be refused everywhere.
	for _, rt := range routes {
		status, out := doJSON(t, rt.method, f.ts.URL+rt.path, deviceAuth, rt.body)
		if status != http.StatusForbidden || errCode(t, out) != "ACCOUNT_DISABLED" {
			t.Fatalf("after disable %s %s = %d %v, want 403 ACCOUNT_DISABLED", rt.method, rt.path, status, out)
		}
	}

	// The API token is refused by the same policy: disabling a user must not
	// leave scripted access reading their bookmarks. It answers 401
	// TOKEN_INVALID rather than naming the cause, because that one message is
	// shared by unknown / revoked / disabled — the endpoint deliberately does
	// not become an oracle that tells a bearer which of the three happened.
	// The device credential, a paired principal its own owner can inspect,
	// does report ACCOUNT_DISABLED above.
	if status, out := doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/"+bobSpace+"/nodes", apiAuth, nil); status != http.StatusUnauthorized ||
		errCode(t, out) != "TOKEN_INVALID" {
		t.Fatalf("disabled account api token = %d %v, want 401 TOKEN_INVALID", status, out)
	}

	// A disabled account cannot widen its footprint either.
	if status, _ := doJSON(t, "POST", f.ts.URL+"/api/v1/devices", bob,
		map[string]string{"name": "Firefox@Bob"}); status != http.StatusUnauthorized {
		t.Fatalf("register device while disabled = %d, want 401", status)
	}

	// Policy: disabling gates credentials instead of revoking them, so the
	// re-enabled account resumes with the same secret and binding.
	if status, _ := doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+bobID, admin,
		map[string]any{"status": "active"}); status != http.StatusOK {
		t.Fatalf("re-enable bob = %d", status)
	}
	if status, out := doJSON(t, "GET", f.ts.URL+routes[3].path, deviceAuth, nil); status != http.StatusOK {
		t.Fatalf("snapshot after re-enable = %d %v", status, out)
	}
}

// postReset fires one reset request without touching *testing.T: it runs from
// goroutines, where t.Fatalf would abort the whole test binary instead of the
// one case.
func postResetStatus(url, token, password string) int {
	body, err := json.Marshal(map[string]string{"token": token, "new_password": password})
	if err != nil {
		return -1
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return -1
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return -1
	}
	defer res.Body.Close()
	return res.StatusCode
}

// resetLinkFor mints a reset link for a user through the admin API and pulls
// the raw token back out of it — the same token an admin would hand over out of
// band.
func resetLinkFor(t *testing.T, f *libraryFlow, adminHeader map[string]string, userID string) string {
	t.Helper()
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/admin/users/"+userID+"/reset-link", adminHeader, nil)
	if code != http.StatusCreated {
		t.Fatalf("reset link = %d %v", code, body)
	}
	link, _ := body["reset_link"].(string)
	i := strings.Index(link, "token=")
	if i < 0 {
		t.Fatalf("reset link carries no token: %q", link)
	}
	return link[i+len("token="):]
}

// TestResetTokenRaceHasOneWinner is the regression for the window that existed
// when consuming a token was "read it, check used_at, write it" plus two more
// statements: several requests carrying the same link could all pass the check
// before any of them wrote, and a request that could not change the password
// still burned the link.
func TestResetTokenRaceHasOneWinner(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	adminHeader := map[string]string{"Authorization": "Bearer " + f.sessionToken}

	var bobID string
	_, listed := doJSON(t, "GET", f.ts.URL+"/api/v1/admin/users", adminHeader, nil)
	for _, raw := range listed["users"].([]any) {
		if u := raw.(map[string]any); u["username"] == "bob" {
			bobID, _ = u["id"].(string)
		}
	}
	if bobID == "" {
		t.Fatal("bob missing from the admin user list")
	}
	raw := resetLinkFor(t, f, adminHeader, bobID)

	// A password that cannot be used must not spend the single-use link: the
	// caller has to be able to try again with a real one.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/auth/reset", nil,
		map[string]string{"token": raw, "new_password": "short"})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_PASSWORD" {
		t.Fatalf("weak password = %d %v, want 400 INVALID_PASSWORD", code, body)
	}

	const racers = 8
	const newPassword = "bob-raced-password"
	var wg sync.WaitGroup
	codes := make([]int, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			codes[slot] = postResetStatus(f.ts.URL+"/api/v1/auth/reset", raw, newPassword)
		}(i)
	}
	wg.Wait()

	won, refused := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			won++
		case http.StatusForbidden:
			refused++
		}
	}
	// Exactly one request won the token; every other one was told the link was
	// already used, not silently accepted.
	if won != 1 || refused != racers-1 {
		t.Fatalf("reset race: %d succeeded and %d refused as used, want 1 and %d (codes %v)",
			won, refused, racers-1, codes)
	}

	if code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "bob", "password": newPassword}); code != http.StatusOK {
		t.Fatalf("login after the winning reset = %d %v", code, body)
	}
}
