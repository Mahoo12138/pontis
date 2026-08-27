// Package app is the composition root: it wires config, storage and the
// HTTP server together and owns the process lifecycle.
package app

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"pontis/internal/config"
	"pontis/internal/logging"
)

// App holds the fully wired runtime dependencies.
type App struct {
	Config config.Config
	Logger *slog.Logger
}

// Run boots the server and blocks until ctx is cancelled or the HTTP
// server fails. It performs a graceful shutdown with the configured timeout.
func Run(ctx context.Context, cfg config.Config) error {
	logger := logging.New(cfg.LogLevel)
	a := &App{Config: cfg, Logger: logger}

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           a.routes(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("server listening", "addr", cfg.Listen, "data_dir", cfg.DataDir)
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

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	return mux
}
