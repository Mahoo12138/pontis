package httpapi

import (
	"context"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/jobs"
	"pontis/internal/organizer"
	"pontis/internal/store/sqlite"
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

// --- link check: it is a job, and its work lives in the database (doc 12 §2) ---

// classifyChecker answers from the URL alone, so a test can assert on
// persisted results without ever reaching a network.
func classifyChecker() organizer.LinkChecker {
	return func(ctx context.Context, rawURL string) organizer.LinkOutcome {
		switch {
		case strings.Contains(rawURL, "404"):
			return organizer.LinkOutcome{StatusClass: "client_4xx", HTTPStatus: 404, LatencyMS: 11}
		case strings.Contains(rawURL, "timeout"):
			return organizer.LinkOutcome{StatusClass: "timeout", ErrorType: "timeout", LatencyMS: 8000}
		default:
			return organizer.LinkOutcome{StatusClass: "ok_2xx", HTTPStatus: 200, LatencyMS: 20}
		}
	}
}

// useChecker swaps in an organizer that reads and writes the same stores as
// the server's, but with a checker that never dials out.
func useChecker(t *testing.T, f *libraryFlow, checker organizer.LinkChecker) {
	t.Helper()
	f.srv.Organizer = organizer.NewServiceWithChecker(f.srv.Library,
		sqlite.NewLinkCheckStore(f.db), checker)
}

func seedBookmarks(t *testing.T, f *libraryFlow, h map[string]string, urls ...string) {
	t.Helper()
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID
	for _, u := range urls {
		code, body := doJSON(t, "POST", root+"/nodes", h, map[string]any{
			"type": "bookmark", "title": u, "url": u,
			"parent": map[string]string{"type": "root", "key": "main"},
		})
		if code != http.StatusCreated {
			t.Fatalf("seed %s = %d %v", u, code, body)
		}
	}
}

func linkCheckResults(t *testing.T, f *libraryFlow, h map[string]string) map[string]any {
	t.Helper()
	code, body := doJSON(t, "GET",
		f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/organizer/link-check/results", h, nil)
	if code != http.StatusOK {
		t.Fatalf("results = %d %v", code, body)
	}
	return body
}

// waitForDone polls the run until `want` bookmarks have results. Reading is
// concurrent with the worker writing, which is what the race detector is for.
func waitForDone(t *testing.T, f *libraryFlow, h map[string]string, want int) map[string]any {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		body := linkCheckResults(t, f, h)
		if int(body["done"].(float64)) >= want {
			return body
		}
		if time.Now().After(deadline) {
			t.Fatalf("link check stalled at %v, want %d done", body, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func startQueue(t *testing.T, srv *Server) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	srv.Jobs.Start(ctx)
	t.Cleanup(func() { srv.Jobs.Stop(); cancel() })
}

// findJob reads one job row straight from the queue.
func findJob(t *testing.T, srv *Server, id string) jobs.Job {
	t.Helper()
	list, err := srv.Jobs.List(t.Context(), 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, j := range list {
		if j.ID == id {
			return j
		}
	}
	t.Fatalf("job %s missing from the queue", id)
	return jobs.Job{}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func enqueueLinkCheck(t *testing.T, f *libraryFlow, h map[string]string) (string, int) {
	t.Helper()
	code, body := doJSON(t, "POST",
		f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/organizer/link-check", h, nil)
	if code != http.StatusAccepted {
		t.Fatalf("run link check = %d %v", code, body)
	}
	jobID, _ := body["job_id"].(string)
	total, _ := body["total"].(float64)
	if jobID == "" {
		t.Fatalf("no job id in %v", body)
	}
	return jobID, int(total)
}

// classesOf tallies the status classes of one run's results.
func classesOf(body map[string]any) map[string]int {
	out := map[string]int{}
	for _, rr := range body["results"].([]any) {
		out[rr.(map[string]any)["status_class"].(string)]++
	}
	return out
}

func TestLinkCheckIsAJobAndPersistsItsResults(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	seedBookmarks(t, f, h,
		"https://ok.example/a", "https://gone.example/404", "https://slow.example/timeout")
	useChecker(t, f, classifyChecker())

	jobID, total := enqueueLinkCheck(t, f, h)
	if total != 3 {
		t.Fatalf("total = %d, want the three bookmarks snapshotted", total)
	}

	// It is a queue job rather than a goroutine the organizer started: the
	// row exists, and it is still queued because nothing is running yet.
	job := findJob(t, f.srv, jobID)
	if job.Type != jobs.TypeLinkCheck || job.Status != jobs.StatusQueued || job.SpaceID != f.spaceID {
		t.Fatalf("job = %+v, want a queued organizer.link_check for the space", job)
	}

	startQueue(t, f.srv)
	body := waitForDone(t, f, h, 3)
	classes := classesOf(body)
	if classes["ok_2xx"] != 1 || classes["client_4xx"] != 1 || classes["timeout"] != 1 {
		t.Fatalf("unexpected class distribution %v", classes)
	}
	if finished, _ := body["finished_at"].(string); finished == "" {
		t.Error("a completed run has no finished_at")
	}
	waitForJobStatus(t, f.srv, jobID, jobs.StatusSucceeded)

	// The results are server state: a brand new organizer over the same
	// database replays them without checking anything again.
	restarted := organizer.NewService(sqlite.NewLibraryStore(f.db),
		sqlite.NewLinkCheckStore(f.db), organizer.Outbound{})
	run, ok, err := restarted.LinkResults(t.Context(), canonical.SpaceID(f.spaceID))
	if !ok || err != nil {
		t.Fatalf("fresh reader = ok %v err %v", ok, err)
	}
	if run.JobID != jobID || run.Done != 3 || len(run.Results) != 3 {
		t.Fatalf("fresh reader = %+v, want the three persisted results of %s", run, jobID)
	}
}

// TestLinkCheckResumesRemainingWorkAfterTheWorkerDies is the restart half of
// the checkpoint: the checks in flight when the worker went away are neither
// lost results nor invented ones, and the new process does not redo what was
// finished.
func TestLinkCheckResumesRemainingWorkAfterTheWorkerDies(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	const fast, held2, held3 = "https://fast.example/1", "https://hold.example/2", "https://hold.example/3"
	seedBookmarks(t, f, h, fast, held2, held3)

	var mu sync.Mutex
	var phase1, phase2 []string
	useChecker(t, f, func(ctx context.Context, rawURL string) organizer.LinkOutcome {
		if rawURL == fast {
			mu.Lock()
			phase1 = append(phase1, rawURL)
			mu.Unlock()
			return organizer.LinkOutcome{StatusClass: "ok_2xx", HTTPStatus: 200}
		}
		// The other two stay in flight until their job is taken away.
		<-ctx.Done()
		return organizer.LinkOutcome{StatusClass: "timeout", ErrorType: "timeout"}
	})

	jobID, _ := enqueueLinkCheck(t, f, h)
	startQueue(t, f.srv)
	waitForDone(t, f, h, 1)

	// Simulated crash: this worker stops with two checks unresolved.
	f.srv.Jobs.Stop()

	// A new process over the same database finishes the job.
	resume := organizer.NewServiceWithChecker(f.srv.Library, sqlite.NewLinkCheckStore(f.db),
		func(ctx context.Context, rawURL string) organizer.LinkOutcome {
			mu.Lock()
			phase2 = append(phase2, rawURL)
			mu.Unlock()
			return organizer.LinkOutcome{StatusClass: "ok_2xx", HTTPStatus: 200}
		})
	queue := jobs.NewService(sqlite.NewJobStore(f.db), 1)
	if err := queue.Register(jobs.TypeLinkCheck, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return resume.CheckRun(ctx, job, report)
	}); err != nil {
		t.Fatalf("register resume handler: %v", err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(func() { queue.Stop(); cancel() })
	queue.Start(ctx)

	body := waitForDone(t, f, h, 3)
	if classesOf(body)["ok_2xx"] != 3 {
		t.Fatalf("resumed run = %v, want three ok results", body)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(phase1) != 1 || phase1[0] != fast {
		t.Fatalf("first worker checked %v, want only %s", phase1, fast)
	}
	sort.Strings(phase2)
	want := []string{held2, held3}
	if !equalStrings(phase2, want) {
		t.Fatalf("the restarted worker checked %v, want the two items left pending %v", phase2, want)
	}

	// Nothing was recorded for the cancelled checks: an unresolved item is
	// still pending work, not a false timeout.
	var unresolved int
	if err := f.db.QueryRowContext(t.Context(), `
		SELECT COUNT(*) FROM link_check_items
		WHERE job_id = ? AND status_class = 'timeout'`, jobID).Scan(&unresolved); err != nil {
		t.Fatal(err)
	}
	if unresolved != 0 {
		t.Fatalf("%d items hold a timeout invented by a cancelled check", unresolved)
	}
}

// TestLinkCheckCancellationStopsFurtherRequests proves the run follows its
// job: cancelling reaches the checks, not just the progress poller.
func TestLinkCheckCancellationStopsFurtherRequests(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	seedBookmarks(t, f, h,
		"https://a.example/1", "https://b.example/2", "https://c.example/3")

	var issued atomic.Int64
	var gate sync.Mutex // one check at a time, so later items are visibly unstarted
	useChecker(t, f, func(ctx context.Context, rawURL string) organizer.LinkOutcome {
		gate.Lock()
		defer gate.Unlock()
		if ctx.Err() != nil {
			// Never reached the network.
			return organizer.LinkOutcome{}
		}
		issued.Add(1)
		<-ctx.Done()
		return organizer.LinkOutcome{StatusClass: "timeout", ErrorType: "timeout"}
	})

	startQueue(t, f.srv)
	jobID, _ := enqueueLinkCheck(t, f, h)
	waitForJobStatus(t, f.srv, jobID, jobs.StatusRunning)

	deadline := time.Now().Add(5 * time.Second)
	for issued.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if issued.Load() == 0 {
		t.Fatal("no check was ever issued")
	}

	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/"+jobID+"/cancel", h, nil)
	if code != http.StatusOK {
		t.Fatalf("cancel = %d %v", code, body)
	}
	waitForJobStatus(t, f.srv, jobID, jobs.StatusCancelled)

	// The checks that had not started stay unstarted.
	if got := issued.Load(); got != 1 {
		t.Errorf("checker issued %d requests after cancellation, want the 1 already in flight", got)
	}
	// A cancelled run leaves its items pending instead of filing answers.
	if done := linkCheckResults(t, f, h)["done"].(float64); done != 0 {
		t.Errorf("cancelled run recorded %d results, want 0", int(done))
	}
}

// TestTwoLinkCheckRunsOfOneSpaceKeepTheirResultsApart is the map-replacement
// bug: the page must never observe another scan through the space's entry.
func TestTwoLinkCheckRunsOfOneSpaceKeepTheirResultsApart(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	seedBookmarks(t, f, h, "https://ok.example/1", "https://ok.example/2")
	useChecker(t, f, classifyChecker())
	startQueue(t, f.srv)

	firstID, _ := enqueueLinkCheck(t, f, h)
	body := waitForDone(t, f, h, 2)
	if body["job_id"] != firstID {
		t.Fatalf("latest run = %v, want %s", body["job_id"], firstID)
	}
	if classesOf(body)["ok_2xx"] != 2 {
		t.Fatalf("first run = %v", body)
	}

	// The world changes between the runs, and the second checker disagrees.
	seedBookmarks(t, f, h, "https://gone.example/3")
	useChecker(t, f, func(ctx context.Context, rawURL string) organizer.LinkOutcome {
		return organizer.LinkOutcome{StatusClass: "client_4xx", HTTPStatus: 404}
	})
	secondID, total := enqueueLinkCheck(t, f, h)
	if total != 3 {
		t.Fatalf("second run total = %d, want 3", total)
	}
	body = waitForDone(t, f, h, 3)
	if body["job_id"] != secondID {
		t.Fatalf("latest run = %v, want the newer %s", body["job_id"], secondID)
	}
	if classesOf(body)["client_4xx"] != 3 {
		t.Fatalf("second run = %v", body)
	}

	// The first run's own rows still carry the first run's findings.
	rows, err := f.db.QueryContext(t.Context(),
		`SELECT status_class FROM link_check_items WHERE job_id = ? ORDER BY node_id`, firstID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var firstClasses []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		firstClasses = append(firstClasses, c)
	}
	if !equalStrings(firstClasses, []string{"ok_2xx", "ok_2xx"}) {
		t.Fatalf("run %s items = %v, want its own two ok_2xx results", firstID, firstClasses)
	}
}
