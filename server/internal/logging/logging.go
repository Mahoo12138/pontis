// Package logging configures the process-wide slog logger.
package logging

import (
	"log/slog"
	"os"
	"strings"
)

// New returns a JSON slog.Logger for the given level string
// (debug | info | warn | error). Unknown levels fall back to info.
func New(level string) *slog.Logger {
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: parseLevel(level),
	}))
}

func parseLevel(level string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
