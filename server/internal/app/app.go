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
	"pontis/internal/config"
	"pontis/internal/device"
	"pontis/internal/httpapi"
	"pontis/internal/library"
	"pontis/internal/organizer"
	"pontis/internal/plaza"
	"pontis/internal/transfer"
	"pontis/internal/logging"
	"pontis/internal/space"
	"pontis/internal/store/sqlite"
	"pontis/internal/sync"
	"pontis/internal/token"
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
	backupSvc, err := backup.NewService(sqlite.NewBackupStore(db), sqlite.NewLibraryStore(db),
		filepath.Join(cfg.DataDir, "backups"))
	if err != nil {
		return err
	}
	api := &httpapi.Server{
		Auth:       auth.NewService(sqlite.NewAuthStore(db), sessionTTL),
		Devices:    device.NewService(sqlite.NewDeviceStore(db)),
		Spaces:     space.NewService(sqlite.NewSpaceStore(db)),
		Sync:       sync.NewService(sqlite.NewSyncStore(db)),
		Library:    library.NewService(sqlite.NewLibraryStore(db), sqlite.NewStore(db)),
		Tokens:     token.NewService(sqlite.NewTokenStore(db)),
		Organizer:  organizer.NewService(sqlite.NewLibraryStore(db)),
		Transfer:  transfer.NewService(sqlite.NewLibraryStore(db), sqlite.NewStore(db)),
		Plaza:      plaza.NewService(sqlite.NewPublicationStore(db), library.NewService(sqlite.NewLibraryStore(db), sqlite.NewStore(db)), sqlite.NewStore(db)),
		Backups:    backupSvc,
		Accounts:   accountStore,
		InstanceID: instanceID,
		Logger:     logger,
	}

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
