package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"pontis/internal/organizer"
)

func TestDuplicatesDetection(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	// n1: exact duplicate of n2; n3/n4 differ by tracking params.
	nodes := []map[string]any{
		{"type": "bookmark", "title": "GH1", "url": "https://github.com", "parent": map[string]string{"type": "root", "key": "main"}},
		{"type": "bookmark", "title": "GH2", "url": "https://github.com", "parent": map[string]string{"type": "root", "key": "main"}},
		{"type": "bookmark", "title": "React", "url": "https://react.dev", "parent": map[string]string{"type": "root", "key": "main"}},
		{"type": "bookmark", "title": "React UT", "url": "https://react.dev/?utm_source=x", "parent": map[string]string{"type": "root", "key": "main"}},
	}
	for _, n := range nodes {
		if code, body := doJSON(t, "POST", root+"/nodes", h, n); code != http.StatusCreated {
			t.Fatalf("create %v = %d %v", n, code, body)
		}
	}

	code, body := doJSON(t, "GET", root+"/organizer/duplicates", h, nil)
	if code != http.StatusOK {
		t.Fatalf("duplicates = %d %v", code, body)
	}
	groups := body["groups"].([]any)
	if len(groups) != 2 {
		t.Fatalf("expected 2 groups (exact + suspected), got %v", groups)
	}
	kinds := map[string][]any{}
	for _, g := range groups {
		m := g.(map[string]any)
		kinds[m["kind"].(string)] = m["items"].([]any)
	}
	if len(kinds["exact"]) != 2 {
		t.Fatalf("exact group items = %v", kinds["exact"])
	}
	if len(kinds["suspected"]) != 2 {
		t.Fatalf("suspected group items = %v", kinds["suspected"])
	}
}

func TestLinkCheckRunWithFakeChecker(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID

	// Seed three bookmarks the fake checker classifies deterministically.
	for _, u := range []string{"https://ok.example/a", "https://gone.example/404", "https://slow.example/timeout"} {
		code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
			"type": "bookmark", "title": u, "url": u,
			"parent": map[string]string{"type": "root", "key": "main"},
		})
		if code != http.StatusCreated {
			t.Fatalf("seed %s = %d %v", u, code, body)
		}
	}

	// Swap in a fake checker: no network in tests.
	f.srv.Organizer = organizer.NewServiceWithChecker(f.srv.Library, func(ctx context.Context, url string) organizer.LinkOutcome {
		switch {
		case strings.Contains(url, "404"):
			return organizer.LinkOutcome{StatusClass: "client_4xx", HTTPStatus: 404, LatencyMS: 11}
		case strings.Contains(url, "timeout"):
			return organizer.LinkOutcome{StatusClass: "timeout", ErrorType: "timeout", LatencyMS: 8000}
		default:
			return organizer.LinkOutcome{StatusClass: "ok_2xx", HTTPStatus: 200, LatencyMS: 20}
		}
	})

	code, body := doJSON(t, "POST", root+"/organizer/link-check", h, nil)
	if code != http.StatusAccepted {
		t.Fatalf("run = %d %v", code, body)
	}
	if body["total"].(float64) != 3 {
		t.Fatalf("total = %v, want 3", body["total"])
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		code, body = doJSON(t, "GET", root+"/organizer/link-check/results", h, nil)
		if code != http.StatusOK {
			t.Fatalf("results = %d %v", code, body)
		}
		if int(body["done"].(float64)) == 3 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("link check did not finish: %v", body)
		}
		time.Sleep(30 * time.Millisecond)
	}
	results := body["results"].([]any)
	classes := map[string]int{}
	for _, rr := range results {
		classes[rr.(map[string]any)["status_class"].(string)]++
	}
	if classes["ok_2xx"] != 1 || classes["client_4xx"] != 1 || classes["timeout"] != 1 {
		t.Fatalf("unexpected class distribution %v", classes)
	}
}
