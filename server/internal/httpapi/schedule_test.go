package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"sync"
	"testing"
	"time"

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

// A schedule is a plan; the work it started is history. Pausing the plan must
// not pretend to cancel a job that is running right now, and deleting the plan
// must not delete the record that it ran — otherwise the task page rewrites
// itself every time someone edits a schedule, and an operator loses the only
// evidence of what happened at 03:00.
func TestPausingAndDeletingAScheduleKeepsItsWork(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	release := make(chan struct{})
	var once sync.Once
	done := func() { once.Do(func() { close(release) }) }
	t.Cleanup(done)

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	f.srv.Jobs.Start(ctx)
	defer f.srv.Jobs.Stop()

	if err := f.srv.Jobs.Register(jobs.TypeBackupCreate,
		func(ctx context.Context, _ jobs.Job, _ jobs.ReportFunc) error {
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}); err != nil {
		t.Fatal(err)
	}

	code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/schedules", h, map[string]any{
		"type": "backup.create", "kind": "daily", "time_of_day": "02:00",
		"timezone": "Asia/Shanghai", "space_id": f.spaceID,
	})
	if code != http.StatusCreated {
		t.Fatalf("create schedule = %d %v", code, body)
	}
	scheduleID := body["id"].(string)

	// The occurrence the scheduler would have queued at 02:00: Tick takes the
	// clock as an argument, so "the plan came due" is driven rather than slept
	// through. This is the path that records which plan a run belongs to.
	if err := f.srv.Schedules.Tick(ctx, time.Now().UTC().Add(48*time.Hour)); err != nil {
		t.Fatalf("scheduler tick: %v", err)
	}
	jobID := occurrenceOf(t, f.db, scheduleID)

	if !awaitJobStatus(t, f.db, jobID, jobs.StatusRunning) {
		t.Fatalf("job %s never started running; the worker did not claim it", jobID)
	}

	// Pause the plan.
	code, body = doJSON(t, "PATCH", f.ts.URL+"/api/v1/schedules/"+scheduleID, h,
		map[string]any{"enabled": false})
	if code != http.StatusOK {
		t.Fatalf("pause = %d %v", code, body)
	}
	if got := jobStatus(t, f.db, jobID); got != jobs.StatusRunning {
		t.Fatalf("pausing the schedule moved its running job to %s, want it left alone", got)
	}
	if jobCancelRequested(t, f.db, jobID) {
		t.Fatal("pausing the schedule asked the running job to cancel")
	}

	// Delete the plan while the work is still in flight.
	code, body = doJSON(t, "DELETE", f.ts.URL+"/api/v1/schedules/"+scheduleID, h, nil)
	if code != http.StatusNoContent && code != http.StatusOK {
		t.Fatalf("delete schedule = %d %v", code, body)
	}
	if got := jobStatus(t, f.db, jobID); got != jobs.StatusRunning {
		t.Fatalf("deleting the schedule moved its running job to %s, want it left alone", got)
	}

	done()
	if !awaitJobStatus(t, f.db, jobID, jobs.StatusSucceeded) {
		t.Fatalf("job %s did not finish after it was released", jobID)
	}

	// The finished run is still attributable: the row survives its plan, keeps
	// the schedule id it came from, and still shows on the owner's task page.
	if got := jobScheduleID(t, f.db, jobID); got != scheduleID {
		t.Errorf("the finished job's schedule_id = %q, want %q", got, scheduleID)
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/tasks", h, nil)
	if code != http.StatusOK {
		t.Fatalf("tasks = %d %v", code, body)
	}
	seen := false
	for _, j := range body["jobs"].([]any) {
		if m := j.(map[string]any); m["id"] == jobID {
			seen = true
			if m["status"] != string(jobs.StatusSucceeded) {
				t.Errorf("the task page shows the run as %v", m["status"])
			}
		}
	}
	if !seen {
		t.Error("the run of a deleted schedule disappeared from the user's task page")
	}
}

// occurrenceOf finds the job a schedule's tick enqueued for it.
func occurrenceOf(t *testing.T, db *sql.DB, scheduleID string) string {
	t.Helper()
	var id string
	if err := db.QueryRow(`SELECT id FROM jobs WHERE schedule_id = ?`, scheduleID).Scan(&id); err != nil {
		t.Fatalf("no occurrence job for schedule %s: %v", scheduleID, err)
	}
	return id
}

func jobRowOf(t *testing.T, db *sql.DB, id string) map[string]any {
	t.Helper()
	var status string
	var worker, scheduleID, cancel any
	if err := db.QueryRow(`
		SELECT status, worker_id, schedule_id, cancel_requested_at FROM jobs WHERE id = ?`, id).
		Scan(&status, &worker, &scheduleID, &cancel); err != nil {
		t.Fatalf("read job %s: %v", id, err)
	}
	return map[string]any{"status": status, "schedule_id": scheduleID, "cancel": cancel}
}

func awaitJobStatus(t *testing.T, db *sql.DB, id string, want jobs.Status) bool {
	t.Helper()
	for i := 0; i < 200; i++ {
		if jobs.Status(jobRowOf(t, db, id)["status"].(string)) == want {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}

func jobStatus(t *testing.T, db *sql.DB, id string) jobs.Status {
	t.Helper()
	return jobs.Status(jobRowOf(t, db, id)["status"].(string))
}

func jobCancelRequested(t *testing.T, db *sql.DB, id string) bool {
	t.Helper()
	return jobRowOf(t, db, id)["cancel"] != nil
}

func jobScheduleID(t *testing.T, db *sql.DB, id string) string {
	t.Helper()
	s, _ := jobRowOf(t, db, id)["schedule_id"].(string)
	return s
}
