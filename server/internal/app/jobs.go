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
// this deployment.
func buildJobService(
	db *sql.DB,
	backups *backup.Service,
	organizer *organizer.Service,
	accounts *sqlite.AccountStore,
) (*jobs.Service, error) {
	store := sqlite.NewJobStore(db)
	svc := jobs.NewService(store, 2)

	// backup: capture one space's tree (payload {"space_id": "..."}).
	svc.Register(jobs.TypeBackup, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if job.SpaceID == "" {
			return fmt.Errorf("%w: job has no space", jobs.FatalError)
		}
		err := report("捕获空间快照", nil, nil)
		if err != nil {
			return err
		}
		b, err := backups.Create(ctx, canonical.SpaceID(job.SpaceID), backup.KindScheduled)
		if err != nil {
			return fmt.Errorf("%w: %v", jobs.FatalError, err)
		}
		return report("备份完成: "+b.Filename, nil, nil)
	})

	// maintenance: purge expired reset tokens.
	svc.Register(jobs.TypeMaintenance, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		err := report("清理过期凭据", nil, nil)
		if err != nil {
			return err
		}
		return accounts.PurgeExpiredResetTokens(ctx, time.Now().UTC())
	})

	// link_check: delegate to the organizer's per-space checker.
	svc.Register(jobs.TypeLinkCheck, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		if job.SpaceID == "" {
			return fmt.Errorf("%w: job has no space", jobs.FatalError)
		}
		if _, total, err := organizer.RunLinkCheck(ctx, canonical.SpaceID(job.SpaceID)); err != nil {
			return err
		} else if total == 0 {
			err := report("没有需要检查的书签", nil, nil)
			return err
		}
		// Poll the organizer's run registry until the scan completes.
		for {
			run, ok := organizer.LinkResults(ctx, canonical.SpaceID(job.SpaceID))
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

	// email: placeholder until SMTP support lands; succeeds without side
	// effects so queued flows do not pile up as failures.
	svc.Register(jobs.TypeEmail, func(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
		err := report("SMTP 未配置,跳过发送", nil, nil)
		return err
	})

	return svc, nil
}

