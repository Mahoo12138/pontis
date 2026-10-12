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
	"pontis/internal/reconcile"
	"pontis/internal/schedule"
	"pontis/internal/space"
	"pontis/internal/spacetransfer"
	"pontis/internal/startpage"
	"pontis/internal/store/sqlite"
	"pontis/internal/sync"
	"pontis/internal/token"
	"pontis/internal/transfer"
	"pontis/internal/webui"
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
	backupStore := sqlite.NewBackupStore(db)
	backupSvc, err := backup.NewService(backupStore, libraryStore,
		filepath.Join(cfg.DataDir, "backups"))
	if err != nil {
		return err
	}
	// Rows written before a backup got its own opaque storage key carry only a
	// display filename, which two spaces with the same name share. Restore
	// refuses them rather than guessing an owner; an operator should hear that
	// from the log, not from the one click that was meant to recover a tree.
	if n, err := backupStore.CountUnlocated(ctx); err != nil {
		logger.Warn("could not audit the backup catalog", "err", err)
	} else if n > 0 {
		logger.Warn("backup catalog holds rows whose payload cannot be located; take a new backup before restoring",
			"count", n)
	}
	allow, err := organizer.ParseAllowlist(cfg.LinkCheckAllow)
	if err != nil {
		return err
	}
	if len(allow) > 0 {
		// Worth a line in the log: these ranges are servers this instance
		// will connect to on behalf of any user's bookmark.
		logger.Info("link check may reach operator-approved ranges", "count", len(allow))
	}
	organizerSvc := organizer.NewService(libraryStore, sqlite.NewLinkCheckStore(db),
		organizer.Outbound{Allow: allow})
	tokenStore := sqlite.NewTokenStore(db)
	jobSvc, err := buildJobService(db, backupSvc, organizerSvc, accountStore, libraryStore, tokenStore)
	if err != nil {
		return err
	}
	scheduleStore := sqlite.NewScheduleStore(db)
	scheduleSvc := schedule.NewService(scheduleStore, jobSvc)
	scheduleSvc.Log = logger
	proxies, err := httpapi.ParseProxies(cfg.TrustedProxies)
	if err != nil {
		return err
	}
	deploy := httpapi.Deployment{PublicURL: cfg.PublicURL, Proxies: proxies}
	if err := deploy.Validate(); err != nil {
		return err
	}

	api := &httpapi.Server{
		// Paths the API does not claim are served from the Web dist embedded
		// in this binary (doc 21 §12: one artifact, no Node on the target).
		Web:           webui.Assets(),
		Deploy:        deploy,
		Auth:          auth.NewService(sqlite.NewAuthStore(db), sessionTTL),
		Devices:       device.NewService(sqlite.NewDeviceStore(db)),
		Spaces:        space.NewService(sqlite.NewSpaceStore(db)),
		Sync:          sync.NewService(sqlite.NewSyncStore(db), changesetSvc),
		Reconcile:     reconcile.NewService(sqlite.NewReconcileStore(db)),
		Library:       library.NewService(libraryStore, canonicalStore, changesetSvc),
		Changesets:    changesetSvc,
		Tokens:        token.NewService(tokenStore),
		Organizer:     organizerSvc,
		Transfer:      transfer.NewService(libraryStore, canonicalStore, changesetSvc),
		SpaceTransfer: spacetransfer.NewService(canonicalStore, changesetSvc),
		Plaza:         plaza.NewService(sqlite.NewPublicationStore(db), library.NewService(libraryStore, canonicalStore, changesetSvc), changesetSvc, canonicalStore),
		Backups:       backupSvc,
		Jobs:          jobSvc,
		Schedules:     scheduleSvc,
		// One store plays both halves: the grants it owns and the tree it may
		// read are the same aggregate's problem.
		StartPage:  startpage.NewService(sqlite.NewStartPageStore(db), sqlite.NewStartPageStore(db)),
		Accounts:   accountStore,
		InstanceID: instanceID,
		Logger:     logger,
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
