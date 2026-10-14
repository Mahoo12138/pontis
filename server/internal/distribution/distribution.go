// Package distribution carries the released browser-extension package inside
// the server binary, and answers one question for a client: what may be
// downloaded from this instance, and with what digest.
//
// The bytes are staged at build time (scripts/stage-distribution.mjs) and read
// from the embed here. Nothing in this package builds a path out of a request:
// the compiled manifest is the whitelist, and a URL it does not list does not
// exist as far as this server is concerned (distribution doc §6, §13).
package distribution

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strings"
)

// The placeholder in artifacts is what keeps `go build ./...` working in a
// checkout that has never run a release build; `all:` makes go:embed see it.
//
//go:embed all:artifacts
var artifactsFS embed.FS

const (
	artifactsDir = "artifacts"
	manifestFile = "manifest.json"

	// downloadPrefix is the URL namespace a release artifact lives under. One
	// version-pinned path per package, forever (doc §6: 同一版本的下载 URL 必须
	// 不可变).
	downloadPrefix = "/downloads/extensions/"
)

// fileNamePattern is what a staged package may be called. The name reaches two
// places that make a malformed one dangerous: the embedded filesystem path, and
// the Content-Disposition header. Anything outside this pattern is rejected
// when the manifest loads rather than when a client asks.
var fileNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$`)

// Artifact is one downloadable package. `file` is the public download URL and
// `name` the file inside the embedded directory; the two are kept apart so no
// handler ever resolves a request path against the filesystem.
//
// Platform and variant together say what a package is for: the same Chromium
// build ships as a sync package and as a new-tab takeover package, and a client
// can only pick its own update by matching both.
type Artifact struct {
	Platform          string   `json:"platform"`
	Variant           string   `json:"variant"`
	Version           string   `json:"version"`
	URL               string   `json:"file"`
	Name              string   `json:"name"`
	SHA256            string   `json:"sha256"`
	SizeBytes         int64    `json:"size_bytes"`
	ManifestVersion   int      `json:"manifest_version"`
	MinServerVersion  string   `json:"min_server_version"`
	SupportedBrowsers []string `json:"supported_browsers"`
}

// build is the staged manifest, written by the build script.
type build struct {
	Release     string     `json:"release"`
	Commit      string     `json:"commit"`
	GeneratedAt string     `json:"generated_at"`
	Artifacts   []Artifact `json:"artifacts"`
}

// Source is a loaded, validated set of release artifacts.
type Source struct {
	files       fs.FS
	release     string
	commit      string
	generatedAt string
	byURL       map[string]Artifact
	order       []Artifact
}

// Load reads the artifacts embedded in this binary.
//
// A checkout that has never run a release build embeds only the placeholder,
// which is an empty set rather than a broken one: the server still starts and
// the download API reports that this instance carries no package, the same way
// an unstaged web dist answers with a hint instead of an empty page.
func Load() (*Source, error) {
	return LoadFrom(artifactsFS)
}

// LoadFrom reads a staged distribution directory from any filesystem. Load
// points it at the embed; a test points it at a fixture and exercises the same
// validation the release path does.
func LoadFrom(fsys fs.FS) (*Source, error) {
	raw, err := fs.ReadFile(fsys, path.Join(artifactsDir, manifestFile))
	if err != nil {
		// No manifest at all is the unstaged case, not a corrupt one.
		if errors.Is(err, fs.ErrNotExist) {
			return Empty(), nil
		}
		return nil, err
	}

	var b build
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("distribution: %s is not readable: %w", manifestFile, err)
	}

	src := &Source{
		files:       fsys,
		release:     b.Release,
		commit:      b.Commit,
		generatedAt: b.GeneratedAt,
		byURL:       map[string]Artifact{},
	}
	for _, a := range b.Artifacts {
		if err := src.add(fsys, a); err != nil {
			return nil, err
		}
	}
	return src, nil
}

// Empty is a source with nothing to hand out.
func Empty() *Source {
	return &Source{byURL: map[string]Artifact{}}
}

func (s *Source) add(fsys fs.FS, a Artifact) error {
	switch {
	case a.Platform == "":
		return fmt.Errorf("distribution: artifact %q declares no platform", a.URL)
	case a.Variant == "":
		return fmt.Errorf("distribution: artifact %q declares no variant", a.URL)
	case a.Version == "":
		return fmt.Errorf("distribution: artifact %q declares no version", a.URL)
	case !strings.HasPrefix(a.URL, downloadPrefix):
		return fmt.Errorf("distribution: artifact %q must live under %s", a.URL, downloadPrefix)
	case !fileNamePattern.MatchString(a.Name):
		return fmt.Errorf("distribution: artifact %q names an unsafe file %q", a.URL, a.Name)
	case len(a.SHA256) != 64:
		return fmt.Errorf("distribution: artifact %q carries a sha256 that is not 64 hex characters", a.URL)
	case a.SizeBytes <= 0:
		return fmt.Errorf("distribution: artifact %q declares %d bytes", a.URL, a.SizeBytes)
	}
	if _, dup := s.byURL[a.URL]; dup {
		// Two packages behind one URL would make the "immutable version URL"
		// promise a coin flip.
		return fmt.Errorf("distribution: two artifacts share the URL %q", a.URL)
	}
	for _, held := range s.order {
		// A client selects its own update by platform and variant, so two
		// artifacts claiming the same pair leave it with no answer that is not
		// a guess.
		if held.Platform == a.Platform && held.Variant == a.Variant {
			return fmt.Errorf("distribution: two %s/%s artifacts are staged; a client cannot tell them apart",
				a.Platform, a.Variant)
		}
	}
	// Checked at boot rather than at request time: a manifest that names a file
	// the build did not stage is a broken release, and the operator should hear
	// it once from the log instead of one download at a time.
	if _, err := fs.Stat(fsys, path.Join(artifactsDir, a.Name)); err != nil {
		return fmt.Errorf("distribution: artifact %q names %q, which is not embedded: %w", a.URL, a.Name, err)
	}
	s.byURL[a.URL] = a
	s.order = append(s.order, a)
	return nil
}

// Empty reports whether this instance carries no downloadable package.
func (s *Source) Empty() bool {
	return s == nil || len(s.order) == 0
}

// Release is the distribution batch identifier the build stamped, empty when
// the build had no tag to record.
func (s *Source) Release() string {
	if s == nil {
		return ""
	}
	return s.release
}

// Commit is the source revision the packages were built from.
func (s *Source) Commit() string {
	if s == nil {
		return ""
	}
	return s.commit
}

// GeneratedAt is when the staging ran.
func (s *Source) GeneratedAt() string {
	if s == nil {
		return ""
	}
	return s.generatedAt
}

// Artifacts lists the packages in the order the manifest declares them.
func (s *Source) Artifacts() []Artifact {
	if s == nil {
		return nil
	}
	out := make([]Artifact, len(s.order))
	copy(out, s.order)
	return out
}

// Lookup resolves a request path against the compiled whitelist. This is the
// only way a URL becomes a file, and it consults nothing but the manifest.
func (s *Source) Lookup(urlPath string) (Artifact, bool) {
	if s == nil {
		return Artifact{}, false
	}
	a, ok := s.byURL[clean(urlPath)]
	return a, ok
}

// Bytes returns the embedded package. Its length is what the manifest promised,
// checked here because the digest the API publishes is worthless if the served
// bytes are not the ones that were hashed.
func (s *Source) Bytes(a Artifact) ([]byte, error) {
	data, err := fs.ReadFile(s.files, path.Join(artifactsDir, a.Name))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != a.SizeBytes {
		return nil, fmt.Errorf("distribution: %s is %d bytes, the manifest promised %d",
			a.URL, len(data), a.SizeBytes)
	}
	return data, nil
}

func clean(urlPath string) string {
	// path.Clean collapses the `..` and duplicate slashes a client (or a proxy)
	// may have left in, so the whitelist match is against one canonical form.
	c := path.Clean("/" + urlPath)
	if c == "/." {
		return "/"
	}
	return c
}
