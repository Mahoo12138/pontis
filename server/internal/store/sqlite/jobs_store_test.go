package sqlite

import (
	"context"
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