package schedule

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/jobs"
)

// --- fakes ---

type fakeStore struct {
	mu        sync.Mutex
	byID      map[string]Schedule
	advance   []string
	nextRun   map[string]time.Time
	failAdvID string // AdvanceNextRun fails for this schedule id
}

func newFakeStore(scheds ...Schedule) *fakeStore {
	fs := &fakeStore{byID: map[string]Schedule{}, nextRun: map[string]time.Time{}}
	for _, s := range scheds {
		fs.byID[s.ID] = s
		fs.nextRun[s.ID] = s.NextRunAt
	}
	return fs
}

func (f *fakeStore) Insert(_ context.Context, s Schedule) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[s.ID] = s
	f.nextRun[s.ID] = s.NextRunAt
	return nil
}

func (f *fakeStore) Get(_ context.Context, id string) (Schedule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.byID[id]
	if !ok {
		return Schedule{}, ErrNotFound
	}
	return s, nil
}

func (f *fakeStore) ListByOwner(_ context.Context, owner string) ([]Schedule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Schedule
	for _, s := range f.byID {
		if s.OwnerUserID == owner {
			out = append(out, s)
		}
	}
	return out, nil
}

func (f *fakeStore) ListDue(_ context.Context, now time.Time) ([]Schedule, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Schedule
	for _, s := range f.byID {
		if s.Enabled && !f.nextRun[s.ID].After(now) {
			s.NextRunAt = f.nextRun[s.ID]
			out = append(out, s)
		}
	}
	return out, nil
}

func (f *fakeStore) Update(_ context.Context, s Schedule) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[s.ID] = s
	f.nextRun[s.ID] = s.NextRunAt
	return nil
}

func (f *fakeStore) Delete(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.byID, id)
	return nil
}

func (f *fakeStore) AdvanceNextRun(_ context.Context, id string, next, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if id == f.failAdvID {
		return errors.New("store unavailable")
	}
	f.nextRun[id] = next
	f.advance = append(f.advance, id)
	return nil
}

func (f *fakeStore) FindByType(_ context.Context, owner string, t jobs.Type) (Schedule, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.byID {
		if s.OwnerUserID == owner && s.Type == t {
			return s, true, nil
		}
	}
	return Schedule{}, false, nil
}

type fakeEnqueuer struct {
	mu      sync.Mutex
	attempt map[string]int  // schedule_id -> enqueue attempts
	created map[string]int  // schedule_id -> accepted occurrences
	spaces  map[string]bool // enqueued space ids
	failAll bool            // enqueue always fails
}

func newFakeEnqueuer() *fakeEnqueuer {
	return &fakeEnqueuer{attempt: map[string]int{}, created: map[string]int{}, spaces: map[string]bool{}}
}

func (f *fakeEnqueuer) Enqueue(_ context.Context, t jobs.Type, _ canonical.UserID, spaceID string, _ string) (jobs.Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAll {
		return jobs.Job{}, errors.New("enqueue failed")
	}
	f.spaces[spaceID] = true
	return jobs.Job{ID: "j-" + string(t), Type: t, SpaceID: spaceID}, nil
}

// EnqueueForSchedule models the real dedupe semantics loosely: for these
// tests each schedule id accepts its first occurrence and dedupes replays.
func (f *fakeEnqueuer) EnqueueForSchedule(_ context.Context, t jobs.Type, _ canonical.UserID, spaceID, scheduleID string, _ time.Time) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = t
	f.attempt[scheduleID]++
	if f.failAll {
		return false, errors.New("enqueue failed")
	}
	if f.created[scheduleID] == 0 {
		f.created[scheduleID] = 1
		f.spaces[spaceID] = true
		return true, nil
	}
	return false, nil
}

// --- Service behaviour ---

func dailyParams() CreateParams {
	return CreateParams{
		Type: jobs.TypeBackupCreate, Kind: KindDaily,
		TimeOfDay: "03:00", Timezone: "Asia/Shanghai",
		SpaceID: "space-1",
	}
}

func TestCreateRequiresSpaceForUsers(t *testing.T) {
	svc := NewService(newFakeStore(), newFakeEnqueuer())
	p := dailyParams()
	p.SpaceID = ""
	if _, err := svc.Create(context.Background(), "u1", p); !errors.Is(err, ErrNoSpace) {
		t.Fatalf("missing space err = %v", err)
	}
	p = dailyParams()
	p.Type = jobs.TypeJournalGC
	if _, err := svc.Create(context.Background(), "u1", p); !errors.Is(err, ErrBadType) {
		t.Fatalf("non-schedulable type err = %v", err)
	}
}

func TestTickEnqueuesAdvancesAndCoalesces(t *testing.T) {
	store := newFakeStore()
	enq := newFakeEnqueuer()
	svc := NewService(store, enq)

	// A schedule whose next_run_at is 30 days stale: the tick must coalesce
	// the missed occurrences into exactly one catch-up job (doc 13 §7).
	stale := Schedule{
		ID: "s1", OwnerUserID: "u1", SpaceID: "space-1",
		Type: jobs.TypeBackupCreate, Enabled: true,
		Kind: KindDaily, TimeOfDay: "03:00", Timezone: "Asia/Shanghai",
		NextRunAt: time.Now().UTC().Add(-30 * 24 * time.Hour),
	}
	if err := store.Insert(context.Background(), stale); err != nil {
		t.Fatal(err)
	}
	if err := svc.Tick(context.Background(), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if got := enq.created["s1"]; got != 1 {
		t.Fatalf("created occurrences = %d, want 1", got)
	}
	if len(store.advance) != 1 || store.advance[0] != "s1" {
		t.Fatalf("advance calls = %v", store.advance)
	}
	if !store.nextRun["s1"].After(time.Now().UTC()) {
		t.Fatalf("next_run_at = %v, want in the future", store.nextRun["s1"])
	}
	// The occurrence carries the schedule's target space.
	if !enq.spaces["space-1"] {
		t.Fatalf("enqueued spaces = %v", enq.spaces)
	}

	// A second tick does nothing: the schedule is no longer due.
	if err := svc.Tick(context.Background(), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if got := enq.created["s1"]; got != 1 {
		t.Fatalf("second tick created %d occurrences, want 0", got)
	}
}

func TestTickCrashReplayIsDeduped(t *testing.T) {
	store := newFakeStore()
	enq := newFakeEnqueuer()
	svc := NewService(store, enq)

	due := Schedule{
		ID: "s2", OwnerUserID: "u1", SpaceID: "space-1",
		Type: jobs.TypeLinkCheck, Enabled: true,
		Kind: KindDaily, TimeOfDay: "03:00", Timezone: "Asia/Shanghai",
		NextRunAt: time.Now().UTC().Add(-time.Hour),
	}
	if err := store.Insert(context.Background(), due); err != nil {
		t.Fatal(err)
	}

	// First tick: enqueue lands, then the process crashes before the
	// next_run_at advance persisted.
	if err := svc.Tick(context.Background(), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	store.nextRun["s2"] = due.NextRunAt // roll back the advance
	store.advance = nil

	// Restart tick: the occurrence is deduped, next_run_at still moves.
	if err := svc.Tick(context.Background(), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if got := enq.created["s2"]; got != 1 {
		t.Fatalf("replayed tick created %d occurrences, want 0 (dedupe)", got)
	}
	if !store.nextRun["s2"].After(time.Now().UTC()) {
		t.Fatalf("next_run_at = %v, want advanced", store.nextRun["s2"])
	}
}

func TestTickEnqueueFailureKeepsOccurrence(t *testing.T) {
	store := newFakeStore()
	enq := newFakeEnqueuer()
	enq.failAll = true
	svc := NewService(store, enq)

	due := Schedule{
		ID: "s3", OwnerUserID: "u1", SpaceID: "space-1",
		Type: jobs.TypeBackupCreate, Enabled: true,
		Kind: KindDaily, TimeOfDay: "03:00", Timezone: "Asia/Shanghai",
		NextRunAt: time.Now().UTC().Add(-time.Hour),
	}
	if err := store.Insert(context.Background(), due); err != nil {
		t.Fatal(err)
	}
	if err := svc.Tick(context.Background(), time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	// next_run_at untouched: the occurrence is retried next tick, never lost.
	if !store.nextRun["s3"].Equal(due.NextRunAt) {
		t.Fatalf("next_run_at advanced during enqueue failure: %v", store.nextRun["s3"])
	}
	if len(store.advance) != 0 {
		t.Fatalf("advance calls = %v, want none", store.advance)
	}
}

func TestUpdateKeepsCadenceFieldsWhenUnset(t *testing.T) {
	store := newFakeStore()
	svc := NewService(store, newFakeEnqueuer())

	wd := 3
	created, err := svc.Create(context.Background(), "u1", CreateParams{
		Type: jobs.TypeBackupCreate, Kind: KindWeekly, Weekday: &wd,
		TimeOfDay: "03:00", Timezone: "Asia/Shanghai", SpaceID: "space-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.Weekday != 3 {
		t.Fatalf("created weekday = %d, want 3", created.Weekday)
	}

	// Update only the time; weekday must survive.
	updated, err := svc.Update(context.Background(), "u1", created.ID, CreateParams{
		TimeOfDay: "04:30", Timezone: "Asia/Shanghai",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Weekday != 3 || updated.Kind != KindWeekly {
		t.Fatalf("update clobbered cadence: %+v", updated)
	}
	if updated.TimeOfDay != "04:30" {
		t.Fatalf("time not updated: %+v", updated)
	}
	if !updated.Enabled {
		t.Fatal("enabled flag lost")
	}

	// Another owner cannot touch it.
	if _, err := svc.Update(context.Background(), "u2", created.ID, CreateParams{TimeOfDay: "05:00"}, nil); !errors.Is(err, ErrNotOwner) {
		t.Fatalf("foreign update err = %v", err)
	}
	if _, err := svc.Update(context.Background(), "u1", "missing", CreateParams{}, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing schedule err = %v", err)
	}
}

func TestRunNowCarriesSpace(t *testing.T) {
	store := newFakeStore()
	enq := newFakeEnqueuer()
	svc := NewService(store, enq)

	created, err := svc.Create(context.Background(), "u1", dailyParams())
	if err != nil {
		t.Fatal(err)
	}
	job, err := svc.RunNow(context.Background(), "u1", created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if job.SpaceID != "space-1" {
		t.Fatalf("run-now job space = %q, want space-1", job.SpaceID)
	}

	// RunNow without an enqueuer reports a stable error.
	plain := NewService(store, nil)
	if _, err := plain.RunNow(context.Background(), "u1", created.ID); !errors.Is(err, ErrNoEnqueuer) {
		t.Fatalf("nil enqueuer err = %v", err)
	}
}
