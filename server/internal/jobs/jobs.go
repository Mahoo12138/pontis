// Package jobs implements the SQLite persistent job queue with claim+lease
// workers, bounded exponential backoff and cooperative cancellation
// (doc 13), plus the Task Definition Registry that keeps the generic
// infrastructure out of the product layer (doc 13 §4.3).
package jobs

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Type is a registered domain job type. Only types present in Definitions
// exist; user APIs may only reference user_visible && schedulable ones.
type Type string

// User-visible domain tasks.
const (
	TypeBackupCreate Type = "backup.create"
	TypeLinkCheck    Type = "organizer.link_check"
)

// System maintenance tasks.
const (
	TypeJournalGC       Type = "journal.gc"
	TypeReceiptGC       Type = "receipt.gc"
	TypeSessionCleanup  Type = "session.cleanup"
	TypeArtifactCleanup Type = "artifact.cleanup"
	TypeBackupRetention Type = "backup.retention"
	TypeMailSend        Type = "mail.send"
	TypeImportRun       Type = "import.run"
)

// Definition describes one domain task in the registry (doc 13 §4.3).
type Definition struct {
	Type        Type
	UserVisible bool
	Schedulable bool
	// TitleKey is the product-layer display name key; the web UI maps it
	// to localized domain wording.
	TitleKey string
}

// Definitions is the closed Task Definition Registry.
var Definitions = []Definition{
	{Type: TypeBackupCreate, UserVisible: true, Schedulable: true, TitleKey: "task.backup_create"},
	{Type: TypeLinkCheck, UserVisible: true, Schedulable: true, TitleKey: "task.link_check"},
	{Type: TypeJournalGC, UserVisible: false, Schedulable: false, TitleKey: "task.journal_gc"},
	{Type: TypeReceiptGC, UserVisible: false, Schedulable: false, TitleKey: "task.receipt_gc"},
	{Type: TypeSessionCleanup, UserVisible: false, Schedulable: false, TitleKey: "task.session_cleanup"},
	{Type: TypeArtifactCleanup, UserVisible: false, Schedulable: false, TitleKey: "task.artifact_cleanup"},
	{Type: TypeBackupRetention, UserVisible: false, Schedulable: false, TitleKey: "task.backup_retention"},
	{Type: TypeMailSend, UserVisible: false, Schedulable: false, TitleKey: "task.mail_send"},
	{Type: TypeImportRun, UserVisible: false, Schedulable: false, TitleKey: "task.import_run"},
}

// DefinitionOf returns the registry entry for a type.
func DefinitionOf(t Type) (Definition, bool) {
	for _, d := range Definitions {
		if d.Type == t {
			return d, true
		}
	}
	return Definition{}, false
}

// ErrUnknownType is returned for types outside the registry.
var ErrUnknownType = errors.New("jobs: unknown task type")

// Status is the job lifecycle state.
type Status string

const (
	StatusQueued     Status = "queued"
	StatusRunning    Status = "running"
	StatusRetryWait  Status = "retry_wait"
	StatusSucceeded  Status = "succeeded"
	StatusFailed     Status = "failed"
	StatusCancelled  Status = "cancelled"
)

// Errors.
var (
	ErrNotFound = errors.New("jobs: not found")
	// ErrForbidden marks ownership failures on user operations.
	ErrForbidden = errors.New("jobs: not the owner")
	// FatalError marks a handler failure as non-retryable.
	FatalError = errors.New("jobs: fatal")
)

// Job is one queue entry. OwnerUserID empty = system job (doc 13 §3.1).
type Job struct {
	ID          string
	Type        Type
	Status      Status
	OwnerUserID string
	SpaceID     string
	Payload     string
	Error       string
	Phase       string
	ProgressCur *int64
	ProgressTot *int64
	Attempt     int
	MaxAttempts int
	CancelRequested bool
	// ScheduleID / ScheduledFor tie one occurrence to its plan schedule;
	// the (schedule_id, scheduled_for) unique index makes the scheduler
	// idempotent across crash-restarts (doc 13 §8).
	ScheduleID   string
	ScheduledFor *time.Time
	ScheduledAt time.Time
	StartedAt   *time.Time
	FinishedAt  *time.Time
}

// Retryable wraps an error to force a retry despite being non-fatal.
type Retryable struct{ Err error }

func (r Retryable) Error() string { return r.Err.Error() }

// Handler executes one job. Long handlers must check ctx (cooperative
// cancellation) and report progress through the callback.
type Handler func(ctx context.Context, job Job, report ReportFunc) error

// ReportFunc persists coarse progress: phase text beats fake percentages
// (doc 13 §13).
type ReportFunc func(phase string, current, total *int64) error

// Store is the persistence contract.
type Store interface {
	Enqueue(ctx context.Context, j Job) error
	// Claim atomically moves one due job to running with a lease.
	Claim(ctx context.Context, workerID string, leaseUntil time.Time) (Job, error)
	// UpdateProgress rewrites phase/progress while running.
	UpdateProgress(ctx context.Context, id, phase string, current, total *int64) error
	// Finish marks the terminal state.
	Finish(ctx context.Context, id string, status Status, jobErr string, at time.Time) error
	// ScheduleRetry puts a job back to retry_wait with backoff.
	ScheduleRetry(ctx context.Context, id string, attempt int, nextRunAt time.Time, jobErr string) error
	// RequestCancel flags cooperative cancellation.
	RequestCancel(ctx context.Context, id string, at time.Time) error
	// Get loads one job.
	Get(ctx context.Context, id string) (Job, error)
	// List returns recent jobs, newest first.
	List(ctx context.Context, limit int) ([]Job, error)
	// ListByOwner returns one user's recent jobs (user task view).
	ListByOwner(ctx context.Context, owner string, limit int) ([]Job, error)
	// RecoverExpiredLeases requeues jobs whose worker died.
	RecoverExpiredLeases(ctx context.Context, at time.Time) error
	// EnqueueOccurrence inserts a scheduled occurrence. created=false means
	// the (schedule_id, scheduled_for) dedupe index absorbed a replay
	// (crash between enqueue and next_run advance, doc 13 §8).
	EnqueueOccurrence(ctx context.Context, j Job) (bool, error)
	// PurgeFinishedBefore deletes terminal jobs that ended before `at`.
	PurgeFinishedBefore(ctx context.Context, at time.Time) (int64, error)
}

// Service runs the queue: a poll loop claims due jobs and executes them on
// a small worker pool.
type Service struct {
	store    Store
	handlers map[Type]Handler
	workers  int

	mu      sync.Mutex
	started bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewService returns a job service with the given worker count.
func NewService(store Store, workers int) *Service {
	if workers < 1 {
		workers = 2
	}
	return &Service{store: store, handlers: map[Type]Handler{}, workers: workers}
}

// Register installs a handler for a job type. Only registry types may be
// handled.
func (s *Service) Register(t Type, h Handler) error {
	if _, ok := DefinitionOf(t); !ok {
		return ErrUnknownType
	}
	s.handlers[t] = h
	return nil
}

// Enqueue creates a job that is due immediately.
func (s *Service) Enqueue(ctx context.Context, t Type, owner canonical.UserID, spaceID string, payload string) (Job, error) {
	if _, ok := DefinitionOf(t); !ok {
		return Job{}, ErrUnknownType
	}
	if _, ok := s.handlers[t]; !ok {
		return Job{}, fmt.Errorf("jobs: no handler for %s", t)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return Job{}, err
	}
	now := time.Now().UTC()
	j := Job{
		ID:          id.String(),
		Type:        t,
		Status:      StatusQueued,
		OwnerUserID: string(owner),
		SpaceID:     spaceID,
		Payload:     payload,
		MaxAttempts: 3,
		ScheduledAt: now,
	}
	if err := s.store.Enqueue(ctx, j); err != nil {
		return Job{}, err
	}
	return j, nil
}

// EnqueueForSchedule creates the job for one schedule occurrence. The
// (schedule_id, scheduled_for) unique index makes replays harmless: the
// scheduler may crash after enqueue but before advancing next_run_at, and
// the next tick dedupes instead of doubling the occurrence (doc 13 §8).
func (s *Service) EnqueueForSchedule(ctx context.Context, t Type, owner canonical.UserID, spaceID, scheduleID string, scheduledFor time.Time) (bool, error) {
	if _, ok := DefinitionOf(t); !ok {
		return false, ErrUnknownType
	}
	if _, ok := s.handlers[t]; !ok {
		return false, fmt.Errorf("jobs: no handler for %s", t)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	now := time.Now().UTC()
	j := Job{
		ID:           id.String(),
		Type:         t,
		Status:       StatusQueued,
		OwnerUserID:  string(owner),
		SpaceID:      spaceID,
		MaxAttempts:  3,
		ScheduleID:   scheduleID,
		ScheduledFor: &scheduledFor,
		ScheduledAt:  now,
	}
	return s.store.EnqueueOccurrence(ctx, j)
}

// Retry re-enqueues a failed or cancelled job as a fresh attempt. The
// original row is kept for the audit trail (doc 13 §4.2 ops path).
func (s *Service) Retry(ctx context.Context, id string) (Job, error) {
	old, err := s.store.Get(ctx, id)
	if err != nil {
		return Job{}, err
	}
	if old.Status != StatusFailed && old.Status != StatusCancelled {
		return Job{}, fmt.Errorf("jobs: %s job cannot be retried", old.Status)
	}
	return s.Enqueue(ctx, old.Type, canonical.UserID(old.OwnerUserID), old.SpaceID, old.Payload)
}

// Start launches the poll loop and workers; safe to call once.
func (s *Service) Start(ctx context.Context) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	ctx, s.cancel = context.WithCancel(ctx)
	s.mu.Unlock()

	for i := 0; i < s.workers; i++ {
		s.wg.Add(1)
		go s.workerLoop(ctx, fmt.Sprintf("worker-%d", i))
	}
}

// Stop signals the workers and waits for the current jobs to finish.
func (s *Service) Stop() {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Service) workerLoop(ctx context.Context, workerID string) {
	defer s.wg.Done()
	poll := time.NewTicker(500 * time.Millisecond)
	defer poll.Stop()
	for {
		// Recover leases from dead workers opportunistically.
		_ = s.store.RecoverExpiredLeases(ctx, time.Now().UTC())

		job, err := s.store.Claim(ctx, workerID, time.Now().UTC().Add(10*time.Minute))
		switch {
		case err == nil:
			s.run(ctx, workerID, job)
			continue
		case errors.Is(err, ErrNotFound):
			// nothing due
		default:
			// Transient store failure: back off the poll loop.
		}

		select {
		case <-ctx.Done():
			return
		case <-poll.C:
		}
	}
}

func (s *Service) run(ctx context.Context, workerID string, job Job) {
	handler, ok := s.handlers[job.Type]
	if !ok {
		_ = s.store.Finish(ctx, job.ID, StatusFailed, "no handler registered", time.Now().UTC())
		return
	}
	// Cancellation-aware context: a watcher polls the cancel flag and
	// releases cooperative handlers (doc 13 §12).
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				latest, err := s.store.Get(context.Background(), job.ID)
				if err == nil && latest.CancelRequested {
					cancel()
					return
				}
			}
		}
	}()

	report := func(phase string, current, total *int64) error {
		return s.store.UpdateProgress(runCtx, job.ID, phase, current, total)
	}
	err := handler(runCtx, job, report)

	// Re-read cancel flag: handlers may finish despite a cancel request.
	latest, gerr := s.store.Get(context.Background(), job.ID)
	if gerr == nil && latest.CancelRequested {
		_ = s.store.Finish(context.Background(), job.ID, StatusCancelled, "", time.Now().UTC())
		return
	}

	now := time.Now().UTC()
	switch {
	case err == nil:
		_ = s.store.Finish(ctx, job.ID, StatusSucceeded, "", now)
	case errors.Is(err, FatalError):
		_ = s.store.Finish(ctx, job.ID, StatusFailed, err.Error(), now)
	default:
		attempt := job.Attempt + 1
		if attempt >= job.MaxAttempts {
			_ = s.store.Finish(ctx, job.ID, StatusFailed, err.Error(), now)
			return
		}
		// Bounded exponential backoff, capped at 15 minutes.
		backoff := 2 * time.Second
		for i := 1; i < attempt; i++ {
			backoff *= 4
			if backoff >= 15*time.Minute {
				backoff = 15 * time.Minute
				break
			}
		}
		if _, retryable := err.(Retryable); !retryable && !isRetryableKind(err) {
			_ = s.store.Finish(ctx, job.ID, StatusFailed, err.Error(), now)
			return
		}
		_ = s.store.ScheduleRetry(ctx, job.ID, attempt, now.Add(backoff), err.Error())
	}
	_ = workerID
}

// isRetryableKind keeps the default policy: transport-ish failures retry,
// everything else fails fast unless wrapped in Retryable.
func isRetryableKind(err error) bool {
	type retryable interface{ Retryable() bool }
	if r, ok := err.(retryable); ok {
		return r.Retryable()
	}
	return false
}

// Cancel flags a job for cooperative cancellation.
func (s *Service) Cancel(ctx context.Context, id string) error {
	j, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if terminal(j.Status) {
		return nil // nothing to cancel
	}
	return s.store.RequestCancel(ctx, id, time.Now().UTC())
}

// CancelOwned is the user task page path (doc 13 §4.1): the caller may
// only cancel one of their own jobs. System jobs (owner empty) are out
// of reach from the user API.
func (s *Service) CancelOwned(ctx context.Context, id string, owner canonical.UserID) error {
	j, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if j.OwnerUserID == "" || j.OwnerUserID != string(owner) {
		return ErrForbidden
	}
	if terminal(j.Status) {
		return nil
	}
	return s.store.RequestCancel(ctx, id, time.Now().UTC())
}

func terminal(st Status) bool {
	return st == StatusSucceeded || st == StatusFailed || st == StatusCancelled
}

// List returns recent jobs for the admin view (all owners).
func (s *Service) List(ctx context.Context, limit int) ([]Job, error) {
	return s.store.List(ctx, limit)
}

// ListMine returns the user's recent jobs for the user task view.
func (s *Service) ListMine(ctx context.Context, owner canonical.UserID, limit int) ([]Job, error) {
	return s.store.ListByOwner(ctx, string(owner), limit)
}
