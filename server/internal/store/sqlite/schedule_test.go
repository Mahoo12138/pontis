package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"pontis/internal/jobs"
	"pontis/internal/schedule"
)

func seedExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

func seedUserAndSpace(t *testing.T, db *sql.DB) {
	t.Helper()
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	seedExec(t, db, `
		INSERT INTO users (id, username, username_normalized, display_name, password_hash,
			role, status, locale, password_changed_at, created_at, updated_at)
		VALUES ('user-1', 'alice', 'alice', 'Alice', 'x', 'user', 'active', 'zh-CN', ?, ?, ?)`,
		now, now, now)
	seedExec(t, db, `
		INSERT INTO sync_spaces (id, owner_user_id, name, epoch, current_revision,
			journal_floor_revision, created_at, updated_at)
		VALUES ('space-1', 'user-1', 'Personal', 1, 0, 0, ?, ?)`,
		now, now)
}

func scheduleFixture(id, owner, spaceID string, kind schedule.Kind, typ jobs.Type) schedule.Schedule {
	now := time.Now().UTC()
	return schedule.Schedule{
		ID: id, OwnerUserID: owner, SpaceID: spaceID,
		Type: typ, Enabled: true,
		Kind: kind, TimeOfDay: "02:30", Timezone: "Asia/Shanghai",
		NextRunAt: now, CreatedAt: now, UpdatedAt: now,
	}
}

func TestScheduleStoreCRUDAndDue(t *testing.T) {
	db := openTestDB(t)
	seedUserAndSpace(t, db)
	ctx := context.Background()
	store := NewScheduleStore(db)

	sched := scheduleFixture("sched-1", "user-1", "space-1", schedule.KindDaily, jobs.TypeBackupCreate)
	sched.NextRunAt = time.Date(2026, 8, 30, 3, 0, 0, 0, time.UTC)
	if err := store.Insert(ctx, sched); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, err := store.Get(ctx, "sched-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.OwnerUserID != "user-1" || got.SpaceID != "space-1" || got.Type != jobs.TypeBackupCreate {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}
	if got.Kind != schedule.KindDaily || got.TimeOfDay != "02:30" || got.Timezone != "Asia/Shanghai" {
		t.Fatalf("cadence mismatch: %+v", got)
	}

	// ListByOwner matches only the owning user; system rows (NULL owner)
	// never leak into a user list.
	system := scheduleFixture("sched-sys", "", "", schedule.KindDaily, jobs.TypeJournalGC)
	if err := store.Insert(ctx, system); err != nil {
		t.Fatalf("insert system: %v", err)
	}
	mine, err := store.ListByOwner(ctx, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(mine) != 1 || mine[0].ID != "sched-1" {
		t.Fatalf("list = %+v", mine)
	}
	none, err := store.ListByOwner(ctx, "nonexistent")
	if err != nil || len(none) != 0 {
		t.Fatalf("foreign list = %+v err = %v", none, err)
	}

	// ListDue honours enabled and next_run_at.
	at := time.Date(2026, 8, 30, 4, 0, 0, 0, time.UTC)
	due, err := store.ListDue(ctx, at)
	if err != nil || len(due) != 2 {
		t.Fatalf("due = %+v err = %v", due, err)
	}
	system.Enabled = false
	if err := store.Update(ctx, system); err != nil {
		t.Fatal(err)
	}
	due, err = store.ListDue(ctx, at)
	if err != nil || len(due) != 1 || due[0].ID != "sched-1" {
		t.Fatalf("due after disable = %+v err = %v", due, err)
	}

	// AdvanceNextRun persists both the next occurrence and last_run_at.
	next := time.Date(2026, 8, 31, 3, 0, 0, 0, time.UTC)
	occurrence := time.Date(2026, 8, 30, 3, 0, 0, 0, time.UTC)
	if err := store.AdvanceNextRun(ctx, "sched-1", next, occurrence); err != nil {
		t.Fatal(err)
	}
	got, _ = store.Get(ctx, "sched-1")
	if !got.NextRunAt.Equal(next) || got.LastRunAt == nil || !got.LastRunAt.Equal(occurrence) {
		t.Fatalf("after advance: %+v", got)
	}

	// Delete removes the row.
	if err := store.Delete(ctx, "sched-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, "sched-1"); err == nil {
		t.Fatal("deleted schedule still readable")
	}
}

func TestScheduleStoreFindByTypeSystemOwner(t *testing.T) {
	db := openTestDB(t)
	seedUserAndSpace(t, db)
	ctx := context.Background()
	store := NewScheduleStore(db)

	system := scheduleFixture("sched-sys", "", "", schedule.KindDaily, jobs.TypeJournalGC)
	if err := store.Insert(ctx, system); err != nil {
		t.Fatal(err)
	}

	// NULL-owner lookup uses IS semantics, not equality.
	found, ok, err := store.FindByType(ctx, "", jobs.TypeJournalGC)
	if err != nil || !ok || found.ID != "sched-sys" {
		t.Fatalf("system find = %+v ok=%v err=%v", found, ok, err)
	}
	if _, ok, _ := store.FindByType(ctx, "user-1", jobs.TypeJournalGC); ok {
		t.Fatal("system schedule matched a user owner")
	}
}