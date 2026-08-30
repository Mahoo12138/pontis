package app

import (
	"context"
	"log/slog"

	"pontis/internal/jobs"
	"pontis/internal/schedule"
)

// systemTimezone keeps "daily at 03:00 local" semantics for the built-in
// maintenance schedules.
const systemTimezone = "Asia/Shanghai"

// seedSystemSchedules idempotently creates the built-in system schedules.
// System schedules have no owner (doc 13 §3.1) and are not user-visible.
func seedSystemSchedules(ctx context.Context, svc *schedule.Service, logger *slog.Logger) {
	seeds := []schedule.CreateParams{
		{Type: jobs.TypeSessionCleanup, Kind: schedule.KindDaily, TimeOfDay: "03:30", Timezone: systemTimezone},
		{Type: jobs.TypeJournalGC, Kind: schedule.KindDaily, TimeOfDay: "04:00", Timezone: systemTimezone},
		{Type: jobs.TypeArtifactCleanup, Kind: schedule.KindDaily, TimeOfDay: "04:10", Timezone: systemTimezone},
		{Type: jobs.TypeBackupRetention, Kind: schedule.KindDaily, TimeOfDay: "04:20", Timezone: systemTimezone},
	}
	for _, seed := range seeds {
		exists, err := svc.FindSystem(ctx, seed.Type)
		if err != nil {
			logger.Warn("find system schedule failed", "type", seed.Type, "err", err)
			continue
		}
		if exists {
			continue
		}
		if _, err := svc.CreateSystem(ctx, seed); err != nil {
			logger.Warn("seed system schedule failed", "type", seed.Type, "err", err)
		}
	}
}
