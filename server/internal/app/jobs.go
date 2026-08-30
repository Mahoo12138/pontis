package app

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"pontis/internal/backup"
	"pontis/internal/canonical"
	"pontis/internal/jobs"
	"pontis/internal/organizer"
	"pontis/internal/store/sqlite"
)

// buildJobService wires the queue with the concrete handlers available in
// this deployment (doc 13 §18).
func buildJobService(
	db *sql.DB,
	backups *backup.Service,
	organizerSvc *organizer.Service,
	accounts *sqlite.AccountStore,
	library *sqlite.LibraryStore,
) (*jobs.Service, error) {
	store := sqlite.NewJobStore(db)
	svc := jobs.NewService(store, 2)

	// session.cleanup: drop expired web sessions, reset tokens and prune
	// finished job history past the 90-day summary retention (doc 13 §7).
	svc.Register(jobs.TypeSessionCleanup, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("清理过期会话与凭据", nil, nil); err != nil {
			return err
		}
		now := time.Now().UTC()
		if _, err := accounts.PurgeExpiredSessions(ctx, now); err != nil {
			return err
		}
		if err := accounts.PurgeExpiredResetTokens(ctx, now); err != nil {
			return err
		}
		n, err := store.PurgeFinishedBefore(ctx, now.Add(-90*24*time.Hour))
		if err != nil {
			return err
		}
		if n > 0 {
			return report(fmt.Sprintf("清理 %d 条过期任务记录", n), nil, nil)
		}
		return nil
	})

	// backup.create: capture one space's tree. Space comes from the job
	// row (user schedule/run-now) or payload-free system triggers.
	svc.Register(jobs.TypeBackupCreate, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if job.SpaceID == "" {
			return fmt.Errorf("%w: job has no space", jobs.FatalError)
		}
		if err := report("捕获空间快照", nil, nil); err != nil {
			return err
		}
		b, err := backups.Create(ctx, canonical.SpaceID(job.SpaceID), backup.KindScheduled)
		if err != nil {
			return fmt.Errorf("%w: %v", jobs.FatalError, err)
		}
		return report("备份完成: "+b.Filename, nil, nil)
	})

	// organizer.link_check: delegate to the organizer's per-space checker.
	svc.Register(jobs.TypeLinkCheck, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if job.SpaceID == "" {
			return fmt.Errorf("%w: job has no space", jobs.FatalError)
		}
		if _, total, err := organizerSvc.RunLinkCheck(ctx, canonical.SpaceID(job.SpaceID)); err != nil {
			return err
		} else if total == 0 {
			return report("没有需要检查的书签", nil, nil)
		}
		// Poll the organizer's run registry until the scan completes.
		for {
			run, ok := organizerSvc.LinkResults(ctx, canonical.SpaceID(job.SpaceID))
			if !ok {
				return fmt.Errorf("link check run vanished")
			}
			cur := int64(run.Done)
			tot := int64(run.Total)
			if err := report("检查链接可达性", &cur, &tot); err != nil {
				return err
			}
			if run.Done >= run.Total {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(300 * time.Millisecond):
			}
		}
	})

	// journal.gc: advance the floor and prune history (doc 14 §3).
	svc.Register(jobs.TypeJournalGC, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("推进 journal floor", nil, nil); err != nil {
			return err
		}
		spaceIDs, err := library.ListAllSpaces(ctx)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		var removed int64
		for _, sid := range spaceIDs {
			_, n, err := library.JournalGCSpace(ctx, sid, now, 50000)
			if err != nil {
				return err
			}
			removed += n
		}
		return report(fmt.Sprintf("journal GC 完成,清理 %d 行", removed), nil, nil)
	})

	// receipt.gc: receipts follow the journal floor; handled with the
	// journal sweep.
	svc.Register(jobs.TypeReceiptGC, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return report("receipts 随 journal floor 一并清理", nil, nil)
	})

	// artifact.cleanup: purge expired safety backups and reset tokens.
	svc.Register(jobs.TypeArtifactCleanup, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("清理 30 天前的安全备份", nil, nil); err != nil {
			return err
		}
		n, err := backups.PurgeExpiredSafety(ctx, 30*24*time.Hour)
		if err != nil {
			return err
		}
		return report(fmt.Sprintf("artifact 清理完成,移除 %d 份安全备份", n), nil, nil)
	})

	// backup.retention: keep the newest 10 scheduled backups per space.
	svc.Register(jobs.TypeBackupRetention, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if err := report("按保留策略清理定时备份", nil, nil); err != nil {
			return err
		}
		n, err := backups.ApplyScheduledRetention(ctx, 10)
		if err != nil {
			return err
		}
		return report(fmt.Sprintf("保留策略完成,移除 %d 份定时备份", n), nil, nil)
	})

	// mail.send: placeholder until SMTP support lands; succeeds without
	// side effects so queued flows do not pile up as failures.
	svc.Register(jobs.TypeMailSend, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		return report("SMTP 未配置,跳过发送", nil, nil)
	})

	return svc, nil
}
