package httpapi

// The origin/CSRF boundary and the deployment-mode inputs behind it
// (PR-D1: "Session Cookie/CSRF/Origin/公开 URL 配置按部署模式验证").
//
// The interesting half of these is not that a foreign origin is refused — it is
// what must keep working: the extension calls /sync with a device credential and
// an Origin of chrome-extension://…, and a CLI holds a session cookie without
// sending Origin at all.

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// sessionCookieSession logs in through the public API and returns the session
// token, which is what a browser would hold in the pontis_session cookie.
func sessionCookieSession(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	code, setup := doJSON(t, http.MethodPost, ts.URL+"/api/v1/auth/setup", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusCreated {
		t.Fatalf("setup = %d %v", code, setup)
	}
	code, login := doJSON(t, http.MethodPost, ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("login = %d %v", code, login)
	}
	token, _ := login["token"].(string)
	if token == "" {
		t.Fatalf("login carried no token: %v", login)
	}
	return token
}

func withSessionCookie(token string) map[string]string {
	return map[string]string{"Cookie": SessionCookie + "=" + token}
}

func TestCookieWritesMustMatchTheInstanceOrigin(t *testing.T) {
	_, ts := newTestServer(t)
	session := sessionCookieSession(t, ts)
	cookie := withSessionCookie(session)

	// A space must exist for the write to be about something; this POST is
	// reached through the origin gate first, so the body barely matters.
	same := map[string]string{"name": "Personal"}

	code, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/spaces",
		mergeHeaders(cookie, map[string]string{"Origin": ts.URL}), same)
	if code != http.StatusCreated {
		t.Fatalf("same-origin POST = %d %v, want 201", code, body)
	}

	code, body = doJSON(t, http.MethodPost, ts.URL+"/api/v1/spaces",
		mergeHeaders(cookie, map[string]string{"Origin": "https://evil.example"}), same)
	if code != http.StatusForbidden || errCode(t, body) != "ORIGIN_MISMATCH" {
		t.Fatalf("cross-origin POST = %d %v, want 403 ORIGIN_MISMATCH", code, body)
	}

	// No Origin at all: a tool holding the cookie, not a page forging one.
	code, body = doJSON(t, http.MethodPost, ts.URL+"/api/v1/spaces", cookie, same)
	if code == http.StatusForbidden && errCode(t, body) == "ORIGIN_MISMATCH" {
		t.Fatalf("origin-less POST was refused as a cross-site request: %v", body)
	}

	// Reads are never affected, foreign origin or not.
	if code, body = doJSON(t, http.MethodGet, ts.URL+"/api/v1/spaces",
		mergeHeaders(cookie, map[string]string{"Origin": "https://evil.example"}), nil); code != http.StatusOK {
		t.Fatalf("cross-origin GET = %d %v, want 200", code, body)
	}
}

func TestDevProxyOriginIsAcceptedOnLoopback(t *testing.T) {
	_, ts := newTestServer(t)
	session := sessionCookieSession(t, ts)

	// `pnpm dev` serves the app on :5173 and proxies /api to the server, so
	// the browser origin and the Host the server sees differ by port alone.
	// Refusing that would lock out the documented development workflow.
	code, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/spaces",
		mergeHeaders(withSessionCookie(session), map[string]string{"Origin": "http://localhost:5173"}),
		map[string]string{"name": "Personal"})
	if code != http.StatusCreated {
		t.Fatalf("dev-proxy origin POST = %d %v, want 201", code, body)
	}

	// The allowance is loopback on both sides. A public host wearing a dev
	// port is still a foreign origin.
	code, body = doJSON(t, http.MethodPost, ts.URL+"/api/v1/spaces",
		mergeHeaders(withSessionCookie(session), map[string]string{"Origin": "https://bookmarks.example:5173"}),
		map[string]string{"name": "Other"})
	if code != http.StatusForbidden || errCode(t, body) != "ORIGIN_MISMATCH" {
		t.Fatalf("non-loopback origin with a dev port = %d %v, want 403 ORIGIN_MISMATCH", code, body)
	}
}

// TestBearerCredentialsIgnoreTheOriginGate is the extension's protection: it
// posts /sync with a device credential and an Origin the server can never match.
func TestBearerCredentialsIgnoreTheOriginGate(t *testing.T) {
	_, ts := newTestServer(t)
	session := sessionCookieSession(t, ts)

	// A session token carried as a bearer secret is the same story: the page
	// across the street cannot make the browser attach it.
	code, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/spaces",
		mergeHeaders(bearer(session), map[string]string{"Origin": "https://evil.example"}),
		map[string]string{"name": "Personal"})
	if code != http.StatusCreated {
		t.Fatalf("bearer POST with foreign origin = %d %v, want 201", code, body)
	}

	// And the device credential path, which is what the extension really uses.
	code, body = doJSON(t, http.MethodPost, ts.URL+"/api/v1/devices",
		mergeHeaders(bearer(session), map[string]string{"Origin": "https://evil.example"}),
		map[string]string{"name": "Chrome@Home", "browser": "chrome", "platform": "linux"})
	if code != http.StatusCreated {
		t.Fatalf("device register = %d %v", code, body)
	}
	deviceToken, _ := body["token"].(string)

	// A pending binding cannot sync, but it must fail for that reason and not
	// because the extension's origin looks foreign.
	code, body = doJSON(t, http.MethodPost,
		ts.URL+"/api/v1/sync/bindings/nonexistent", bearer(deviceToken), map[string]any{})
	if errCode(t, body) == "ORIGIN_MISMATCH" {
		t.Fatalf("device credential was caught by the origin gate: %d %v", code, body)
	}
}

func TestPublicURLDecidesOriginAndLinkAuthority(t *testing.T) {
	srv, ts, _ := newTestServerWithDB(t)
	// The router reads Deploy per request, so setting it after the test server
	// is up is enough.
	srv.Deploy = Deployment{PublicURL: "https://bookmarks.example"}
	session := sessionCookieSession(t, ts)

	adminHeader := bearer(session)
	code, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/spaces",
		mergeHeaders(withSessionCookie(session), map[string]string{"Origin": "https://bookmarks.example"}),
		map[string]string{"name": "Personal"})
	if code != http.StatusCreated {
		t.Fatalf("POST via the configured origin = %d %v, want 201", code, body)
	}

	// The Host the request actually carried is the internal name behind the
	// proxy; the reset link must carry the public one instead.
	code, listed := doJSON(t, http.MethodGet, ts.URL+"/api/v1/admin/users", adminHeader, nil)
	if code != http.StatusOK {
		t.Fatalf("admin users = %d %v", code, listed)
	}
	userID := ""
	for _, raw := range listed["users"].([]any) {
		if u := raw.(map[string]any); u["username"] == "alice" {
			userID, _ = u["id"].(string)
		}
	}
	if userID == "" {
		t.Fatal("alice missing from the admin list")
	}
	code, link := doJSON(t, http.MethodPost, ts.URL+"/api/v1/admin/users/"+userID+"/reset-link", adminHeader, nil)
	if code != http.StatusCreated {
		t.Fatalf("reset link = %d %v", code, link)
	}
	resetLink, _ := link["reset_link"].(string)
	if !strings.HasPrefix(resetLink, "https://bookmarks.example/reset?token=") {
		t.Fatalf("reset link ignored public_url: %q (server host is %s)", resetLink, ts.URL)
	}
}

func TestForwardedProtoOnlyFromATrustedPeer(t *testing.T) {
	t.Run("untrusted peer cannot make the cookie Secure", func(t *testing.T) {
		_, ts := newTestServer(t)
		if secure := loginSetsSecure(t, ts, nil); secure {
			t.Fatal("plain http login set Secure with no proxy configured")
		}
	})

	t.Run("trusted proxy's https is believed", func(t *testing.T) {
		srv, ts, _ := newTestServerWithDB(t)
		proxies, err := ParseProxies([]string{"127.0.0.0/8"})
		if err != nil {
			t.Fatal(err)
		}
		srv.Deploy = Deployment{Proxies: proxies}
		if !loginSetsSecure(t, ts, map[string]string{"X-Forwarded-Proto": "https"}) {
			t.Fatal("login behind a trusted TLS proxy did not set a Secure cookie")
		}
	})
}

// loginSetsSecure performs a real login over a raw client and reports whether
// the session cookie came back with Secure set.
func loginSetsSecure(t *testing.T, ts *httptest.Server, extra map[string]string) bool {
	t.Helper()
	if _, err := http.Post(ts.URL+"/api/v1/auth/setup", "application/json",
		jsonBody(`{"username":"alice","password":"password123"}`)); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/auth/login",
		jsonBody(`{"username":"alice","password":"password123"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("login = %d", res.StatusCode)
	}
	for _, c := range res.Header.Values("Set-Cookie") {
		if strings.HasPrefix(c, SessionCookie+"=") {
			return slices.Contains(strings.Split(c, ";"), " Secure") ||
				slices.Contains(strings.Split(c, ";"), "Secure")
		}
	}
	t.Fatalf("no %s cookie in the login response", SessionCookie)
	return false
}

func jsonBody(raw string) *strings.Reader { return strings.NewReader(raw) }

func mergeHeaders(base map[string]string, extra map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}
