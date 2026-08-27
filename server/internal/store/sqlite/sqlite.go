// Package sqlite provides the SQLite-backed store: connection setup with the
// required pragmas and the forward-only migration runner.
package sqlite

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver"
)

// Open opens (creating if needed) the SQLite database at dbPath with the
// baseline pragmas from the design docs: WAL journal, foreign keys on,
// busy timeout and synchronous FULL.
//
// A single connection is used to serialize writers and avoid SQLITE_BUSY
// under the correctness-first V1 policy.
func Open(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dsn := "file:" + filepath.ToSlash(dbPath) +
		"?_pragma=foreign_keys(1)" +
		"&_pragma=journal_mode(WAL)" +
		"&_pragma=busy_timeout(5000)" +
		"&_pragma=synchronous(FULL)"

	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	return db, nil
}

// now returns the canonical timestamp format used across the schema
// (UTC RFC3339 with nanoseconds).
func now() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
