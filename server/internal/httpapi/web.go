package httpapi

// Serving the Web app out of the same binary as the API: everything the route
// table does not claim falls through here. Two rules make this a release
// artifact rather than a demo: an unknown `/api/*` stays a JSON error instead
// of an HTML page, and a client-side deep link returns index.html so a reload
// on /space/xyz does not 404.

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// apiPrefix marks the paths that belong to the API and must keep answering
// with the error envelope.
const apiPrefix = "/api/"

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	if isAPIPath(r.URL.Path) {
		s.writeError(w, r, http.StatusNotFound, "ROUTE_NOT_FOUND", "unknown API route")
		return
	}
	s.serveWeb(w, r)
}

func (s *Server) handleMethodNotAllowed(w http.ResponseWriter, r *http.Request) {
	if isAPIPath(r.URL.Path) {
		s.writeError(w, r, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "wrong method for this API route")
		return
	}
	s.serveWeb(w, r)
}

func isAPIPath(urlPath string) bool {
	return strings.HasPrefix(urlPath, apiPrefix)
}

// serveWeb answers a path no API route claimed.
func (s *Server) serveWeb(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if !webBuildStaged(s.Web) {
		// A checkout that never ran a release build embeds only the
		// placeholder. Say what is missing instead of serving an empty page.
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("web assets are not staged: run `pnpm build` from the repository root\n"))
		return
	}

	name := webPath(r.URL.Path)

	// The content-hashed bundle never needs revalidation; index.html does, or
	// a redeploy leaves clients loading a bundle that no longer exists.
	if name != "" {
		if info, err := fs.Stat(s.Web, name); err == nil && !info.IsDir() {
			if strings.HasPrefix(name, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.ServeFileFS(w, r, s.Web, name)
			return
		}
		// A request that looks like a file but is not one is a 404, never
		// index.html: HTML served where the browser expected JavaScript shows
		// up later as an unattributable syntax error.
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
	}

	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFileFS(w, r, s.Web, "index.html")
}

// webPath maps a URL path onto a name inside the asset filesystem. Cleaning
// against the root collapses every `..`, and fs.ValidPath rejects anything
// that still is not a plain forward-slash path.
func webPath(urlPath string) string {
	name := strings.TrimPrefix(path.Clean("/"+urlPath), "/")
	if name == "." || name == "/" || !fs.ValidPath(name) {
		return ""
	}
	return name
}

func webBuildStaged(assets fs.FS) bool {
	if assets == nil {
		return false
	}
	info, err := fs.Stat(assets, "index.html")
	return err == nil && !info.IsDir()
}
