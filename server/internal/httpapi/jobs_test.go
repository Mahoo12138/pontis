package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"pontis/internal/canonical"
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

	// Register a no-op handler and enqueue a backup job for alice.
	_, me := doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", adminHeader, nil)
	aliceID := me["id"].(string)
	f.srv.Jobs.Register(jobs.TypeBackupCreate, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return nil
	})
	job, err := f.srv.Jobs.Enqueue(t.Context(), jobs.TypeBackupCreate, canonical.UserID(aliceID), f.spaceID, "")
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
	if entry["id"] != job.ID || entry["type"] != "backup.create" || entry["status"] != "queued" {
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

func TestAdminJobRetry(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	adminHeader := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bobHeader := map[string]string{"Authorization": "Bearer " + f.bobToken}

	// A handler that always fails fatally: after the queue runs, the job is
	// failed and can be retried (doc 13 §4.2 ops path).
	f.srv.Jobs.Register(jobs.TypeBackupCreate, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return fmt.Errorf("%w: simulated failure", jobs.FatalError)
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	f.srv.Jobs.Start(ctx)
	defer f.srv.Jobs.Stop()

	_, me := doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", adminHeader, nil)
	aliceID := me["id"].(string)
	job, err := f.srv.Jobs.Enqueue(t.Context(), jobs.TypeBackupCreate, canonical.UserID(aliceID), f.spaceID, "")
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	waitForJobStatus(t, f.srv, job.ID, jobs.StatusFailed)

	// Bob cannot retry.
	code, _ := doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/"+job.ID+"/retry", bobHeader, nil)
	if code != http.StatusForbidden {
		t.Fatalf("bob retry = %d", code)
	}

	// Admin retry re-enqueues a fresh queued job.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/"+job.ID+"/retry", adminHeader, nil)
	if code != http.StatusAccepted {
		t.Fatalf("retry = %d %v", code, body)
	}
	retriedID := body["id"].(string)
	if retriedID == job.ID {
		t.Fatal("retry reused the original job id")
	}
	waitForJobStatus(t, f.srv, retriedID, jobs.StatusFailed)

	// A long-running job occupies the running state; retry must conflict
	// until it reaches a terminal state (doc 13 §4.2).
	release := make(chan struct{})
	f.srv.Jobs.Register(jobs.TypeMailSend, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		<-release
		return nil
	})
	longJob, err := f.srv.Jobs.Enqueue(t.Context(), jobs.TypeMailSend, canonical.UserID(aliceID), "", "")
	if err != nil {
		t.Fatalf("enqueue long job: %v", err)
	}
	waitForJobStatus(t, f.srv, longJob.ID, jobs.StatusRunning)
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/"+longJob.ID+"/retry", adminHeader, nil)
	if code != http.StatusConflict || errCode(t, body) != "JOB_NOT_RETRYABLE" {
		t.Fatalf("running job retry = %d %v", code, body)
	}
	close(release)

	// Unknown job -> 404.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/admin/jobs/does-not-exist/retry", adminHeader, nil)
	if code != http.StatusNotFound || errCode(t, body) != "JOB_NOT_FOUND" {
		t.Fatalf("unknown retry = %d %v", code, body)
	}
}

// waitForJobStatus polls the admin listing until the job reaches status.
func waitForJobStatus(t *testing.T, srv *Server, id string, status jobs.Status) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		list, err := srv.Jobs.List(t.Context(), 50)
		if err != nil {
			t.Fatal(err)
		}
		for _, j := range list {
			if j.ID == id && j.Status == status {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s never reached %s", id, status)
}
