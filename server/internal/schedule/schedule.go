// Package schedule implements plan tasks: daily/weekly/monthly occurrences
// persisted with next_run_at as the source of truth (doc 13 §5-§7). Missed
// occurrences coalesce into one catch-up run, never replayed per day.
package schedule

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/jobs"
)

// Kind is the schedule cadence; cron stays an internal detail.
type Kind string

const (
	KindDaily   Kind = "daily"
	KindWeekly  Kind = "weekly"
	KindMonthly Kind = "monthly"
)

// Errors.
var (
	ErrNotFound      = errors.New("schedule: not found")
	ErrNotOwner      = errors.New("schedule: not the owner")
	ErrBadType       = errors.New("schedule: task type is not schedulable")
	ErrBadKind       = errors.New("schedule: unknown schedule kind")
	ErrBadTime       = errors.New("schedule: time_of_day must be HH:MM")
	ErrBadWeekday    = errors.New("schedule: weekday out of range")
	ErrBadDayOfMonth = errors.New("schedule: day_of_month out of range")
	ErrBadTimezone   = errors.New("schedule: unknown timezone")
	ErrNoEnqueuer    = errors.New("schedule: enqueuer not configured")
	ErrNoSpace       = errors.New("schedule: space is required for user tasks")
)

// Schedule is one plan task. OwnerUserID empty = system schedule.
type Schedule struct {
	ID          string
	OwnerUserID string
	SpaceID     string // target space; empty for system schedules
	Type        jobs.Type
	Enabled     bool
	Kind        Kind
	TimeOfDay   string // HH:MM in Location
	Weekday     int    // 0=Sunday..6=Saturday, weekly only
	DayOfMonth  int    // 1..28, monthly only
	Timezone    string // IANA name
	NextRunAt   time.Time
	LastRunAt   *time.Time
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Store is the persistence contract.
type Store interface {
	Insert(ctx context.Context, s Schedule) error
	Get(ctx context.Context, id string) (Schedule, error)
	ListByOwner(ctx context.Context, owner string) ([]Schedule, error)
	// ListDue returns enabled schedules whose next_run_at is due.
	ListDue(ctx context.Context, now time.Time) ([]Schedule, error)
	Update(ctx context.Context, s Schedule) error
	Delete(ctx context.Context, id string) error
	AdvanceNextRun(ctx context.Context, id string, next, lastRun time.Time) error
	FindByType(ctx context.Context, owner string, t jobs.Type) (Schedule, bool, error)
}

// Enqueuer creates jobs. Enqueue is the manual path (run-now); EnqueueForSchedule
// records schedule_id + scheduled_for so the dedupe index can absorb replays.
type Enqueuer interface {
	Enqueue(ctx context.Context, t jobs.Type, owner canonical.UserID, spaceID string, payload string) (jobs.Job, error)
	EnqueueForSchedule(ctx context.Context, t jobs.Type, owner canonical.UserID, spaceID, scheduleID string, scheduledFor time.Time) (bool, error)
}

// Service implements schedule CRUD and the tick loop.
type Service struct {
	store Store
	jobs  Enqueuer
	// Log is optional; nil disables tick diagnostics.
	Log *slog.Logger
}

// NewService returns a schedule service.
func NewService(store Store, enqueuer Enqueuer) *Service {
	return &Service{store: store, jobs: enqueuer}
}

func (s *Service) logDebug(msg string, args ...any) {
	if s.Log != nil {
		s.Log.Debug(msg, args...)
	}
}

func (s *Service) logWarn(msg string, args ...any) {
	if s.Log != nil {
		s.Log.Warn(msg, args...)
	}
}

// CreateParams carries a create/update request. Weekday/DayOfMonth are
// pointers so an update can leave them untouched (nil = keep current).
type CreateParams struct {
	Type       jobs.Type
	Kind       Kind
	TimeOfDay  string // HH:MM
	Weekday    *int   // weekly only, 0=Sunday..6=Saturday
	DayOfMonth *int   // monthly only, 1..28
	Timezone   string // IANA name
	SpaceID    string // required for user schedules, empty for system ones
}

// validate checks kind/time/timezone/weekday/day-of-month. Type validity is
// checked separately so Create can also reject missing spaces.
func validate(p CreateParams) error {
	switch p.Kind {
	case KindDaily:
	case KindWeekly:
		if p.Weekday == nil || *p.Weekday < 0 || *p.Weekday > 6 {
			return ErrBadWeekday
		}
	case KindMonthly:
		if p.DayOfMonth == nil || *p.DayOfMonth < 1 || *p.DayOfMonth > 28 {
			return ErrBadDayOfMonth
		}
	default:
		return ErrBadKind
	}
	if _, _, err := parseTimeOfDay(p.TimeOfDay); err != nil {
		return err
	}
	if _, err := time.LoadLocation(p.Timezone); err != nil {
		return ErrBadTimezone
	}
	return nil
}

// Create validates and persists a schedule. User schedules may only target
// user_visible && schedulable registry types (doc 13 §4.3: "用户 API 只能创建
// user_visible && schedulable 的 Task Definition"); system schedules (empty
// owner) are the maintenance path and may schedule any registered type,
// including system maintenance tasks (doc 13 §18).
func (s *Service) Create(ctx context.Context, owner canonical.UserID, p CreateParams) (Schedule, error) {
	def, ok := jobs.DefinitionOf(p.Type)
	if !ok {
		return Schedule{}, ErrBadType
	}
	if owner != "" && !def.Schedulable {
		return Schedule{}, ErrBadType
	}
	if err := validate(p); err != nil {
		return Schedule{}, err
	}
	if owner != "" && p.SpaceID == "" {
		return Schedule{}, ErrNoSpace
	}
	weekday, dayOfMonth := derefInt(p.Weekday), derefInt(p.DayOfMonth)
	sched := Schedule{
		OwnerUserID: string(owner),
		SpaceID:     p.SpaceID,
		Type:        p.Type,
		Enabled:     true,
		Kind:        p.Kind,
		TimeOfDay:   p.TimeOfDay,
		Weekday:     weekday,
		DayOfMonth:  dayOfMonth,
		Timezone:    p.Timezone,
	}
	next, err := computeNextRun(sched, time.Now())
	if err != nil {
		return Schedule{}, err
	}
	sched.NextRunAt = next
	id, err := uuid.NewV7()
	if err != nil {
		return Schedule{}, err
	}
	sched.ID = id.String()
	now := time.Now().UTC()
	sched.CreatedAt, sched.UpdatedAt = now, now
	if err := s.store.Insert(ctx, sched); err != nil {
		return Schedule{}, err
	}
	return sched, nil
}

// Update patches an existing schedule (owner-scoped for users). Empty
// strings / nil pointers keep the stored values.
func (s *Service) Update(ctx context.Context, owner canonical.UserID, id string, p CreateParams, enabled *bool) (Schedule, error) {
	sched, err := s.owned(ctx, owner, id)
	if err != nil {
		return Schedule{}, err
	}
	if p.Type != "" {
		def, ok := jobs.DefinitionOf(p.Type)
		if !ok || !def.Schedulable {
			return Schedule{}, ErrBadType
		}
		sched.Type = p.Type
	}
	if p.SpaceID != "" {
		sched.SpaceID = p.SpaceID
	}
	if p.Kind != "" {
		sched.Kind = p.Kind
	}
	if p.TimeOfDay != "" {
		sched.TimeOfDay = p.TimeOfDay
	}
	if p.Weekday != nil {
		sched.Weekday = *p.Weekday
	}
	if p.DayOfMonth != nil {
		sched.DayOfMonth = *p.DayOfMonth
	}
	if p.Timezone != "" {
		sched.Timezone = p.Timezone
	}
	if enabled != nil {
		sched.Enabled = *enabled
	}
	if err := validate(CreateParams{
		Kind:       sched.Kind,
		TimeOfDay:  sched.TimeOfDay,
		Weekday:    &sched.Weekday,
		DayOfMonth: &sched.DayOfMonth,
		Timezone:   sched.Timezone,
	}); err != nil {
		return Schedule{}, err
	}
	next, err := computeNextRun(sched, time.Now())
	if err != nil {
		return Schedule{}, err
	}
	sched.NextRunAt = next
	sched.UpdatedAt = time.Now().UTC()
	if err := s.store.Update(ctx, sched); err != nil {
		return Schedule{}, err
	}
	return sched, nil
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// Delete removes a schedule. Already-created jobs keep their retention
// (doc 13 §3.1) — only future occurrences stop.
func (s *Service) Delete(ctx context.Context, owner canonical.UserID, id string) error {
	if _, err := s.owned(ctx, owner, id); err != nil {
		return err
	}
	return s.store.Delete(ctx, id)
}

// SetEnabled pauses or resumes.
func (s *Service) SetEnabled(ctx context.Context, owner canonical.UserID, id string, enabled bool) (Schedule, error) {
	sched, err := s.owned(ctx, owner, id)
	if err != nil {
		return Schedule{}, err
	}
	sched.Enabled = enabled
	next, err := computeNextRun(sched, time.Now())
	if err != nil {
		return Schedule{}, err
	}
	sched.NextRunAt = next
	sched.UpdatedAt = time.Now().UTC()
	if err := s.store.Update(ctx, sched); err != nil {
		return Schedule{}, err
	}
	return sched, nil
}

// ListByOwner returns the owner's schedules (system schedules excluded).
func (s *Service) ListByOwner(ctx context.Context, owner canonical.UserID) ([]Schedule, error) {
	return s.store.ListByOwner(ctx, string(owner))
}

// RunNow enqueues an immediate occurrence for a schedule.
func (s *Service) RunNow(ctx context.Context, owner canonical.UserID, id string) (jobs.Job, error) {
	sched, err := s.owned(ctx, owner, id)
	if err != nil {
		return jobs.Job{}, err
	}
	if s.jobs == nil {
		return jobs.Job{}, ErrNoEnqueuer
	}
	return s.jobs.Enqueue(ctx, sched.Type, owner, sched.SpaceID, "")
}

// Tick enqueues due occurrences and advances next_run_at past now. Called
// periodically by the scheduler loop.
//
// Order matters: enqueue first, advance second. If the process dies between
// the two steps the next tick re-reads the due schedule and the
// (schedule_id, scheduled_for) dedupe index absorbs the replay (doc 13 §8).
// An enqueue failure leaves next_run_at untouched, so the occurrence is
// retried on the next tick instead of being lost.
func (s *Service) Tick(ctx context.Context, now time.Time) error {
	if s.jobs == nil {
		return ErrNoEnqueuer
	}
	due, err := s.store.ListDue(ctx, now)
	if err != nil {
		return err
	}
	for _, sched := range due {
		occurrence := sched.NextRunAt
		next, nerr := computeNextRun(sched, now)
		if nerr != nil {
			// Broken schedule: push it a day out instead of spinning.
			s.logWarn("schedule computeNextRun failed, deferring a day",
				"schedule_id", sched.ID, "type", string(sched.Type), "err", nerr)
			next = now.Add(24 * time.Hour)
		}
		// Missed occurrences coalesce: next_run_at far in the past yields
		// exactly one catch-up job for the missed slot, never one per day
		// (doc 13 §7).
		created, jerr := s.jobs.EnqueueForSchedule(
			ctx, sched.Type, canonical.UserID(sched.OwnerUserID),
			sched.SpaceID, sched.ID, occurrence)
		if jerr != nil {
			s.logWarn("schedule enqueue failed; will retry next tick",
				"schedule_id", sched.ID, "type", string(sched.Type), "err", jerr)
			continue
		}
		if err := s.store.AdvanceNextRun(ctx, sched.ID, next, occurrence); err != nil {
			s.logWarn("schedule advance failed", "schedule_id", sched.ID, "err", err)
			continue
		}
		s.logDebug("schedule occurrence dispatched",
			"schedule_id", sched.ID, "type", string(sched.Type),
			"scheduled_for", occurrence.Format(time.RFC3339), "deduped", !created)
	}
	return nil
}

func (s *Service) owned(ctx context.Context, owner canonical.UserID, id string) (Schedule, error) {
	sched, err := s.store.Get(ctx, id)
	if err != nil {
		return Schedule{}, err
	}
	if sched.OwnerUserID != string(owner) {
		return Schedule{}, ErrNotOwner
	}
	return sched, nil
}

// computeNextRun returns the first occurrence strictly after `after`.
func computeNextRun(s Schedule, after time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(s.Timezone)
	if err != nil {
		return time.Time{}, ErrBadTimezone
	}
	hour, minute, err := parseTimeOfDay(s.TimeOfDay)
	if err != nil {
		return time.Time{}, ErrBadTime
	}
	local := after.In(loc)
	// Candidate: today at TimeOfDay.
	cand := time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, loc)

	switch s.Kind {
	case KindDaily:
		if !cand.After(local) {
			cand = cand.AddDate(0, 0, 1)
		}
		return cand.UTC(), nil
	case KindWeekly:
		for i := 0; i < 8; i++ {
			if int(cand.Weekday()) == s.Weekday && cand.After(local) {
				return cand.UTC(), nil
			}
			cand = cand.AddDate(0, 0, 1)
		}
		return time.Time{}, ErrBadWeekday
	case KindMonthly:
		for i := 0; i < 13; i++ {
			day := s.DayOfMonth
			// Clamp to the month's length (28 max keeps it simple and
			// avoids skipping short months).
			lastDay := time.Date(cand.Year(), cand.Month()+1, 0, 0, 0, 0, 0, loc).Day()
			if day > lastDay {
				day = lastDay
			}
			cand = time.Date(cand.Year(), cand.Month(), day, hour, minute, 0, 0, loc)
			if cand.After(local) {
				return cand.UTC(), nil
			}
			cand = time.Date(cand.Year(), cand.Month(), 1, 0, 0, 0, 0, loc).AddDate(0, 1, 0)
		}
		return time.Time{}, ErrBadDayOfMonth
	default:
		return time.Time{}, ErrBadKind
	}
}

func parseTimeOfDay(s string) (int, int, error) {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, 0, ErrBadTime
	}
	var hour, minute int
	if _, err := fmt.Sscanf(parts[0], "%d", &hour); err != nil || hour < 0 || hour > 23 {
		return 0, 0, ErrBadTime
	}
	if _, err := fmt.Sscanf(parts[1], "%d", &minute); err != nil || minute < 0 || minute > 59 {
		return 0, 0, ErrBadTime
	}
	return hour, minute, nil
}


// ValidateCreate checks the request fields without persisting (used by the
// HTTP layer for crisp error mapping). Type must be schedulable; spaces are
// validated by the HTTP layer against the caller's own spaces.
func ValidateCreate(p CreateParams) error {
	def, ok := jobs.DefinitionOf(p.Type)
	if !ok || !def.Schedulable {
		return ErrBadType
	}
	return validate(p)
}

// FindSystem reports whether a system schedule of the given type exists.
func (s *Service) FindSystem(ctx context.Context, t jobs.Type) (bool, error) {
	_, found, err := s.store.FindByType(ctx, "", t)
	return found, err
}

// CreateSystem creates a system schedule (no owner).
func (s *Service) CreateSystem(ctx context.Context, p CreateParams) (Schedule, error) {
	return s.Create(ctx, "", p)
}

// RunLoop ticks on an interval until ctx is cancelled. next_run_at is the
// source of truth; missed occurrences coalesce into one catch-up run.
func (s *Service) RunLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	// Tick once at startup so due work from downtime is picked up.
	if err := s.Tick(ctx, time.Now().UTC()); err != nil && ctx.Err() == nil {
		s.logWarn("schedule tick failed", "err", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Tick(ctx, time.Now().UTC()); err != nil && ctx.Err() == nil {
				s.logWarn("schedule tick failed", "err", err)
			}
		}
	}
}
