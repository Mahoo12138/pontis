package httpapi

import (
	"net/http"
	"strings"
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
