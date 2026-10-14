package httpapi

// The download surface for the browser extension: what this instance carries,
// and the package itself. The bytes came from `go:embed` — the server never
// builds a file path out of a request, and never runs a build tool (doc §3, §6).
//
// Both endpoints sit behind the same session check as the page that links to
// them. Doc §6 asks for one policy rather than a page that requires login and a
// direct link that does not, and the answer is the stricter one for as long as
// the packages are the instance's own release.

import (
	"bytes"
	"net/http"
	"time"

	"pontis/internal/sync"
)

// extensionContentType is fixed rather than sniffed: this build distributes one
// Chromium ZIP, and a package served as the wrong type is a package a browser
// offers to "open" instead of save (doc §6).
const extensionContentType = "application/zip"

// distributionArtifactView is one downloadable package as a client sees it. The
// staged manifest's `name` — the file inside the embed — is deliberately not
// here: `file` is the contract, and it is already enough to fetch the bytes.
type distributionArtifactView struct {
	Platform             string   `json:"platform"`
	Version              string   `json:"version"`
	File                 string   `json:"file"`
	SHA256               string   `json:"sha256"`
	SizeBytes            int64    `json:"size_bytes"`
	ManifestVersion      int      `json:"manifest_version"`
	MinServerVersion     string   `json:"min_server_version"`
	SupportedBrowsers    []string `json:"supported_browsers"`
	SyncProtocolVersions []int    `json:"sync_protocol_versions"`
}

type distributionResponse struct {
	Release        string                     `json:"release"`
	Commit         string                     `json:"commit"`
	GeneratedAt    string                     `json:"generated_at"`
	ServerVersion  string                     `json:"server_version"`
	HTTPAPIVersion string                     `json:"http_api_version"`
	Artifacts      []distributionArtifactView `json:"artifacts"`
}

func (s *Server) handleDistributionExtensions(w http.ResponseWriter, r *http.Request) {
	out := distributionResponse{
		Release:        s.Distribution.Release(),
		Commit:         s.Distribution.Commit(),
		GeneratedAt:    s.Distribution.GeneratedAt(),
		ServerVersion:  ProductVersion,
		HTTPAPIVersion: APIVersion,
		// An instance built without a staged package answers `[]`: the install
		// page has to tell "nothing packaged" apart from "request failed", and
		// null would make both look like an empty list downstream.
		Artifacts: []distributionArtifactView{},
	}
	// The protocol versions are this server's, filled in here rather than
	// copied into the build manifest: they are what a client compares against,
	// and the build script has no business knowing them.
	protocols := []int{sync.ProtocolVersion}
	for _, a := range s.Distribution.Artifacts() {
		browsers := a.SupportedBrowsers
		if browsers == nil {
			browsers = []string{}
		}
		out.Artifacts = append(out.Artifacts, distributionArtifactView{
			Platform:             a.Platform,
			Version:              a.Version,
			File:                 a.URL,
			SHA256:               a.SHA256,
			SizeBytes:            a.SizeBytes,
			ManifestVersion:      a.ManifestVersion,
			MinServerVersion:     a.MinServerVersion,
			SupportedBrowsers:    browsers,
			SyncProtocolVersions: protocols,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleExtensionDownload serves one package. The request path is looked up in
// the compiled manifest and nowhere else, so an unknown version, a traversal or
// a hand-typed sibling path all land on the same 404.
func (s *Server) handleExtensionDownload(w http.ResponseWriter, r *http.Request) {
	artifact, ok := s.Distribution.Lookup(r.URL.Path)
	if !ok {
		s.writeError(w, r, http.StatusNotFound, "EXTENSION_ARTIFACT_NOT_FOUND",
			"this instance does not carry a package at that address")
		return
	}
	data, err := s.Distribution.Bytes(artifact)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}

	w.Header().Set("Content-Type", extensionContentType)
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	// The digest is the validator: a version URL never changes what it serves,
	// and a client that kept a copy can ask whether it is still current.
	w.Header().Set("ETag", `"`+artifact.SHA256+`"`)
	// attachment, never inline: opening an extension package in a tab is not a
	// thing a person can do anything with (doc §6).
	w.Header().Set("Content-Disposition", `attachment; filename="`+artifact.Name+`"`)

	// ServeContent sets Content-Length from the bytes, answers a HEAD with the
	// same headers and no body, and honours If-None-Match against the ETag
	// above (doc §6: 长度与真实嵌入字节一致).
	http.ServeContent(w, r, artifact.Name, time.Time{}, bytes.NewReader(data))
}
