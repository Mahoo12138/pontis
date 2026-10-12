package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"pontis/internal/jobs"
)

func TestJobOccurrenceDedupeAndPurge(t *testing.T) {
	db := openTestDB(t)
	seedUserAndSpace(t, db)
	ctx := context.Background()
	store := NewJobStore(db)

	scheduledFor := time.Date(2026, 8, 30, 3, 0, 0, 0, time.UTC)
	first := jobs.Job{
		ID: "job-1", Type: jobs.TypeBackupCreate, Status: jobs.StatusQueued,
		OwnerUserID: "user-1", SpaceID: "space-1", MaxAttempts: 3,
		ScheduleID: "sched-1", ScheduledFor: &scheduledFor, ScheduledAt: scheduledFor,
	}
	created, err := store.EnqueueOccurrence(ctx, first)
	if err != nil || !created {
		t.Fatalf("first enqueue created=%v err=%v", created, err)
	}

	// A replay with a different job id but the same (schedule_id,
	// scheduled_for) must be absorbed by the unique index (doc 13 §8).
	replay := first
	replay.ID = "job-2"
	created, err = store.EnqueueOccurrence(ctx, replay)
	if err != nil || created {
		t.Fatalf("replay created=%v err=%v", created, err)
	}

	got, err := store.Get(ctx, "job-1")
	if err != nil {
		t.Fatal(err)
	}
	if got.ScheduleID != "sched-1" || got.ScheduledFor == nil || !got.ScheduledFor.Equal(scheduledFor) {
		t.Fatalf("occurrence fields lost: %+v", got)
	}
	// Plain jobs (no schedule reference) bypass the partial dedupe index.
	plain := jobs.Job{ID: "job-3", Type: jobs.TypeBackupCreate, MaxAttempts: 3, ScheduledAt: scheduledFor}
	if _, err := store.EnqueueOccurrence(ctx, plain); err != nil {
		t.Fatalf("plain occurrence rejected: %v", err)
	}

	// Purge removes only finished rows past the cutoff.
	if err := store.Finish(ctx, "job-1", jobs.StatusSucceeded, "", scheduledFor.Add(-91*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := store.Finish(ctx, "job-3", jobs.StatusSucceeded, "", scheduledFor); err != nil {
		t.Fatal(err)
	}
	n, err := store.PurgeFinishedBefore(ctx, scheduledFor.Add(-90*24*time.Hour))
	if err != nil || n != 1 {
		t.Fatalf("purged %d err=%v, want 1", n, err)
	}
	if _, err := store.Get(ctx, "job-1"); err == nil {
		t.Fatal("purged job still present")
	}
	if _, err := store.Get(ctx, "job-3"); err != nil {
		t.Fatalf("recent job purged: %v", err)
	}
}

func TestJobRetryReenqueuesFailedJob(t *testing.T) {
	db := openTestDB(t)
	seedUserAndSpace(t, db)
	ctx := context.Background()
	store := NewJobStore(db)
	svc := jobs.NewService(store, 1)
	if err := svc.Register(jobs.TypeBackupCreate, func(context.Context, jobs.Job, jobs.ReportFunc) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	job, err := svc.Enqueue(ctx, jobs.TypeBackupCreate, "user-1", "space-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Finish(ctx, job.ID, jobs.StatusFailed, "boom", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	retried, err := svc.Retry(ctx, job.ID)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if retried.ID == job.ID || retried.SpaceID != "space-1" || retried.Status != jobs.StatusQueued {
		t.Fatalf("retried job = %+v", retried)
	}

	// Non-terminal jobs refuse retry; missing jobs too.
	if _, err := svc.Retry(ctx, retried.ID); err == nil {
		t.Fatal("queued job retried")
	}
	if _, err := svc.Retry(ctx, "missing-job"); err == nil {
		t.Fatal("missing job retried")
	}
}

// Two workers polling one queue must never run the same job twice, and a
// worker that dies mid-job must not hold its lease forever. Both are the whole
// point of claim+lease, and neither was asserted anywhere.
func TestClaimHandsOneJobToOneWorker(t *testing.T) {
	db := openTestDB(t)
	seedUserAndSpace(t, db)
	ctx := context.Background()
	store := NewJobStore(db)

	if err := store.Enqueue(ctx, jobs.Job{
		ID: "solo", Type: jobs.TypeLinkCheck, Status: jobs.StatusQueued,
		OwnerUserID: "user-1", SpaceID: "space-1", MaxAttempts: 3,
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}

	lease := time.Now().UTC().Add(10 * time.Minute)
	first, err := store.Claim(ctx, "worker-a", lease)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if first.ID != "solo" || first.Status != jobs.StatusRunning {
		t.Fatalf("claimed job = %+v", first)
	}
	heldWorker, heldLease := jobLease(t, db, "solo")
	if heldWorker != "worker-a" || heldLease == "" {
		t.Fatalf("claimed row is held by %q with lease %q, want worker-a and a lease", heldWorker, heldLease)
	}

	// The second worker's guard loses: it must hear "nothing for me", not a
	// store failure, and it must not steal the row.
	if _, err := store.Claim(ctx, "worker-b", lease); !errors.Is(err, jobs.ErrNotFound) {
		t.Fatalf("contended claim = %v, want ErrNotFound", err)
	}
	held, _ := jobLease(t, db, "solo")
	if held != "worker-a" {
		t.Errorf("the contended job changed hands to %q", held)
	}
}

// A lease that outlives its worker has to come back to the queue; a lease that
// is still honest must not. Otherwise recovery either double-runs live work or
// parks dead work forever.
func TestRecoverExpiredLeasesReturnsOnlyExpiredWork(t *testing.T) {
	db := openTestDB(t)
	seedUserAndSpace(t, db)
	ctx := context.Background()
	store := NewJobStore(db)

	for _, id := range []string{"dead", "alive"} {
		if err := store.Enqueue(ctx, jobs.Job{
			ID: id, Type: jobs.TypeBackupCreate, Status: jobs.StatusQueued,
			OwnerUserID: "user-1", SpaceID: "space-1", MaxAttempts: 3,
		}); err != nil {
			t.Fatalf("enqueue %s: %v", id, err)
		}
	}
	now := time.Now().UTC()
	if _, err := store.Claim(ctx, "worker-a", now.Add(-1*time.Minute)); err != nil {
		t.Fatalf("claim dead: %v", err)
	}
	if _, err := store.Claim(ctx, "worker-b", now.Add(10*time.Minute)); err != nil {
		t.Fatalf("claim alive: %v", err)
	}

	if err := store.RecoverExpiredLeases(ctx, now); err != nil {
		t.Fatalf("recover: %v", err)
	}
	deadStatus, deadWorker, deadLease := jobRow(t, db, "dead")
	if deadStatus != string(jobs.StatusQueued) || deadWorker != "" || deadLease != "" {
		t.Errorf("expired job = status %q worker %q lease %q, want queued with nothing held",
			deadStatus, deadWorker, deadLease)
	}
	aliveStatus, aliveWorker, _ := jobRow(t, db, "alive")
	if aliveStatus != string(jobs.StatusRunning) || aliveWorker != "worker-b" {
		t.Errorf("live lease was disturbed: status %q worker %q", aliveStatus, aliveWorker)
	}

	// The recovered job is claimable again, which is the point of the sweep.
	if _, err := store.Claim(ctx, "worker-c", now.Add(10*time.Minute)); err != nil {
		t.Fatalf("claiming the recovered job: %v", err)
	}
}

// jobRow reads the columns the Job struct deliberately does not carry: who
// holds a job and until when is the queue's business, not the handler's.
func jobRow(t *testing.T, db *sql.DB, id string) (status, worker, lease string) {
	t.Helper()
	var leaseVal, workerVal any
	if err := db.QueryRow(`SELECT status, worker_id, lease_until FROM jobs WHERE id = ?`, id).
		Scan(&status, &workerVal, &leaseVal); err != nil {
		t.Fatalf("read job %s: %v", id, err)
	}
	worker, _ = workerVal.(string)
	lease, _ = leaseVal.(string)
	return status, worker, lease
}

func jobLease(t *testing.T, db *sql.DB, id string) (worker, lease string) {
	t.Helper()
	_, worker, lease = jobRow(t, db, id)
	return worker, lease
}

// A job scheduled for the future is not due, and claiming past it must not
// quietly run it early.
func TestClaimIgnoresWorkThatIsNotDueYet(t *testing.T) {
	db := openTestDB(t)
	seedUserAndSpace(t, db)
	ctx := context.Background()
	store := NewJobStore(db)

	if err := store.Enqueue(ctx, jobs.Job{
		ID: "later", Type: jobs.TypeBackupCreate, Status: jobs.StatusQueued,
		OwnerUserID: "user-1", SpaceID: "space-1", MaxAttempts: 3,
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if err := store.ScheduleRetry(ctx, "later", 1, time.Now().UTC().Add(30*time.Minute), "transient"); err != nil {
		t.Fatalf("schedule retry: %v", err)
	}

	if _, err := store.Claim(ctx, "worker-a", time.Now().UTC().Add(10*time.Minute)); !errors.Is(err, jobs.ErrNotFound) {
		t.Fatalf("claim of work not due = %v, want ErrNotFound", err)
	}
	got, err := store.Get(ctx, "later")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != jobs.StatusRetryWait {
		t.Fatalf("job status = %s, want it still waiting", got.Status)
	}
}
