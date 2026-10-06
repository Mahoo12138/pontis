package schedule

import (
	"errors"
	"testing"
	"time"

	"pontis/internal/jobs"
)

func intp(v int) *int { return &v }

func TestComputeNextRunDaily(t *testing.T) {
	s := Schedule{Kind: KindDaily, TimeOfDay: "03:00", Timezone: "Asia/Shanghai"}
	after := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC) // 18:00 CST
	next, err := computeNextRun(s, after)
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 8, 31, 3, 0, 0, 0, time.FixedZone("CST", 8*3600))
	if !next.Equal(want.UTC()) {
		t.Fatalf("next = %v, want %v", next, want.UTC())
	}

	// Same day when the time is still ahead of `after`.
	// 2026-08-29 20:00 UTC = Aug 30 04:00 CST; today's 03:00 CST already
	// passed, so the next occurrence is Aug 31 03:00 CST = Aug 30 19:00 UTC.
	after = time.Date(2026, 8, 29, 20, 0, 0, 0, time.UTC)
	next, err = computeNextRun(s, after)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 8, 30, 19, 0, 0, 0, time.UTC); !next.Equal(want) {
		t.Fatalf("next = %v, want %v", next, want)
	}
}

func TestComputeNextRunWeeklyAndMonthly(t *testing.T) {
	// Sunday (=0) at 02:00 New York time.
	s := Schedule{Kind: KindWeekly, TimeOfDay: "02:00", Weekday: 0, Timezone: "America/New_York"}
	// 2026-08-30 is a Sunday; 14:00 UTC is past 02:00 EDT.
	next, err := computeNextRun(s, time.Date(2026, 8, 30, 14, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	// Next Sunday is 2026-09-06 02:00 EDT (06:00 UTC).
	if want := time.Date(2026, 9, 6, 6, 0, 0, 0, time.UTC); !next.Equal(want) {
		t.Fatalf("weekly next = %v, want %v", next, want)
	}

	// Monthly on the 28th: Jan 28 09:00 CST has passed, so next is
	// Feb 28 09:00 CST = 01:00 UTC.
	m := Schedule{Kind: KindMonthly, TimeOfDay: "09:00", DayOfMonth: 28, Timezone: "Asia/Shanghai"}
	next, err = computeNextRun(m, time.Date(2026, 1, 28, 2, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 2, 28, 1, 0, 0, 0, time.UTC); !next.Equal(want) {
		t.Fatalf("monthly next = %v, want %v", next, want)
	}

	// DST spring-forward: 02:30 does not exist on 2026-03-08 in New York.
	// time.Date normalizes into the gap; the occurrence must still be that
	// day and strictly after the reference instant.
	dst := Schedule{Kind: KindDaily, TimeOfDay: "02:30", Timezone: "America/New_York"}
	next, err = computeNextRun(dst, time.Date(2026, 3, 7, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if next.UTC().Day() != 8 || !next.After(time.Date(2026, 3, 7, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("dst next = %v, want a Mar 8 occurrence after the reference", next)
	}

	if _, err := computeNextRun(Schedule{Kind: "hourly", TimeOfDay: "03:00", Timezone: "UTC"}, time.Now()); !errors.Is(err, ErrBadKind) {
		t.Fatalf("bad kind err = %v", err)
	}
	if _, err := computeNextRun(Schedule{Kind: KindDaily, Timezone: "Mars/Olympus"}, time.Now()); !errors.Is(err, ErrBadTimezone) {
		t.Fatalf("bad timezone err = %v", err)
	}
}

func TestValidateCreate(t *testing.T) {
	base := CreateParams{
		Type: jobs.TypeBackupCreate, Kind: KindDaily,
		TimeOfDay: "03:00", Timezone: "Asia/Shanghai",
	}
	if err := ValidateCreate(base); err != nil {
		t.Fatalf("valid params rejected: %v", err)
	}
	if err := ValidateCreate(CreateParams{Type: jobs.TypeJournalGC, Kind: KindDaily, TimeOfDay: "03:00", Timezone: "UTC"}); !errors.Is(err, ErrBadType) {
		t.Fatalf("system-only type err = %v", err)
	}
	if err := ValidateCreate(CreateParams{Type: jobs.TypeBackupCreate, Kind: KindWeekly, TimeOfDay: "03:00", Timezone: "UTC", Weekday: intp(9)}); !errors.Is(err, ErrBadWeekday) {
		t.Fatalf("weekday err = %v", err)
	}
	if err := ValidateCreate(CreateParams{Type: jobs.TypeBackupCreate, Kind: KindWeekly, TimeOfDay: "03:00", Timezone: "UTC"}); !errors.Is(err, ErrBadWeekday) {
		t.Fatalf("missing weekday err = %v", err)
	}
	if err := ValidateCreate(CreateParams{Type: jobs.TypeBackupCreate, Kind: KindMonthly, TimeOfDay: "03:00", Timezone: "UTC", DayOfMonth: intp(29)}); !errors.Is(err, ErrBadDayOfMonth) {
		t.Fatalf("day_of_month err = %v", err)
	}
	if err := ValidateCreate(CreateParams{Type: jobs.TypeBackupCreate, Kind: KindDaily, TimeOfDay: "25:00", Timezone: "UTC"}); !errors.Is(err, ErrBadTime) {
		t.Fatalf("time err = %v", err)
	}
	if err := ValidateCreate(CreateParams{Type: jobs.TypeBackupCreate, Kind: KindDaily, TimeOfDay: "03:00", Timezone: "Nowhere/Land"}); !errors.Is(err, ErrBadTimezone) {
		t.Fatalf("timezone err = %v", err)
	}
}
