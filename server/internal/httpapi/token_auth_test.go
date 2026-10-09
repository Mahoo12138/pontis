package httpapi

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"pontis/internal/token"
)

// createToken mints an API token through the session API and returns its id
// plus the one-time secret.
func createToken(t *testing.T, f *libraryFlow, session, name string, scopes []string, spaceScope string) (string, string) {
	t.Helper()
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/tokens",
		map[string]string{"Authorization": "Bearer " + session},
		map[string]any{"name": name, "scopes": scopes, "space_scope": spaceScope})
	if code != http.StatusCreated {
		t.Fatalf("create token %s = %d %v", name, code, body)
	}
	secret, _ := body["secret"].(string)
	if !strings.HasPrefix(secret, token.SecretPrefix) {
		t.Fatalf("secret %q is not a pnt_ credential", secret)
	}
	id, _ := body["token"].(map[string]any)["id"].(string)
	return id, secret
}

func bearer(secret string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + secret}
}

// TestAPITokenCarriesOnlyItsOwnScope is the R10 acceptance run: a read-only,
// single-space token created through the real API reads exactly that space
// and is refused everywhere else, including the endpoints its owner can
// reach with a session.
func TestAPITokenCarriesOnlyItsOwnScope(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	nodes := func(space string) string {
		return fmt.Sprintf("%s/api/v1/spaces/%s/nodes", f.ts.URL, space)
	}

	// A second space of alice's and one of bob's, so "outside the token's
	// space list" and "not your space at all" stay separate refusals.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", bearer(f.sessionToken),
		map[string]string{"name": "Work"})
	if code != http.StatusCreated {
		t.Fatalf("alice second space = %d %v", code, body)
	}
	workSpace := body["id"].(string)

	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", bearer(f.bobToken),
		map[string]string{"name": "Bob"})
	if code != http.StatusCreated {
		t.Fatalf("bob space = %d %v", code, body)
	}
	bobSpace := body["id"].(string)

	_, readonly := createToken(t, f, f.sessionToken, "readonly",
		[]string{"bookmarks:read"}, fmt.Sprintf(`[%q]`, f.spaceID))

	// The granted capability on the granted space works.
	code, _ = doJSON(t, "GET", nodes(f.spaceID), bearer(readonly), nil)
	if code != http.StatusOK {
		t.Fatalf("read inside scope = %d, want 200", code)
	}
	code, _ = doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/root-slots", bearer(readonly), nil)
	if code != http.StatusOK {
		t.Fatalf("root slots inside scope = %d", code)
	}

	// Every mutation is refused, and refused as a scope problem rather than
	// a failed login.
	writes := []struct {
		method string
		path   string
		body   any
	}{
		{"POST", nodes(f.spaceID), map[string]any{
			"type": "folder", "title": "written by token",
			"parent": map[string]string{"type": "root", "key": "main"},
		}},
		{"DELETE", nodes(f.spaceID) + "/some-node", nil},
	}
	for _, w := range writes {
		code, body := doJSON(t, w.method, w.path, bearer(readonly), w.body)
		if code != http.StatusForbidden || errCode(t, body) != "SCOPE_DENIED" {
			t.Fatalf("%s %s = %d %v, want 403 SCOPE_DENIED", w.method, w.path, code, body)
		}
	}

	// Spaces outside space_scope.
	code, body = doJSON(t, "GET", nodes(workSpace), bearer(readonly), nil)
	if code != http.StatusForbidden || errCode(t, body) != "SPACE_OUT_OF_SCOPE" {
		t.Fatalf("read outside space scope = %d %v, want 403 SPACE_OUT_OF_SCOPE", code, body)
	}
	// Another user's space stays a ownership refusal: the token does not
	// turn alice into a reader of bob's data.
	code, body = doJSON(t, "GET", nodes(bobSpace), bearer(readonly), nil)
	if code != http.StatusForbidden || errCode(t, body) != "NOT_SPACE_OWNER" {
		t.Fatalf("read of another user's space = %d %v, want 403 NOT_SPACE_OWNER", code, body)
	}

	// Endpoints with no token capability at all: activity/undo, admin API
	// and the device replica protocol are session- or device-only.
	notForTokens := []struct {
		method, path, wantCode string
	}{
		{"GET", "/api/v1/spaces/" + f.spaceID + "/activity", "SESSION_INVALID"},
		{"GET", "/api/v1/admin/users", "SESSION_INVALID"},
		{"POST", "/api/v1/tokens", "SESSION_INVALID"},
		{"GET", "/api/v1/device/spaces", "DEVICE_CREDENTIAL_INVALID"},
		{"POST", "/api/v1/sync/bindings/" + f.bindingID, "DEVICE_CREDENTIAL_INVALID"},
		{"GET", "/api/v1/sync/bindings/" + f.bindingID + "/snapshot", "DEVICE_CREDENTIAL_INVALID"},
	}
	for _, c := range notForTokens {
		code, body := doJSON(t, c.method, f.ts.URL+c.path, bearer(readonly), nil)
		if code != http.StatusUnauthorized || errCode(t, body) != c.wantCode {
			t.Fatalf("%s %s with a token = %d %v, want 401 %s", c.method, c.path, code, body, c.wantCode)
		}
	}

	// A token cannot mint or revoke tokens: the management surface is
	// session-only. Proved above via POST /api/v1/tokens.

	// last_used_at is stamped by the read above.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/tokens", bearer(f.sessionToken), nil)
	if code != http.StatusOK {
		t.Fatalf("list tokens = %d %v", code, body)
	}
	var sawUsed bool
	for _, raw := range body["tokens"].([]any) {
		item := raw.(map[string]any)
		if item["name"] == "readonly" && item["last_used_at"] != nil {
			sawUsed = true
		}
	}
	if !sawUsed {
		t.Fatal("a verified token shows no last_used_at")
	}

	// Revocation takes effect immediately, with no restart in between.
	revokeID, revokedSecret := createToken(t, f, f.sessionToken, "shortlived",
		[]string{"bookmarks:read"}, "all")
	if code, _ := doJSON(t, "GET", nodes(f.spaceID), bearer(revokedSecret), nil); code != http.StatusOK {
		t.Fatalf("fresh token = %d, want 200", code)
	}
	if code := doEmpty(t, "DELETE", f.ts.URL+"/api/v1/tokens/"+revokeID, bearer(f.sessionToken)); code != http.StatusNoContent {
		t.Fatalf("revoke = %d", code)
	}
	code, body = doJSON(t, "GET", nodes(f.spaceID), bearer(revokedSecret), nil)
	if code != http.StatusUnauthorized || errCode(t, body) != "TOKEN_INVALID" {
		t.Fatalf("revoked token = %d %v, want 401 TOKEN_INVALID", code, body)
	}

	// "all" spans every space of the owner, including the second one.
	_, wildcard := createToken(t, f, f.sessionToken, "wildcard",
		[]string{"bookmarks:read"}, "all")
	for _, space := range []string{f.spaceID, workSpace} {
		if code, _ := doJSON(t, "GET", nodes(space), bearer(wildcard), nil); code != http.StatusOK {
			t.Fatalf(`wildcard read of %s = %d, want 200`, space, code)
		}
	}
	// ...but a token that carries no backup scope still cannot see them.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/backups", bearer(wildcard), nil)
	if code != http.StatusForbidden || errCode(t, body) != "SCOPE_DENIED" {
		t.Fatalf("backups without scope = %d %v, want 403 SCOPE_DENIED", code, body)
	}
}

// TestAPITokenGatesOnOwnerAccountStatus mirrors the device policy (R08): a
// disabled account's credentials are refused, and a re-enabled one resumes
// with the same secret.
func TestAPITokenGatesOnOwnerAccountStatus(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	admin := bearer(f.sessionToken)

	code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/admin/users", admin, nil)
	if code != http.StatusOK {
		t.Fatalf("admin list = %d %v", code, body)
	}
	var bobID string
	for _, raw := range body["users"].([]any) {
		if m := raw.(map[string]any); m["username"] == "bob" {
			bobID = m["id"].(string)
		}
	}
	if bobID == "" {
		t.Fatal("bob missing from admin list")
	}

	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/spaces", bearer(f.bobToken),
		map[string]string{"name": "Bob"})
	if code != http.StatusCreated {
		t.Fatalf("bob space = %d %v", code, body)
	}
	bobSpace := body["id"].(string)

	_, secret := createToken(t, f, f.bobToken, "bob-ci", []string{"bookmarks:read"}, "all")
	nodesURL := fmt.Sprintf("%s/api/v1/spaces/%s/nodes", f.ts.URL, bobSpace)
	if code, _ := doJSON(t, "GET", nodesURL, bearer(secret), nil); code != http.StatusOK {
		t.Fatalf("bob token before disable = %d, want 200", code)
	}

	if code, _ := doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+bobID, admin,
		map[string]any{"status": "disabled"}); code != http.StatusOK {
		t.Fatalf("disable bob = %d", code)
	}
	code, body = doJSON(t, "GET", nodesURL, bearer(secret), nil)
	if code != http.StatusUnauthorized || errCode(t, body) != "TOKEN_INVALID" {
		t.Fatalf("bob token while disabled = %d %v, want 401 TOKEN_INVALID", code, body)
	}

	if code, _ := doJSON(t, "PATCH", f.ts.URL+"/api/v1/admin/users/"+bobID, admin,
		map[string]any{"status": "active"}); code != http.StatusOK {
		t.Fatalf("re-enable bob = %d", code)
	}
	if code, _ := doJSON(t, "GET", nodesURL, bearer(secret), nil); code != http.StatusOK {
		t.Fatalf("bob token after re-enable = %d, want 200", code)
	}
}
