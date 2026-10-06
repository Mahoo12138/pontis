// Package app is the composition root: it wires config, storage, domain
// services and the HTTP server together and owns the process lifecycle.
package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"pontis/internal/auth"
	"pontis/internal/backup"
	"pontis/internal/changeset"
	"pontis/internal/config"
	"pontis/internal/device"
	"pontis/internal/httpapi"
	"pontis/internal/library"
	"pontis/internal/logging"
	"pontis/internal/organizer"
	"pontis/internal/plaza"
	"pontis/internal/schedule"
	"pontis/internal/space"
	"pontis/internal/spacetransfer"
	"pontis/internal/store/sqlite"
	"pontis/internal/sync"
	"pontis/internal/token"
	"pontis/internal/transfer"
)

// sessionTTL is the web session lifetime.
const sessionTTL = 24 * time.Hour

// App holds the fully wired runtime dependencies.
type App struct {
	Config config.Config
	Logger *slog.Logger
	DB     *sql.DB
}

// Run boots the server and blocks until ctx is cancelled or the HTTP
// server fails. It performs a graceful shutdown with the configured timeout.
func Run(ctx context.Context, cfg config.Config) error {
	logger := logging.New(cfg.LogLevel)

	db, err := sqlite.Open(cfg.DatabasePath)
	if err != nil {
		return err
	}
	defer db.Close()

	if err := sqlite.Migrate(ctx, db); err != nil {
		return err
	}
	logger.Info("database ready", "path", cfg.DatabasePath)

	instanceID, err := sqlite.InstanceID(ctx, db)
	if err != nil {
		return err
	}

	accountStore := sqlite.NewAccountStore(db)
	libraryStore := sqlite.NewLibraryStore(db)
	canonicalStore := sqlite.NewStore(db)
	changesetSvc := changeset.NewService(sqlite.NewChangeSetStore(db))
	backupSvc, err := backup.NewService(sqlite.NewBackupStore(db), libraryStore,
		filepath.Join(cfg.DataDir, "backups"))
	if err != nil {
		return err
	}
	organizerSvc := organizer.NewService(libraryStore)
	jobSvc, err := buildJobService(db, backupSvc, organizerSvc, accountStore, libraryStore)
	if err != nil {
		return err
	}
	scheduleStore := sqlite.NewScheduleStore(db)
	scheduleSvc := schedule.NewService(scheduleStore, jobSvc)
	scheduleSvc.Log = logger
	api := &httpapi.Server{
		Auth:          auth.NewService(sqlite.NewAuthStore(db), sessionTTL),
		Devices:       device.NewService(sqlite.NewDeviceStore(db)),
		Spaces:        space.NewService(sqlite.NewSpaceStore(db)),
		Sync:          sync.NewService(sqlite.NewSyncStore(db), changesetSvc),
		Library:       library.NewService(libraryStore, canonicalStore, changesetSvc),
		Changesets:    changesetSvc,
		Tokens:        token.NewService(sqlite.NewTokenStore(db)),
		Organizer:     organizerSvc,
		Transfer:      transfer.NewService(libraryStore, canonicalStore, changesetSvc),
		SpaceTransfer: spacetransfer.NewService(canonicalStore, changesetSvc),
		Plaza:         plaza.NewService(sqlite.NewPublicationStore(db), library.NewService(libraryStore, canonicalStore, changesetSvc), changesetSvc, canonicalStore),
		Backups:       backupSvc,
		Jobs:          jobSvc,
		Schedules:     scheduleSvc,
		Accounts:      accountStore,
		InstanceID:    instanceID,
		Logger:        logger,
	}

	jobSvc.Start(ctx)
	defer jobSvc.Stop()

	// Seed the built-in system schedules once, then run the scheduler tick
	// loop (doc 13 §5-§7).
	seedSystemSchedules(ctx, scheduleSvc, logger)
	scheduleCtx, stopScheduler := context.WithCancel(ctx)
	defer stopScheduler()
	go scheduleSvc.RunLoop(scheduleCtx, 30*time.Second)

	mux := chi.NewMux()
	mux.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := db.PingContext(r.Context()); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"status":"db_error"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Mount("/", api.Router())

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("server listening", "addr", cfg.Listen, "data_dir", cfg.DataDir, "instance_id", instanceID)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	logger.Info("server stopped")
	return nil
}
