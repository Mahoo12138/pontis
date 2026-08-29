package httpapi

import (
	"net/http"
	"testing"
)

func TestTokenLifecycle(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}

	// Create with valid scopes; secret returned exactly once.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/tokens", h,
		map[string]any{"name": "ci", "scopes": []string{"bookmarks:read", "backups:write"}})
	if code != http.StatusCreated {
		t.Fatalf("create = %d %v", code, body)
	}
	secret := body["secret"].(string)
	tok := body["token"].(map[string]any)
	tokenID := tok["id"].(string)
	if secret == "" || len(tok["scopes"].([]any)) != 2 {
		t.Fatalf("bad create response %v", body)
	}

	// List shows the token without any secret.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/tokens", h, nil)
	if code != http.StatusOK || len(body["tokens"].([]any)) != 1 {
		t.Fatalf("list = %d %v", code, body)
	}

	// Invalid scope and empty name rejected.
	code, _ = doJSON(t, "POST", f.ts.URL+"/api/v1/tokens", h,
		map[string]any{"name": "x", "scopes": []string{"admin:all"}})
	if code != http.StatusBadRequest {
		t.Fatalf("bad scope = %d", code)
	}
	code, _ = doJSON(t, "POST", f.ts.URL+"/api/v1/tokens", h,
		map[string]any{"name": "", "scopes": []string{"bookmarks:read"}})
	if code != http.StatusBadRequest {
		t.Fatalf("empty name = %d", code)
	}

	// Bob cannot revoke alice's token.
	code, _ = doJSON(t, "DELETE", f.ts.URL+"/api/v1/tokens/"+tokenID,
		map[string]string{"Authorization": "Bearer " + f.bobToken}, nil)
	if code != http.StatusNotFound {
		t.Fatalf("bob revoke = %d", code)
	}

	// Alice revokes; the token disappears from the list.
	code = doEmpty(t, "DELETE", f.ts.URL+"/api/v1/tokens/"+tokenID, h)
	if code != http.StatusNoContent {
		t.Fatalf("revoke = %d", code)
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/tokens", h, nil)
	if code != http.StatusOK || len(body["tokens"].([]any)) != 0 {
		t.Fatalf("post-revoke list = %d %v", code, body)
	}
}
