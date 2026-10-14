package httpapi

// The "分发" row of the release gate (doc §14.1): the catalog and the bytes
// behind it answer with what the embedded manifest promised, to a session and
// to nobody else, and a path the manifest does not list stays a JSON 404
// instead of reaching a file.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"pontis/internal/distribution"
	"pontis/internal/sync"
)

const (
	testArtifactURL  = "/downloads/extensions/chromium/sync/v0.1.0.zip"
	testArtifactName = "pontis-chromium-sync-v0.1.0.zip"
	testArtifactBody = "PK\x03\x04 fake extension bytes"
)

// testDistribution builds a staged-looking release. The digest covers the same
// bytes the source hands out, so a header assertion that compares against it
// tests the wiring rather than a constant.
func testDistribution(t *testing.T) *distribution.Source {
	t.Helper()
	manifest, err := json.Marshal(map[string]any{
		"release":      "v0.1.0",
		"commit":       "0000000000000000000000000000000000000000",
		"generated_at": "2026-10-14T00:00:00.000Z",
		"artifacts": []any{map[string]any{
			"platform":           "chromium",
			"variant":            "sync",
			"version":            "0.1.0",
			"file":               testArtifactURL,
			"name":               testArtifactName,
			"sha256":             digestOf(testArtifactBody),
			"size_bytes":         len(testArtifactBody),
			"manifest_version":   3,
			"min_server_version": "0.1.0",
			"supported_browsers": []string{"chrome"},
		}},
	})
	if err != nil {
		t.Fatalf("marshal test manifest: %v", err)
	}
	src, err := distribution.LoadFrom(fstest.MapFS{
		"artifacts/manifest.json":       {Data: manifest},
		"artifacts/" + testArtifactName: {Data: []byte(testArtifactBody)},
		// Present in the directory but absent from the manifest: the closest a
		// test can come to a file the download API must refuse to name.
		"artifacts/pontis-chromium-sync-v9.9.9.zip": {Data: []byte("not in the manifest")},
	})
	if err != nil {
		t.Fatalf("load test distribution: %v", err)
	}
	return src
}

func digestOf(payload string) string {
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

// stagedDistribution puts a package in front of a real router and hands back a
// session token, which is what the install page has when it links either
// endpoint.
func stagedDistribution(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	srv, ts := newTestServer(t)
	srv.Distribution = testDistribution(t)
	return ts, setupAdmin(t, ts)
}

// sessionGet issues a real request the way the browser would, so the headers
// ServeContent sets are the ones a downloader sees.
func sessionGet(t *testing.T, method, url, token string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestDistributionEndpointsNeedASession(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.Distribution = testDistribution(t)

	// No cookie, no bearer: the anonymous visitor who has not installed the
	// extension yet is exactly the person who would try.
	for _, target := range []string{"/api/v1/distribution/extensions", testArtifactURL} {
		rec := serve(t, srv.Router(), http.MethodGet, target)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401", target, rec.Code)
		}
	}
}

func TestCatalogRejectsAnAPIToken(t *testing.T) {
	ts, token := stagedDistribution(t)
	created := restPOST(t, ts, token, "/api/v1/tokens", map[string]any{
		"name": "read-only", "scopes": []string{"bookmarks:read"}, "space_scope": "all",
	})
	secret, _ := created["secret"].(string)
	if secret == "" {
		t.Fatalf("token creation returned no secret: %v", created)
	}

	// An API token is not a session. The install page is a web surface, and a
	// bookmarks:read token must not become a way to script package pulls
	// against an instance that only meant to show the page.
	code, body := doJSON(t, http.MethodGet, ts.URL+"/api/v1/distribution/extensions",
		map[string]string{"Authorization": "Bearer " + secret}, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("catalog with an API token = %d %v, want 401", code, body)
	}
}

func TestDistributionCatalogDescribesTheInstance(t *testing.T) {
	ts, token := stagedDistribution(t)

	code, body := doJSON(t, http.MethodGet, ts.URL+"/api/v1/distribution/extensions",
		map[string]string{"Authorization": "Bearer " + token}, nil)
	if code != http.StatusOK {
		t.Fatalf("catalog = %d %v", code, body)
	}
	if body["release"] != "v0.1.0" {
		t.Errorf("release = %v", body["release"])
	}
	// The fields doc §12 asks to declare separately: the server's own version
	// and API version come from the binary, not from the staged manifest.
	if body["server_version"] != ProductVersion {
		t.Errorf("server_version = %v, want %q", body["server_version"], ProductVersion)
	}
	if body["http_api_version"] != APIVersion {
		t.Errorf("http_api_version = %v, want %q", body["http_api_version"], APIVersion)
	}

	artifacts, ok := body["artifacts"].([]any)
	if !ok || len(artifacts) != 1 {
		t.Fatalf("artifacts = %v, want one entry", body["artifacts"])
	}
	artifact := artifacts[0].(map[string]any)
	if artifact["file"] != testArtifactURL {
		t.Errorf("file = %v", testArtifactURL)
	}
	if artifact["sha256"] != digestOf(testArtifactBody) {
		t.Errorf("sha256 = %v", artifact["sha256"])
	}
	if artifact["version"] != "0.1.0" || artifact["platform"] != "chromium" {
		t.Errorf("artifact = %v", artifact)
	}
	// Which of the two packages this is. A client can only pick its own update
	// by matching platform and variant together.
	if artifact["variant"] != "sync" {
		t.Errorf("variant = %v, want sync", artifact["variant"])
	}
	if browsers, ok := artifact["supported_browsers"].([]any); !ok || len(browsers) != 1 {
		t.Errorf("supported_browsers = %v, want one entry", artifact["supported_browsers"])
	}
	// Injected server-side rather than copied from the build: this is what a
	// client compares with its own protocol version (doc §7).
	protocols, ok := artifact["sync_protocol_versions"].([]any)
	if !ok || len(protocols) != 1 || protocols[0] != float64(sync.ProtocolVersion) {
		t.Fatalf("sync_protocol_versions = %v, want the server's own", artifact["sync_protocol_versions"])
	}
	// The staged file name is where the bytes live inside the binary, not part
	// of what a client is allowed to ask for.
	if _, leaked := artifact["name"]; leaked {
		t.Error("catalog exposed the embedded file name; only `file` is public")
	}
}

func TestDistributionCatalogWithNothingStaged(t *testing.T) {
	// A checkout that never ran a release build: the page has to tell "this
	// binary carries no package" apart from "the request failed", so the list is
	// an empty array rather than null.
	srv, ts := newTestServer(t)
	srv.Distribution = distribution.Empty()
	token := setupAdmin(t, ts)

	resp := sessionGet(t, http.MethodGet, ts.URL+"/api/v1/distribution/extensions", token, nil)
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("catalog = %d %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), `"artifacts":[]`) {
		t.Fatalf("unstaged catalog = %s, want artifacts:[]", raw)
	}
}

func TestDeviceCredentialReadsTheReleaseRoute(t *testing.T) {
	ts, token := stagedDistribution(t)
	created := restPOST(t, ts, token, "/api/v1/devices", map[string]string{
		"name": "Chrome@Home", "browser": "chrome", "platform": "macos",
	})
	deviceToken, _ := created["token"].(string)
	if deviceToken == "" {
		t.Fatalf("device registration returned no credential: %v", created)
	}

	// The extension holds a device credential and never a session, so this is
	// the only catalog it can reach — and reaching it is what lets the settings
	// page say "this instance has a newer package".
	code, body := doJSON(t, http.MethodGet, ts.URL+"/api/v1/device/extensions",
		map[string]string{"Authorization": "Bearer " + deviceToken}, nil)
	if code != http.StatusOK {
		t.Fatalf("device catalog = %d %v", code, body)
	}
	artifacts, ok := body["artifacts"].([]any)
	if !ok || len(artifacts) != 1 {
		t.Fatalf("device catalog artifacts = %v, want one entry", body["artifacts"])
	}

	// Credentials stay typed: a device credential is not a web session and does
	// not unlock the session-only surface.
	code, _ = doJSON(t, http.MethodGet, ts.URL+"/api/v1/distribution/extensions",
		map[string]string{"Authorization": "Bearer " + deviceToken}, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("device credential on the session route = %d, want 401", code)
	}
}

func TestExtensionDownloadServesTheStagedBytes(t *testing.T) {
	ts, token := stagedDistribution(t)

	resp := sessionGet(t, http.MethodGet, ts.URL+testArtifactURL, token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download = %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Type"); got != "application/zip" {
		t.Errorf("Content-Type = %q, want application/zip", got)
	}
	// The published digest, the advertised length and the served bytes have to
	// agree; that agreement is the whole reason the install page shows a
	// checksum at all.
	if want := fmt.Sprint(len(testArtifactBody)); resp.Header.Get("Content-Length") != want {
		t.Errorf("Content-Length = %q, want %q", resp.Header.Get("Content-Length"), want)
	}
	if got := resp.Header.Get("Content-Disposition"); got != `attachment; filename="`+testArtifactName+`"` {
		t.Errorf("Content-Disposition = %q", got)
	}
	if got := resp.Header.Get("ETag"); got != `"`+digestOf(testArtifactBody)+`"` {
		t.Errorf("ETag = %q, want the artifact digest", got)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != testArtifactBody {
		t.Errorf("served %q", body)
	}
}

func TestExtensionDownloadHeadMatchesGet(t *testing.T) {
	ts, token := stagedDistribution(t)

	resp := sessionGet(t, http.MethodHead, ts.URL+testArtifactURL, token, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HEAD = %d", resp.StatusCode)
	}
	if want := fmt.Sprint(len(testArtifactBody)); resp.Header.Get("Content-Length") != want {
		t.Errorf("HEAD Content-Length = %q, want what GET reports", resp.Header.Get("Content-Length"))
	}
	if got := resp.Header.Get("Content-Type"); got != "application/zip" {
		t.Errorf("HEAD Content-Type = %q", got)
	}
	if body, _ := io.ReadAll(resp.Body); len(body) != 0 {
		t.Errorf("HEAD carried %d bytes", len(body))
	}
}

func TestExtensionDownloadNotModified(t *testing.T) {
	ts, token := stagedDistribution(t)

	resp := sessionGet(t, http.MethodGet, ts.URL+testArtifactURL, token,
		map[string]string{"If-None-Match": `"` + digestOf(testArtifactBody) + `"`})
	if resp.StatusCode != http.StatusNotModified {
		t.Fatalf("If-None-Match = %d, want 304", resp.StatusCode)
	}
}

func TestExtensionDownloadOnlyKnowsTheManifest(t *testing.T) {
	ts, token := stagedDistribution(t)

	// v9.9.9 really is embedded next to the release package. It must stay
	// unreachable, and so must anything spelled differently enough to look new.
	for _, target := range []string{
		"/downloads/extensions/chromium/sync/v9.9.9.zip",
		"/downloads/extensions/chromium/sync/v0.2.0.zip",
		"/downloads/extensions/firefox/v0.1.0.xpi",
		"/downloads/extensions/chromium/../artifacts/pontis-chromium-sync-v9.9.9.zip",
		"/downloads/extensions/chromium/%2e%2e/manifest.json",
		"/downloads/",
	} {
		code, body := doJSON(t, http.MethodGet, ts.URL+target,
			map[string]string{"Authorization": "Bearer " + token}, nil)
		if code != http.StatusNotFound {
			t.Errorf("GET %s = %d %v, want 404", target, code, body)
			continue
		}
		errBody, _ := body["error"].(map[string]any)
		if errBody == nil || errBody["code"] != "EXTENSION_ARTIFACT_NOT_FOUND" {
			t.Errorf("GET %s error = %v, want EXTENSION_ARTIFACT_NOT_FOUND", target, body)
		}
	}
}

func TestExtensionDownloadIsNotTheAppShell(t *testing.T) {
	// /downloads/* sits outside /api/*, so without its own route it would fall
	// through to index.html — a download that silently saves an HTML page. The
	// whole prefix is claimed for that reason, including the paths under it that
	// no package matches.
	ts, token := stagedDistribution(t)

	for _, target := range []string{
		"/downloads/extensions/chromium/nope.zip",
		"/downloads/anything/at/all",
	} {
		code, body := doJSON(t, http.MethodGet, ts.URL+target,
			map[string]string{"Authorization": "Bearer " + token}, nil)
		if code != http.StatusNotFound {
			t.Fatalf("%s = %d %v, want 404", target, code, body)
		}
		if _, ok := body["error"]; !ok {
			t.Fatalf("%s returned a non-API body: %v", target, body)
		}
	}
}
