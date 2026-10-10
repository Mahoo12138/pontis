package httpapi

// The "发布" row of the acceptance matrix: with the Web app embedded in the
// same binary as the API, a deep link must load the app, an unknown API route
// must stay a JSON error, and a missing bundle must 404 rather than answer
// with HTML.

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

const testIndex = `<!doctype html>
<html><body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body></html>
`

func stagedRouter(t *testing.T) http.Handler {
	t.Helper()
	srv, _, _ := newTestServerWithDB(t)
	srv.Web = fstest.MapFS{
		"index.html":              {Data: []byte(testIndex)},
		"favicon.svg":             {Data: []byte("<svg/>")},
		"assets/index-abc123.js":  {Data: []byte("console.log('pontis')")},
		"assets/index-abc123.css": {Data: []byte(":root{}")},
		"mockServiceWorker.js":    {Data: []byte("// msw")},
	}
	return srv.Router()
}

func serve(t *testing.T, router http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestWebDeepLinkServesTheApp(t *testing.T) {
	router := stagedRouter(t)

	for _, target := range []string{"/", "/spaces", "/spaces/0198c0de-7000-7000-8000-000000000020/explorer", "/admin/users"} {
		rec := serve(t, router, http.MethodGet, target)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", target, rec.Code)
		}
		if got := rec.Body.String(); !strings.Contains(got, `id="root"`) {
			t.Fatalf("GET %s did not return the app shell: %q", target, got)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("GET %s content type = %q", target, ct)
		}
	}
}

func TestWebIndexIsNotCached(t *testing.T) {
	// index.html is the one asset whose URL never changes: caching it is how a
	// redeploy leaves a client loading a bundle that no longer exists.
	rec := serve(t, stagedRouter(t), http.MethodGet, "/spaces")
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("index Cache-Control = %q, want no-cache", got)
	}
}

func TestHashedAssetIsServedAndImmutable(t *testing.T) {
	rec := serve(t, stagedRouter(t), http.MethodGet, "/assets/index-abc123.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /assets/index-abc123.js = %d", rec.Code)
	}
	if got := rec.Body.String(); !strings.Contains(got, "pontis") {
		t.Fatalf("asset body = %q", got)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("asset Cache-Control = %q", cc)
	}
}

func TestUnknownAPIRouteStaysAnAPIError(t *testing.T) {
	// The failure this guards is the silent one: index.html with status 200 on
	// /api/... makes a typo'd endpoint look like an empty JSON body.
	for _, target := range []string{"/api/v1/nope", "/api/v1/spaces/0198c0de-7000-7000-8000-000000000020/unknown", "/api/v2/meta"} {
		rec := serve(t, stagedRouter(t), http.MethodGet, target)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", target, rec.Code)
		}
		if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
			t.Fatalf("GET %s content type = %q, want JSON", target, ct)
		}
		if body := rec.Body.String(); !strings.Contains(body, "ROUTE_NOT_FOUND") {
			t.Fatalf("GET %s body = %q", target, body)
		}
	}
}

func TestWrongMethodOnAPIRouteIs405JSON(t *testing.T) {
	rec := serve(t, stagedRouter(t), http.MethodDelete, "/api/v1/meta")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /api/v1/meta = %d, want 405", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "METHOD_NOT_ALLOWED") {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestMissingAssetIsNotFoundNotTheApp(t *testing.T) {
	// HTML where the browser expected JavaScript shows up later as an
	// unattributable syntax error in an unrelated module.
	rec := serve(t, stagedRouter(t), http.MethodGet, "/assets/index-deadbeef.js")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing asset = %d, want 404", rec.Code)
	}
	if strings.Contains(rec.Body.String(), `id="root"`) {
		t.Fatalf("missing asset fell through to index.html: %q", rec.Body.String())
	}
}

func TestAssetPathCannotEscapeTheDist(t *testing.T) {
	router := stagedRouter(t)
	for _, target := range []string{"/assets/../../go.mod", "/%2e%2e/%2e%2e/etc/passwd", "/../server.go"} {
		rec := serve(t, router, http.MethodGet, target)
		body := rec.Body.String()
		if strings.Contains(body, "module pontis") || strings.Contains(body, "root:x:") {
			t.Fatalf("%s escaped the embedded dist: %q", target, body)
		}
	}
}

func TestUnstagedWebBuildSaysSo(t *testing.T) {
	// A plain `go build` in a fresh checkout embeds only the placeholder. An
	// empty 200 page would read as "the app is broken"; this names the fix.
	srv, _, _ := newTestServerWithDB(t)
	srv.Web = fstest.MapFS{".gitkeep": {Data: []byte("placeholder")}}

	rec := serve(t, srv.Router(), http.MethodGet, "/spaces")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unstaged web build = %d, want 503", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, "pnpm build") {
		t.Fatalf("body = %q, expected the staging hint", body)
	}
}

func TestServerWithoutAnyAssetsSaysSo(t *testing.T) {
	srv, _, _ := newTestServerWithDB(t)
	srv.Web = nil // no assets at all

	rec := serve(t, srv.Router(), http.MethodGet, "/spaces")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("no assets = %d, want 503", rec.Code)
	}
}
