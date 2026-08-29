package httpapi

import (
	"context"
	"net/http"
	"testing"

	"pontis/internal/jobs"
)

func TestJobsAdminGatingAndListing(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	adminHeader := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bobHeader := map[string]string{"Authorization": "Bearer " + f.bobToken}

	// Bob (plain user) cannot list or cancel.
	code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/admin/jobs", bobHeader, nil)
	if code != http.StatusForbidden || errCode(t, body) != "ADMIN_REQUIRED" {
		t.Fatalf("bob list jobs = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/nope/cancel", bobHeader, nil)
	if code != http.StatusForbidden {
		t.Fatalf("bob cancel = %d %v", code, body)
	}

	// Register a no-op handler and enqueue a backup job.
	f.srv.Jobs.Register(jobs.TypeBackup, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return nil
	})
	job, err := f.srv.Jobs.Enqueue(t.Context(), jobs.TypeBackup, "u1", f.spaceID, "")
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	// The listing projects owner display name and space name.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/admin/jobs", adminHeader, nil)
	if code != http.StatusOK {
		t.Fatalf("list = %d %v", code, body)
	}
	list := body["jobs"].([]any)
	if len(list) != 1 {
		t.Fatalf("expected 1 job, got %v", list)
	}
	entry := list[0].(map[string]any)
	if entry["id"] != job.ID || entry["type"] != "backup" || entry["status"] != "queued" {
		t.Fatalf("job entry wrong: %v", entry)
	}

	// Cancel flags the job.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/"+job.ID+"/cancel", adminHeader, nil)
	if code != http.StatusOK {
		t.Fatalf("cancel = %d %v", code, body)
	}
	latest, err := f.srv.Jobs.List(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if !latest[0].CancelRequested {
		t.Fatalf("cancel flag not set: %+v", latest[0])
	}

	// Unknown job cancels to 404.
	code, _ = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/does-not-exist/cancel", adminHeader, nil)
	if code != http.StatusNotFound {
		t.Fatalf("unknown job cancel = %d", code)
	}
}
