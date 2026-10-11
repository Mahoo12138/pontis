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
	"strings"
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
	// token carries an encoded string, not a nested array. The second token
	// carries an expiry so the fixture shows both shapes of expires_at.
	restPOST(t, ts, token, "/api/v1/tokens", map[string]any{
		"name": "read-only", "scopes": []string{"bookmarks:read"},
		"space_scope": `["` + spaceID + `"]`,
	})
	restPOST(t, ts, token, "/api/v1/tokens", map[string]any{
		"name": "expiring", "scopes": []string{"bookmarks:read"},
		"space_scope": "all", "expires_in_days": 30,
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

	// Everything below writes: a second space, a publication, an import plan.
	// It runs only after the reads above have been captured, so the golden
	// bodies of the listing endpoints stay what a user sees on first opening
	// the page rather than what the fixture harness left behind.
	targetSpaceID := restPOST(t, ts, token, "/api/v1/spaces",
		map[string]string{"name": "Archive"})["id"].(string)
	userID, _ := restGET(t, ts, token, "/api/v1/auth/me")["id"].(string)
	// Kept unnormalized on purpose: the link carries the single-use secret the
	// password reset at the very end of this test consumes.
	resetLink := restPOST(t, ts, token,
		"/api/v1/admin/users/"+userID+"/reset-link", map[string]any{})
	publication := restPOST(t, ts, token, "/api/v1/publications", map[string]any{
		"space_id": spaceID, "title": "Reading list", "description": "Hand-picked",
		"tags": []string{"books"}, "visibility": "plaza",
	})
	publicationID, _ := publication["id"].(string)
	if publicationID == "" {
		t.Fatalf("publish returned no id: %v", publication)
	}
	exported := restPOST(t, ts, token, "/api/v1/spaces/"+spaceID+"/export",
		map[string]string{"format": "netscape_html"})
	content, _ := exported["content"].(string)
	if content == "" {
		t.Fatalf("export returned no content: %v", exported)
	}
	plan := restPOST(t, ts, token, "/api/v1/spaces/"+targetSpaceID+"/import/preview",
		map[string]string{"format": "netscape_html", "content": content})
	planID, _ := plan["plan_id"].(string)
	if planID == "" {
		t.Fatalf("preview returned no plan_id: %v", plan)
	}

	fixtures = append(fixtures,
		restFixture{"admin-users", restGET(t, ts, token, "/api/v1/admin/users")},
		restFixture{"reset-link", resetLink},
		restFixture{"plaza-publications", restGET(t, ts, token, "/api/v1/plaza/publications")},
		restFixture{"publication-detail", restGET(t, ts, token, "/api/v1/publications/"+publicationID)},
		// Applied into the space it came from: the merge path answers with the
		// counts the UI reports after a plaza import.
		restFixture{"publication-apply", restPOST(t, ts, token,
			"/api/v1/publications/"+publicationID+"/apply", map[string]any{
				"space_id": spaceID,
				"parent":   map[string]string{"type": "root", "key": "main"},
				"strategy": "merge",
			})},
		restFixture{"export", exported},
		restFixture{"import-preview", plan},
		restFixture{"import-apply", restPOST(t, ts, token,
			"/api/v1/spaces/"+targetSpaceID+"/import/apply", map[string]any{
				"plan_id":  planID,
				"parent":   map[string]string{"type": "root", "key": "main"},
				"strategy": "merge",
			})},
		// Moving the seeded folder carries its child, so `mapping` has more
		// than the trivial single-node case.
		restFixture{"space-transfer", restPOST(t, ts, token, "/api/v1/spaces/"+spaceID+"/transfers", map[string]any{
			"transfer_id": "fixture-transfer-1", "target_space_id": targetSpaceID, "node_id": folderID,
			"target_parent": map[string]string{"type": "root", "key": "main"},
		})},
	)

	// The last group is what a client reads from an action that answers once:
	// a login, a freshly issued device secret, a job it just queued. They run
	// after everything else because logging out and resetting the password end
	// the session this whole test rides on.
	login := restPOST(t, ts, token, "/api/v1/auth/login",
		map[string]string{"username": "alice", "password": "password123"})
	scheduleID := restFirstID(t, restGET(t, ts, token, "/api/v1/schedules"), "schedules")
	runNow := restPOST(t, ts, token, "/api/v1/schedules/"+scheduleID+"/run-now", map[string]any{})
	runJob, _ := runNow["id"].(string)
	if runJob == "" {
		t.Fatalf("run-now returned no job id: %v", runNow)
	}
	backupID := restFirstID(t, restGET(t, ts, token,
		"/api/v1/spaces/"+spaceID+"/backups"), "backups")
	// A plain create made right here is the one change the undo planner accepts
	// cleanly — cross-space transfers and imports answer NOT_UNDOABLE — and the
	// activity list is newest-first, so its first row is that create.
	restPOST(t, ts, token, "/api/v1/spaces/"+spaceID+"/nodes", map[string]any{
		"type": "bookmark", "title": "Undo me", "url": "https://undo.example",
		"parent": map[string]string{"type": "root", "key": "main"},
	})
	changeSetID := restFirstID(t, restGET(t, ts, token,
		"/api/v1/spaces/"+spaceID+"/activity"), "activity")
	resetToken := restResetToken(t, resetLink)

	fixtures = append(fixtures,
		restFixture{"login", login},
		restFixture{"profile-updated", restExpect(t, ts, token, http.StatusOK, http.MethodPatch,
			"/api/v1/auth/me", map[string]string{
				"display_name": "Alice Liddell", "email": "alice@liddell.example",
			})},
		restFixture{"settings", restGET(t, ts, token, "/api/v1/settings")},
		restFixture{"settings-updated", restExpect(t, ts, token, http.StatusOK, http.MethodPatch,
			"/api/v1/settings", map[string]any{"registration_mode": "closed",
				"default_locale": "zh-CN", "session_ttl_hours": 24, "max_spaces_per_user": 5})},
		restFixture{"device-register", restPOST(t, ts, token, "/api/v1/devices",
			map[string]string{"name": "Chrome@Work", "browser": "chrome", "platform": "linux"})},
		restFixture{"token-create", restPOST(t, ts, token, "/api/v1/tokens", map[string]any{
			"name": "ci", "scopes": []string{"bookmarks:read"}, "space_scope": "all",
		})},
		restFixture{"undo", restPOST(t, ts, token,
			"/api/v1/spaces/"+spaceID+"/changesets/"+changeSetID+"/undo", map[string]any{})},
		restFixture{"schedule-run-now", runNow},
		restFixture{"job-cancel", restPOST(t, ts, token,
			"/api/v1/jobs/"+runJob+"/cancel", map[string]any{})},
		// Retry is not captured: with no worker running in this harness, a
		// cancelled job stays `queued` (cancellation is a request the executor
		// honours, not a state flip), and only failed/cancelled jobs can be
		// re-enqueued. Its body is the same three keys the enqueue handler
		// writes, so `job-enqueue` pins that shape.
		restFixture{"job-enqueue", restPOST(t, ts, token, "/api/v1/admin/jobs",
			map[string]string{"type": "organizer.link_check", "space_id": spaceID})},
		restFixture{"admin-job-cancel", restPOST(t, ts, token,
			"/api/v1/admin/jobs/"+runJob+"/cancel", map[string]any{})},
		restFixture{"backup-restore", restPOST(t, ts, token,
			"/api/v1/spaces/"+spaceID+"/backups/"+backupID+"/restore", map[string]any{})},
		restFixture{"logout", restPOST(t, ts, token, "/api/v1/auth/logout", map[string]any{})},
		restFixture{"password-reset", restPOST(t, ts, token, "/api/v1/auth/reset",
			map[string]string{"token": resetToken, "new_password": "another-password"})},
	)

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

// restFirstID reads the id of the first row of a list body, which is how the
// harness reaches a resource it does not create itself (a schedule's job, the
// backup a restore will read).
func restFirstID(t *testing.T, body map[string]any, list string) string {
	t.Helper()
	rows, _ := body[list].([]any)
	if len(rows) == 0 {
		t.Fatalf("fixture list %q is empty: %v", list, body)
	}
	row, _ := rows[0].(map[string]any)
	id, _ := row["id"].(string)
	if id == "" {
		t.Fatalf("first %s has no id: %v", list, rows[0])
	}
	return id
}

// restResetToken unwraps the secret out of the admin link, exactly as a person
// clicking the link would.
func restResetToken(t *testing.T, link map[string]any) string {
	t.Helper()
	full, _ := link["reset_link"].(string)
	_, token, found := strings.Cut(full, "token=")
	if !found || token == "" {
		t.Fatalf("reset link carries no token: %v", link)
	}
	return token
}

var (
	uuidPattern      = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)
	timestampPattern = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?`)
	// A backup filename carries its creation time as `20060102-150405`, which
	// is not the RFC 3339 shape above and would otherwise make the fixture
	// depend on the wall clock.
	compactTimePat = regexp.MustCompile(`\d{8}-\d{6}`)
	// A reset link is a freshly signed opaque token hung off whatever origin the
	// test server happened to bind. What the client contract needs is "a /reset
	// URL carrying a token"; the token and the ephemeral port are not it.
	resetTokenPat = regexp.MustCompile(`token=[A-Za-z0-9_-]+`)
	loopbackPort  = regexp.MustCompile(`127\.0\.0\.1:\d+`)
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
			if k == "token" || k == "secret" {
				// A session token, a device credential and an API token secret
				// are freshly generated on every call, and only ever shown once.
				// The contract is that the answer carries the string, not which
				// string.
				if _, ok := t[k].(string); ok {
					t[k] = "one-time-secret"
					continue
				}
			}
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
	s = compactTimePat.ReplaceAllString(s, "20260101-000000")
	s = resetTokenPat.ReplaceAllString(s, "token=prs_the-reset-token")
	return loopbackPort.ReplaceAllString(s, "127.0.0.1:8080")
}
