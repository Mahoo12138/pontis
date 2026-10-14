package distribution

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
)

const testURL = "/downloads/extensions/chromium/v0.1.0.zip"

// staged builds a distribution directory the way the release script does: one
// package, one manifest, and the digest computed over the bytes it wrote.
func staged(t *testing.T, payload string, mutate func(map[string]any)) fstest.MapFS {
	t.Helper()
	sum := sha256.Sum256([]byte(payload))
	entry := map[string]any{
		"platform":           "chromium",
		"version":            "0.1.0",
		"file":               testURL,
		"name":               "pontis-chromium-v0.1.0.zip",
		"sha256":             hex.EncodeToString(sum[:]),
		"size_bytes":         len(payload),
		"manifest_version":   3,
		"min_server_version": "0.1.0",
		"supported_browsers": []string{"chrome"},
	}
	manifest := map[string]any{
		"release":      "v0.1.0",
		"commit":       "abc",
		"generated_at": "2026-10-14T00:00:00.000Z",
		"artifacts":    []any{entry},
	}
	if mutate != nil {
		mutate(manifest)
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	return fstest.MapFS{
		"artifacts/.gitkeep":                   &fstest.MapFile{Data: []byte("placeholder\n")},
		"artifacts/manifest.json":              &fstest.MapFile{Data: raw},
		"artifacts/pontis-chromium-v0.1.0.zip": &fstest.MapFile{Data: []byte(payload)},
	}
}

func TestLoadServesTheStagedPackage(t *testing.T) {
	src, err := LoadFrom(staged(t, "zip-bytes", nil))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if src.Empty() {
		t.Fatal("a staged artifact must not read as empty")
	}
	if got := src.Release(); got != "v0.1.0" {
		t.Errorf("Release() = %q", got)
	}
	if got := src.GeneratedAt(); got == "" {
		t.Error("GeneratedAt() is empty; the install page shows when the build ran")
	}

	artifact, ok := src.Lookup(testURL)
	if !ok {
		t.Fatalf("Lookup(%q) missed an artifact the manifest declares", testURL)
	}
	data, err := src.Bytes(artifact)
	if err != nil {
		t.Fatalf("bytes: %v", err)
	}
	if string(data) != "zip-bytes" {
		t.Errorf("served %q", data)
	}
}

func TestLookupIsTheManifestNotThePath(t *testing.T) {
	src, err := LoadFrom(staged(t, "zip-bytes", nil))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// Every one of these names a file that really is inside the embed, or would
	// with a different spelling. The whitelist is the only thing standing between
	// a request and those bytes, so none of them may resolve.
	for _, path := range []string{
		"/artifacts/pontis-chromium-v0.1.0.zip",
		"/downloads/extensions/chromium/v9.9.9.zip",
		"/downloads/extensions/firefox/v0.1.0.xpi",
		"/downloads/extensions/../../artifacts/manifest.json",
		"/downloads/",
		"/",
	} {
		if _, ok := src.Lookup(path); ok {
			t.Errorf("Lookup(%q) resolved; the manifest is the whitelist", path)
		}
	}
}

func TestCleanMatchesTheManifestForm(t *testing.T) {
	src, err := LoadFrom(staged(t, "zip-bytes", nil))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// The same artifact, reached through spellings a client or proxy may emit.
	// None of these open a second file: they all name the one the manifest
	// declares, which is the property that matters.
	for _, path := range []string{
		testURL,
		"//downloads/extensions/chromium/v0.1.0.zip",
		"/downloads/extensions/chromium/v0.1.0/../v0.1.0.zip",
		"/downloads/extensions/chromium/v0.1.0.zip/",
	} {
		if _, ok := src.Lookup(path); !ok {
			t.Errorf("Lookup(%q) missed the one declared URL", path)
		}
	}
}

func TestRejectsAManifestThatCannotBeTrusted(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"no platform", drop("platform")},
		{"no version", drop("version")},
		{"url outside the download namespace",
			set("file", "/artifacts/pontis-chromium-v0.1.0.zip")},
		{"name that walks out of the embed", set("name", "../secrets.txt")},
		{"name with a header-breaking character", set("name", `we"ird.zip`)},
		{"name that is not a package", set("name", "source.tar.gz")},
		{"digest that is not a sha256", set("sha256", "not-a-digest")},
		{"zero size", set("size_bytes", 0)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadFrom(staged(t, "zip-bytes", artifactEditor(tc.mutate)))
			if err == nil {
				t.Fatalf("a manifest with %s must fail the build, not a download", tc.name)
			}
			if !strings.Contains(err.Error(), "distribution:") {
				t.Errorf("error %q does not name its package", err)
			}
		})
	}
}

func TestRejectsTwoArtifactsSharingAURL(t *testing.T) {
	// One version URL is a promise that it always means one package.
	_, err := LoadFrom(staged(t, "zip-bytes", func(manifest map[string]any) {
		first := manifest["artifacts"].([]any)[0].(map[string]any)
		second := map[string]any{}
		for k, v := range first {
			second[k] = v
		}
		manifest["artifacts"] = []any{first, second}
	}))
	if err == nil {
		t.Fatal("duplicate download URLs must fail the build")
	}
}

func TestRejectsAMissingFile(t *testing.T) {
	fsys := staged(t, "zip-bytes", nil)
	delete(fsys, "artifacts/pontis-chromium-v0.1.0.zip")
	if _, err := LoadFrom(fsys); err == nil {
		t.Fatal("a manifest naming bytes the build did not stage must fail the build")
	}
}

func TestRefusesToServeBytesThatDoNotMatchTheDigest(t *testing.T) {
	// The size is what the manifest promised; the bytes are what the embed
	// carries. If those disagree the published SHA-256 is a lie, so the download
	// stops rather than handing out something a person will load as an extension.
	src, err := LoadFrom(staged(t, "zip-bytes", nil))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	artifact, _ := src.Lookup(testURL)
	fsys := staged(t, "zip-bytes", nil)
	fsys["artifacts/pontis-chromium-v0.1.0.zip"] = &fstest.MapFile{Data: []byte("tampered, longer payload")}
	tampered, err := LoadFrom(fsys)
	if err != nil {
		t.Fatalf("load after tampering: %v", err)
	}
	if _, err := tampered.Bytes(artifact); err == nil {
		t.Fatal("Bytes() accepted a payload that is not the one that was hashed")
	}
}

func TestUnstagedDistributionIsNotEmptyRatherThanBroken(t *testing.T) {
	// A checkout that has never run a release build embeds the placeholder only.
	src, err := LoadFrom(fstest.MapFS{
		"artifacts/.gitkeep": &fstest.MapFile{Data: []byte("placeholder\n")},
	})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !src.Empty() {
		t.Error("nothing is staged, so nothing may be listed")
	}
	if _, ok := src.Lookup(testURL); ok {
		t.Error("Lookup resolved against an empty manifest")
	}
	if len(src.Artifacts()) != 0 {
		t.Errorf("Artifacts() = %d, want 0", len(src.Artifacts()))
	}
}

func TestNilSourceIsInert(t *testing.T) {
	// Tests and any wiring that never loaded a release leave the field nil; the
	// endpoints must answer "nothing here" instead of panicking.
	var src *Source
	if !src.Empty() {
		t.Error("nil source should read as empty")
	}
	if _, ok := src.Lookup(testURL); ok {
		t.Error("nil source resolved a URL")
	}
	if src.Release() != "" || src.Commit() != "" || src.GeneratedAt() != "" {
		t.Error("nil source reported release metadata")
	}
}

func TestEmbeddedPlaceholderKeepsGoBuildWorking(t *testing.T) {
	// A fresh checkout has no staged package, so the embed needs at least one
	// committed file to match at all — otherwise `go build ./...` fails for
	// everyone who clones before their first release build.
	if _, err := fs.Stat(artifactsFS, "artifacts/.gitkeep"); err != nil {
		t.Errorf("artifacts/.gitkeep is what keeps `go build ./...` working: %v", err)
	}
}

// --- manifest editing helpers ---

func set(key string, value any) func(map[string]any) {
	return func(artifact map[string]any) { artifact[key] = value }
}

func drop(key string) func(map[string]any) {
	return func(artifact map[string]any) { delete(artifact, key) }
}

// artifactEditor adapts an edit of the first artifact entry to staged()'s
// whole-manifest mutator.
func artifactEditor(edit func(map[string]any)) func(map[string]any) {
	return func(manifest map[string]any) {
		artifact := manifest["artifacts"].([]any)[0].(map[string]any)
		edit(artifact)
	}
}
