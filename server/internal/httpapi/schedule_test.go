package httpapi

import (
	"context"
	"net/http"
	"testing"

	"pontis/internal/canonical"
	"pontis/internal/jobs"
)

func TestScheduleCRUDOwnerScoped(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bobH := map[string]string{"Authorization": "Bearer " + f.bobToken}
	base := f.ts.URL + "/api/v1/schedules"

	// System-only types are rejected by the closed registry.
	code, body := doJSON(t, "POST", base, h, map[string]any{
		"type": "journal.gc", "kind": "daily", "time_of_day": "03:00", "timezone": "Asia/Shanghai",
	})
	if code != http.StatusBadRequest || errCode(t, body) != "TASK_NOT_SCHEDULABLE" {
		t.Fatalf("system type create = %d %v", code, body)
	}

	// A user task without a space is rejected.
	code, body = doJSON(t, "POST", base, h, map[string]any{
		"type": "backup.create", "kind": "daily", "time_of_day": "03:00", "timezone": "Asia/Shanghai",
	})
	if code != http.StatusBadRequest || errCode(t, body) != "SPACE_REQUIRED" {
		t.Fatalf("no-space create = %d %v", code, body)
	}

	// A foreign space is rejected.
	code, body = doJSON(t, "POST", base, h, map[string]any{
		"type": "backup.create", "kind": "daily", "time_of_day": "03:00",
		"timezone": "Asia/Shanghai", "space_id": "00000000-0000-7000-8000-000000000000",
	})
	if code != http.StatusNotFound || errCode(t, body) != "SCHEDULE_NOT_FOUND" {
		t.Fatalf("foreign-space create = %d %v", code, body)
	}

	// Validation errors map to stable codes.
	code, body = doJSON(t, "POST", base, h, map[string]any{
		"type": "backup.create", "kind": "weekly", "weekday": 9,
		"time_of_day": "03:00", "timezone": "Asia/Shanghai", "space_id": f.spaceID,
	})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_WEEKDAY" {
		t.Fatalf("weekday validation = %d %v", code, body)
	}
	code, body = doJSON(t, "POST", base, h, map[string]any{
		"type": "backup.create", "kind": "daily", "time_of_day": "03:00", "timezone": "Mars/Olympus",
		"space_id": f.spaceID,
	})
	if code != http.StatusBadRequest || errCode(t, body) != "INVALID_TIMEZONE" {
		t.Fatalf("timezone validation = %d %v", code, body)
	}

	// Happy path.
	code, body = doJSON(t, "POST", base, h, map[string]any{
		"type": "backup.create", "kind": "daily", "time_of_day": "02:00",
		"timezone": "Asia/Shanghai", "space_id": f.spaceID,
	})
	if code != http.StatusCreated {
		t.Fatalf("create = %d %v", code, body)
	}
	sched := body["schedule"]
	if sched == nil {
		sched = body
	}
	sid, _ := sched.(map[string]any)["id"].(string)
	if sid == "" {
		t.Fatalf("created schedule has no id: %v", body)
	}
	if got := sched.(map[string]any)["space_name"]; got == "" {
		t.Fatalf("space_name missing: %v", body)
	}

	// Unauthenticated access is rejected.
	code, _ = doJSON(t, "GET", f.ts.URL+"/api/v1/tasks", nil, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated tasks = %d", code)
	}

	// The user task view lists own schedules and jobs.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/tasks", h, nil)
	if code != http.StatusOK {
		t.Fatalf("tasks = %d %v", code, body)
	}
	if scheds := body["schedules"].([]any); len(scheds) != 1 {
		t.Fatalf("schedules = %v", body["schedules"])
	}

	// Bob sees an empty task view, not alice's schedules.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/tasks", bobH, nil)
	if code != http.StatusOK {
		t.Fatalf("bob tasks = %d %v", code, body)
	}
	if scheds := body["schedules"].([]any); len(scheds) != 0 {
		t.Fatalf("bob sees foreign schedules: %v", body)
	}

	// Update: only alice can, and cadence fields survive a partial patch.
	code, body = doJSON(t, "PATCH", base+"/"+sid, bobH, map[string]any{"time_of_day": "05:00"})
	if code != http.StatusForbidden || errCode(t, body) != "NOT_SCHEDULE_OWNER" {
		t.Fatalf("foreign patch = %d %v", code, body)
	}
	code, body = doJSON(t, "PATCH", base+"/"+sid, h, map[string]any{"time_of_day": "05:00"})
	if code != http.StatusOK {
		t.Fatalf("patch = %d %v", code, body)
	}
	if body["time_of_day"] != "05:00" || body["enabled"] != true {
		t.Fatalf("patched schedule = %v", body)
	}

	// Delete: owner-only, then gone.
	code, _ = doJSON(t, "DELETE", base+"/"+sid, bobH, nil)
	if code != http.StatusForbidden {
		t.Fatalf("foreign delete = %d", code)
	}
	if code := doEmpty(t, "DELETE", base+"/"+sid, h); code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	code, body = doJSON(t, "GET", base, h, nil)
	if code != http.StatusOK || len(body["schedules"].([]any)) != 0 {
		t.Fatalf("schedules after delete = %d %v", code, body)
	}
}

func TestRunNowEnqueuesJobForOwner(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	if err := f.srv.Jobs.Register(jobs.TypeBackupCreate, func(context.Context, jobs.Job, jobs.ReportFunc) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	// Create a schedule.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/schedules", h, map[string]any{
		"type": "backup.create", "kind": "daily", "time_of_day": "02:00",
		"timezone": "Asia/Shanghai", "space_id": f.spaceID,
	})
	if code != http.StatusCreated {
		t.Fatalf("create = %d %v", code, body)
	}
	sid := body["id"].(string)

	// Run-now accepts and queues the occurrence with the schedule's space.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/schedules/"+sid+"/run-now", h, nil)
	if code != http.StatusAccepted {
		t.Fatalf("run-now = %d %v", code, body)
	}
	jobID := body["id"].(string)
	job, err := f.srv.Jobs.List(t.Context(), 10)
	if err != nil {
		t.Fatal(err)
	}
	var found *jobs.Job
	for i := range job {
		if job[i].ID == jobID {
			found = &job[i]
		}
	}
	if found == nil {
		t.Fatalf("run-now job %s not queued", jobID)
	}
	if found.SpaceID != f.spaceID || found.OwnerUserID == "" {
		t.Fatalf("run-now job = %+v", found)
	}

	// Foreign run-now is forbidden.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/schedules/"+sid+"/run-now",
		map[string]string{"Authorization": "Bearer " + f.bobToken}, nil)
	if code != http.StatusForbidden || errCode(t, body) != "NOT_SCHEDULE_OWNER" {
		t.Fatalf("foreign run-now = %d %v", code, body)
	}

	// Unknown schedule -> 404.
	code, _ = doJSON(t, "POST", f.ts.URL+"/api/v1/schedules/nope/run-now", h, nil)
	if code != http.StatusNotFound {
		t.Fatalf("unknown run-now = %d", code)
	}
}

func TestCancelMyJobOwnerScoped(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bobH := map[string]string{"Authorization": "Bearer " + f.bobToken}

	// A blocked handler keeps the job running until cancellation lands.
	release := make(chan struct{})
	if err := f.srv.Jobs.Register(jobs.TypeBackupCreate, func(ctx context.Context, _ jobs.Job, _ jobs.ReportFunc) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}); err != nil {
		t.Fatal(err)
	}
	_, me := doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", h, nil)
	aliceID := me["id"].(string)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	f.srv.Jobs.Start(ctx)
	defer f.srv.Jobs.Stop()
	job, err := f.srv.Jobs.Enqueue(t.Context(), jobs.TypeBackupCreate, canonical.UserID(aliceID), f.spaceID, "")
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	waitForJobStatus(t, f.srv, job.ID, jobs.StatusRunning)

	// Bob cannot cancel Alice's job.
	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/jobs/"+job.ID+"/cancel", bobH, nil)
	if code != http.StatusForbidden || errCode(t, body) != "NOT_JOB_OWNER" {
		t.Fatalf("foreign cancel = %d %v", code, body)
	}

	// Owner cancel flags cooperative cancellation.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/jobs/"+job.ID+"/cancel", h, nil)
	if code != http.StatusOK {
		t.Fatalf("owner cancel = %d %v", code, body)
	}
	waitForJobStatus(t, f.srv, job.ID, jobs.StatusCancelled)

	// Unknown job -> 404.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/jobs/nope/cancel", h, nil)
	if code != http.StatusNotFound || errCode(t, body) != "JOB_NOT_FOUND" {
		t.Fatalf("unknown cancel = %d %v", code, body)
	}
	close(release)
}
