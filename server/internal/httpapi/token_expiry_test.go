package httpapi

import (
	"database/sql"
	"net/http"
	"strings"
	"testing"
	"time"

	"pontis/internal/token"
)

// TestAPITokenExpiry is the expiry half of R08/R10: a lifetime set at creation
// reaches the client as an absolute instant, and once it has passed the
// credential carries no authority anywhere — including on endpoints whose
// handlers never look at the field.
func TestAPITokenExpiry(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	session := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	nodesURL := f.ts.URL + "/api/v1/spaces/" + f.spaceID + "/nodes"
	mint := func(name string, extra map[string]any) (map[string]any, string, int, map[string]any) {
		t.Helper()
		payload := map[string]any{"name": name, "scopes": []string{"bookmarks:read"}}
		for k, v := range extra {
			payload[k] = v
		}
		code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/tokens", session, payload)
		tok, _ := body["token"].(map[string]any)
		secret, _ := body["secret"].(string)
		return tok, secret, code, body
	}

	tok, _, code, body := mint("never", nil)
	if code != http.StatusCreated {
		t.Fatalf("create without expiry = %d %v", code, body)
	}
	if v, ok := tok["expires_at"]; !ok || v != nil {
		t.Fatalf("expires_at = %v (key present: %t), want an explicit null", v, ok)
	}

	tok, secret, code, body := mint("one-day", map[string]any{"expires_in_days": 1})
	if code != http.StatusCreated {
		t.Fatalf("create with expiry = %d %v", code, body)
	}
	if !strings.HasPrefix(secret, token.SecretPrefix) {
		t.Fatalf("secret %q is not a pnt_ credential", secret)
	}
	tokenID, _ := tok["id"].(string)
	raw, _ := tok["expires_at"].(string)
	expires, err := time.Parse("2006-01-02T15:04:05Z", raw)
	if err != nil {
		t.Fatalf("expires_at %q is not the layout the DTO advertises: %v", raw, err)
	}
	if d := time.Until(expires); d < 23*time.Hour || d > 25*time.Hour {
		t.Errorf("expires_at is %v from now, want one day", d)
	}
	if code, _ := doJSON(t, "GET", nodesURL, bearer(secret), nil); code != http.StatusOK {
		t.Fatalf("read with a live token = %d, want 200", code)
	}

	// Age that row past its expiry, leaving every other field alone.
	aged := time.Now().UTC().Add(-time.Minute)
	if _, err := f.db.Exec(`UPDATE api_tokens SET expires_at = ? WHERE id = ?`,
		aged.Format(time.RFC3339Nano), tokenID); err != nil {
		t.Fatalf("ageing the token: %v", err)
	}
	usedBefore := readLastUsed(t, f.db, tokenID)
	if usedBefore.IsZero() {
		t.Fatal("the live read above did not stamp last_used_at, so this proves nothing")
	}
	code, body = doJSON(t, "GET", nodesURL, bearer(secret), nil)
	if code != http.StatusUnauthorized || errCode(t, body) != "TOKEN_INVALID" {
		t.Fatalf("expired token = %d %v, want 401 TOKEN_INVALID", code, body)
	}
	// A refused credential is not usage: last_used_at does not move.
	if used := readLastUsed(t, f.db, tokenID); !used.Equal(usedBefore) {
		t.Errorf("last_used_at moved to %v on a refused request, want %v", used, usedBefore)
	}

	// The expired token is still listed. Its owner is the one who needs to see
	// why the automation stopped, and revoking it stays their call.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/tokens", session, nil)
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, body)
	}
	items, _ := body["tokens"].([]any)
	var listed map[string]any
	for _, item := range items {
		row, _ := item.(map[string]any)
		if row["id"] == tokenID {
			listed = row
		}
	}
	if listed == nil {
		t.Fatalf("an expired token vanished from the list: %v", items)
	}
	if want := aged.Format("2006-01-02T15:04:05Z"); listed["expires_at"] != want {
		t.Errorf("listed expires_at = %v, want %v", listed["expires_at"], want)
	}

	for _, days := range []int{-1, 36501} {
		if _, _, code, body = mint("out of range", map[string]any{"expires_in_days": days}); code != http.StatusBadRequest ||
			errCode(t, body) != "INVALID_EXPIRY" {
			t.Fatalf("expires_in_days=%d = %d %v, want 400 INVALID_EXPIRY", days, code, body)
		}
	}
}

func readLastUsed(t *testing.T, db *sql.DB, tokenID string) time.Time {
	t.Helper()
	var raw *string
	if err := db.QueryRow(`SELECT last_used_at FROM api_tokens WHERE id = ?`, tokenID).Scan(&raw); err != nil {
		t.Fatalf("reading last_used_at: %v", err)
	}
	if raw == nil {
		return time.Time{}
	}
	v, err := time.Parse(time.RFC3339Nano, *raw)
	if err != nil {
		t.Fatalf("parsing last_used_at %q: %v", *raw, err)
	}
	return v
}
