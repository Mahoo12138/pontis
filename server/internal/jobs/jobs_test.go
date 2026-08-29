package jobs_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"pontis/internal/jobs"
	"pontis/internal/store/sqlite"
)

func newTestService(t *testing.T, workers int) (*jobs.Service, *sqlite.JobStore) {
	t.Helper()
	db, err := sqlite.Open(filepath.Join(t.TempDir(), "jobs.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := sqlite.Migrate(context.Background(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	store := sqlite.NewJobStore(db)
	return jobs.NewService(store, workers), store
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("condition not met within %v", timeout)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestWorkerRunsJobToSuccess(t *testing.T) {
	svc, _ := newTestService(t, 1)
	ran := make(chan struct{})
	svc.Register(jobs.TypeBackupCreate, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("备份中", nil, nil); err != nil {
			return err
		}
		close(ran)
		return nil
	})

	ctx := context.Background()
	if _, err := svc.Enqueue(ctx, jobs.TypeBackupCreate, "", "s1", ""); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	svc.Start(ctx)
	defer svc.Stop()

	select {
	case <-ran:
	case <-time.After(5 * time.Second):
		t.Fatal("handler never ran")
	}
	waitFor(t, 5*time.Second, func() bool {
		list, _ := svc.List(ctx, 10)
		return list[0].Status == jobs.StatusSucceeded
	})
}

func TestWorkerRetriesThenSucceeds(t *testing.T) {
	svc, _ := newTestService(t, 1)
	attempts := 0
	svc.Register(jobs.TypeSessionCleanup, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		attempts++
		if attempts < 2 {
			return jobs.Retryable{Err: errors.New("transient")}
		}
		return nil
	})

	ctx := context.Background()
	job, _ := svc.Enqueue(ctx, jobs.TypeSessionCleanup, "", "", "")
	svc.Start(ctx)
	defer svc.Stop()

	waitFor(t, 30*time.Second, func() bool {
		list, _ := svc.List(ctx, 10)
		return list[0].Status == jobs.StatusSucceeded
	})
	if attempts < 2 {
		t.Fatalf("expected at least 2 attempts, got %d", attempts)
	}
	_ = job
}

func TestFatalErrorFailsWithoutRetry(t *testing.T) {
	svc, _ := newTestService(t, 1)
	calls := 0
	svc.Register(jobs.TypeImportRun, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		calls++
		return jobs.FatalError
	})

	ctx := context.Background()
	svc.Enqueue(ctx, jobs.TypeImportRun, "", "", "")
	svc.Start(ctx)
	defer svc.Stop()

	waitFor(t, 10*time.Second, func() bool {
		list, _ := svc.List(ctx, 10)
		return list[0].Status == jobs.StatusFailed
	})
	if calls != 1 {
		t.Fatalf("fatal error retried: %d calls", calls)
	}
}

func TestCancelIsCooperative(t *testing.T) {
	svc, _ := newTestService(t, 1)
	started := make(chan struct{})
	svc.Register(jobs.TypeLinkCheck, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		close(started)
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(20 * time.Millisecond):
			}
		}
	})

	ctx := context.Background()
	job, _ := svc.Enqueue(ctx, jobs.TypeLinkCheck, "", "s1", "")
	svc.Start(ctx)
	defer svc.Stop()

	<-started
	if err := svc.Cancel(ctx, job.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	waitFor(t, 5*time.Second, func() bool {
		list, _ := svc.List(ctx, 10)
		return list[0].Status == jobs.StatusCancelled
	})
}
