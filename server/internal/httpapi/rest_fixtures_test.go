package httpapi

// Golden REST fixtures.
//
// The Web app reads these bodies through @pontis/api, which so far only
// asserted their shape with a TypeScript `as` — no runtime check, so a null
// where the client iterates an array would surface as a blank page in a
// browser, not as a failing test. One artifact has to bind both sides, so the
// real router (real handlers, real SQLite, real encoding/json) writes the
// bodies it emits here, and packages/api validates its declared types against
// the same files.
//
// Volatile values are normalized so the files stay byte-stable: every UUID
// becomes `id-1`, `id-2`, ... in first appearance order, which preserves
// cross-references such as a node's parent_id, every timestamp becomes one
// fixed value, and the payload byte size a backup reports is pinned. Object
// keys are written in the order encoding/json sorts them. Field names,
// optionality, null-vs-[] and number-vs-string are left exactly as the server
// emitted them — that is the contract.

import (
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"testing"
)

var updateRESTFixtures = flag.Bool("update-rest-fixtures", false, "rewrite the golden REST fixtures")

const restFixtureDir = "../../../fixtures/api"

type restFixture struct {
	name  string
	value any
}

func TestGoldenRESTFixtures(t *testing.T) {
	_, ts := newTestServer(t)

	token := restBootstrap(t, ts)

	// One space with a folder holding one bookmark: the shape the explorer
	// renders, plus the reads that hang off the same space.
	spaceID := restPOST(t, ts, token, "/api/v1/spaces", map[string]string{"name": "Personal"})["id"].(string)
	folderID := restPOST(t, ts, token, "/api/v1/spaces/"+spaceID+"/nodes", map[string]any{
		"type": "folder", "title": "Reading", "url": "",
		"parent": map[string]string{"type": "root", "key": "main"},
	})["id"].(string)
	restPOST(t, ts, token, "/api/v1/spaces/"+spaceID+"/nodes", map[string]any{
		"type": "bookmark", "title": "Example", "url": "https://example.com",
		"parent": map[string]string{"type": "node", "id": folderID},
	})

	// A device is registered and binds the space, so the credential surfaces
	// have at least one row each.
	device := restPOST(t, ts, token, "/api/v1/devices", map[string]string{
		"name": "Chrome@Home", "browser": "chrome", "platform": "macos",
	})
	deviceToken, _ := device["token"].(string)
	if deviceToken == "" {
		t.Fatalf("device registration returned no token: %v", device)
	}
	restPOST(t, ts, deviceToken, "/api/v1/device/bindings", map[string]string{"space_id": spaceID})

	// space_scope is either "all" or a JSON array of ids, so a single-space
	// token carries an encoded string, not a nested array.
	restPOST(t, ts, token, "/api/v1/tokens", map[string]any{
		"name": "read-only", "scopes": []string{"bookmarks:read"},
		"space_scope": `["` + spaceID + `"]`,
	})
	restPOST(t, ts, token, "/api/v1/spaces/"+spaceID+"/backups", map[string]any{})

	// One schedule and one queued job, so the job/task rows carry their
	// optional fields instead of the fixtures only ever proving `[]`.
	restPOST(t, ts, token, "/api/v1/schedules", map[string]any{
		"type": "organizer.link_check", "kind": "daily", "time_of_day": "02:00",
		"timezone": "Asia/Shanghai", "space_id": spaceID,
	})
	restPOST(t, ts, token, "/api/v1/admin/jobs", map[string]any{
		"type": "organizer.link_check", "space_id": spaceID,
	})

	// Captured in this order on purpose: a fixture must not depend on Go
	// evaluating a map literal in any particular sequence.
	fixtures := []restFixture{
		{"meta", restGET(t, ts, token, "/api/v1/meta")},
		{"me", restGET(t, ts, token, "/api/v1/auth/me")},
		{"spaces", restGET(t, ts, token, "/api/v1/spaces")},
		{"nodes", restGET(t, ts, token, "/api/v1/spaces/"+spaceID+"/nodes")},
		{"root-slots", restGET(t, ts, token, "/api/v1/spaces/"+spaceID+"/root-slots")},
		{"activity", restGET(t, ts, token, "/api/v1/spaces/"+spaceID+"/activity")},
		{"device-overview", restGET(t, ts, token, "/api/v1/devices/overview")},
		{"bindings", restGET(t, ts, deviceToken, "/api/v1/device/bindings")},
		{"tokens", restGET(t, ts, token, "/api/v1/tokens")},
		{"backups", restGET(t, ts, token, "/api/v1/spaces/"+spaceID+"/backups")},
		{"jobs", restGET(t, ts, token, "/api/v1/admin/jobs")},
		{"schedules", restGET(t, ts, token, "/api/v1/schedules")},
		{"tasks", restGET(t, ts, token, "/api/v1/tasks")},
		{"link-check-results", restGET(t, ts, token,
			"/api/v1/spaces/"+spaceID+"/organizer/link-check/results")},
		{"duplicates", restGET(t, ts, token, "/api/v1/spaces/"+spaceID+"/organizer/duplicates")},

		// A space with no nodes is the first-run state, and `nodes` must
		// still be an array — this is the class of bug that broke the
		// extension's /sync consumer.
		{"nodes-empty", restGET(t, ts, token,
			"/api/v1/spaces/"+restPOST(t, ts, token, "/api/v1/spaces",
				map[string]string{"name": "Empty"})["id"].(string)+"/nodes")},

		// Errors travel in one envelope; both of these are rejections a real
		// client can hit without misbehaving.
		{"error-validation", restExpect(t, ts, token, http.StatusBadRequest,
			http.MethodPost, "/api/v1/spaces", map[string]string{"name": ""})},
		{"error-not-found", restExpect(t, ts, token, http.StatusNotFound,
			http.MethodGet, "/api/v1/spaces/0198c0de-7000-7000-8000-00000000dead/nodes", nil)},
	}

	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			b, err := json.MarshalIndent(normalizeValue(f.value, map[string]string{}), "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			b = append(b, '\n')

			path := filepath.Join(restFixtureDir, f.name+".json")
			if *updateRESTFixtures {
				if err := os.MkdirAll(restFixtureDir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, b, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}

			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture (run go test -run TestGoldenRESTFixtures -update-rest-fixtures): %v", err)
			}
			if string(want) != string(b) {
				t.Fatalf("the REST body drifted from the golden fixture:\n got %s\nwant %s", b, want)
			}
		})
	}
}

// restBootstrap initializes the instance and returns an admin session token.
func restBootstrap(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	code, body := doJSON(t, http.MethodPost, ts.URL+"/api/v1/auth/setup", nil,
		map[string]string{"username": "alice", "password": "password123", "email": "alice@example.com"})
	if code != http.StatusCreated {
		t.Fatalf("setup = %d %v", code, body)
	}
	code, body = doJSON(t, http.MethodPost, ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "alice", "password": "password123"})
	if code != http.StatusOK {
		t.Fatalf("login = %d %v", code, body)
	}
	token, _ := body["token"].(string)
	if token == "" {
		t.Fatalf("login returned no token: %v", body)
	}
	return token
}

func restPOST(t *testing.T, ts *httptest.Server, token, path string, body any) map[string]any {
	t.Helper()
	code, out := doJSON(t, http.MethodPost, ts.URL+path, bearer(token), body)
	if code < 200 || code > 299 {
		t.Fatalf("POST %s = %d %v", path, code, out)
	}
	return out
}

func restGET(t *testing.T, ts *httptest.Server, token, path string) map[string]any {
	t.Helper()
	code, out := doJSON(t, http.MethodGet, ts.URL+path, bearer(token), nil)
	if code != http.StatusOK {
		t.Fatalf("GET %s = %d %v", path, code, out)
	}
	return out
}

func restExpect(t *testing.T, ts *httptest.Server, token string, wantStatus int,
	method, path string, body any) map[string]any {
	t.Helper()
	code, out := doJSON(t, method, ts.URL+path, bearer(token), body)
	if code != wantStatus {
		t.Fatalf("%s %s = %d, want %d: %v", method, path, code, wantStatus, out)
	}
	return out
}

var (
	uuidPattern      = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	timestampPattern = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`)
	// A backup filename carries its creation time as `20060102-150405`, which
	// is not the RFC 3339 shape above and would otherwise make the fixture
	// depend on the wall clock.
	compactTimePat = regexp.MustCompile(`\d{8}-\d{6}`)
)

const fixedTimestamp = "2026-01-01T00:00:00Z"

// normalizeValue replaces UUIDs and timestamps inside a decoded body. Keys are
// visited in sorted order so the id-N numbering does not depend on Go's map
// iteration order.
func normalizeValue(v any, seen map[string]string) any {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if k == "size_bytes" {
				// A backup's size is the size of a payload that embeds
				// RFC 3339Nano timestamps, and Go trims their trailing zeros,
				// so the byte count moves by a couple of bytes with the clock.
				// The contract is "a number", not this number.
				if _, ok := t[k].(float64); ok {
					t[k] = float64(1024)
					continue
				}
			}
			t[k] = normalizeValue(t[k], seen)
		}
		return t
	case []any:
		for i, item := range t {
			t[i] = normalizeValue(item, seen)
		}
		return t
	case string:
		return normalizeString(t, seen)
	default:
		return v
	}
}

func normalizeString(s string, seen map[string]string) string {
	s = uuidPattern.ReplaceAllStringFunc(s, func(match string) string {
		if id, ok := seen[match]; ok {
			return id
		}
		id := "id-" + strconv.Itoa(len(seen)+1)
		seen[match] = id
		return id
	})
	s = timestampPattern.ReplaceAllString(s, fixedTimestamp)
	return compactTimePat.ReplaceAllString(s, "20260101-000000")
}
