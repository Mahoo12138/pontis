package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"pontis/migrations"
)

// Migrate applies all pending embedded migrations in forward-only order.
// A failed migration aborts startup; there are no down migrations.
// On first run it also seeds server_meta.instance_id.
func Migrate(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	files, err := migrationFiles()
	if err != nil {
		return err
	}

	applied, err := appliedVersions(ctx, db)
	if err != nil {
		return err
	}

	for _, f := range files {
		if _, ok := applied[f.version]; ok {
			continue
		}
		if err := applyMigration(ctx, db, f); err != nil {
			return err
		}
	}

	return seedInstanceID(ctx, db)
}

type migrationFile struct {
	version int
	name    string
}

func migrationFiles() ([]migrationFile, error) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}

	var files []migrationFile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		versionStr := strings.SplitN(e.Name(), "_", 2)[0]
		version, err := strconv.Atoi(versionStr)
		if err != nil {
			return nil, fmt.Errorf("migration %s: invalid version prefix %q", e.Name(), versionStr)
		}
		files = append(files, migrationFile{version: version, name: e.Name()})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].version < files[j].version })
	return files, nil
}

func appliedVersions(ctx context.Context, db *sql.DB) (map[int]struct{}, error) {
	rows, err := db.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("list applied migrations: %w", err)
	}
	defer rows.Close()

	applied := make(map[int]struct{})
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		applied[v] = struct{}{}
	}
	return applied, rows.Err()
}

func applyMigration(ctx context.Context, db *sql.DB, f migrationFile) error {
	content, err := migrations.FS.ReadFile(path.Join(".", f.name))
	if err != nil {
		return fmt.Errorf("read migration %s: %w", f.name, err)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, string(content)); err != nil {
		return fmt.Errorf("apply migration %s: %w", f.name, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		f.version, now()); err != nil {
		return fmt.Errorf("record migration %s: %w", f.name, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", f.name, err)
	}
	return nil
}

// seedInstanceID assigns a stable random instance identifier on first boot.
func seedInstanceID(ctx context.Context, db *sql.DB) error {
	var exists bool
	err := db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM server_meta WHERE key = 'instance_id')`).
		Scan(&exists)
	if err != nil {
		return fmt.Errorf("check instance_id: %w", err)
	}
	if exists {
		return nil
	}

	id, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate instance_id: %w", err)
	}
	_, err = db.ExecContext(ctx,
		`INSERT INTO server_meta (key, value) VALUES ('instance_id', ?)`, id.String())
	if err != nil {
		return fmt.Errorf("seed instance_id: %w", err)
	}
	_, err = db.ExecContext(ctx,
		`INSERT INTO server_meta (key, value) VALUES ('created_at', ?)`, now())
	if err != nil {
		return fmt.Errorf("seed created_at: %w", err)
	}
	return nil
}
