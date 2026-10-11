package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"pontis/internal/token"
)

// seedUser inserts the active account the token rows point at.
func seedUser(t *testing.T, db *sql.DB) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO users (id, username, username_normalized, display_name,
			password_hash, role, status, locale, password_changed_at, created_at, updated_at)
		VALUES ('u1', 'alice', 'alice', 'Alice', 'x', 'admin', 'active', 'zh-CN',
			'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err != nil {
		t.Fatalf("seeding user: %v", err)
	}
}

// mintToken stores one token with a deterministic secret hash. Revocation does
// not go through it: InsertToken writes a live row, and there is no revoked_at
// column in its statement, so revokes use the store's own Revoke below.
func mintToken(t *testing.T, store *TokenStore, id string, expires *time.Time) {
	t.Helper()
	secret := token.SecretPrefix + id
	if err := store.InsertToken(context.Background(), token.Token{
		ID: id, UserID: "u1", Name: id, Scopes: []string{"bookmarks:read"},
		SpaceScope: token.SpaceAll, CreatedAt: time.Now().UTC(), ExpiresAt: expires,
	}, secret[:min(12, len(secret))], token.SecretHash(secret)); err != nil {
		t.Fatalf("InsertToken %s: %v", id, err)
	}
}

func revokeToken(t *testing.T, store *TokenStore, id string, at time.Time) {
	t.Helper()
	if err := store.Revoke(context.Background(), id, at); err != nil {
		t.Fatalf("Revoke %s: %v", id, err)
	}
}

func timep(v time.Time) *time.Time { return &v }

func TestGetByHashAppliesExpiry(t *testing.T) {
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	seedUser(t, db)
	store := NewTokenStore(db)
	ctx := context.Background()
	now := time.Now().UTC()

	mintToken(t, store, "never", nil)
	mintToken(t, store, "future", timep(now.Add(24*time.Hour)))
	mintToken(t, store, "past", timep(now.Add(-time.Minute)))

	for _, c := range []struct {
		id      string
		wantErr bool
		why     string
	}{
		{"never", false, "a token without an expiry"},
		{"future", false, "a token whose expiry has not arrived"},
		{"past", true, "a token past its expiry"},
	} {
		t.Run(c.why, func(t *testing.T) {
			got, err := store.GetByHash(ctx, token.SecretHash(token.SecretPrefix+c.id))
			if c.wantErr {
				if !errors.Is(err, token.ErrTokenInvalid) {
					t.Errorf("err = %v, want ErrTokenInvalid", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("GetByHash: %v", err)
			}
			if got.ID != c.id {
				t.Errorf("loaded %q, want %q", got.ID, c.id)
			}
		})
	}

	// The expiry survives the round trip through the row, which is what the
	// list and the UI render.
	future, err := store.Get(ctx, "future")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if future.ExpiresAt == nil || !future.ExpiresAt.After(now) {
		t.Errorf("ExpiresAt = %v, want the stored instant back", future.ExpiresAt)
	}
}

func TestPurgeDeadTokensBefore(t *testing.T) {
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	seedUser(t, db)
	store := NewTokenStore(db)
	ctx := context.Background()
	now := time.Now().UTC()
	dead := now.Add(-120 * 24 * time.Hour)
	recent := now.Add(-24 * time.Hour)

	mintToken(t, store, "live", nil)
	mintToken(t, store, "expires-later", timep(now.Add(30*24*time.Hour)))
	mintToken(t, store, "expired-long-ago", timep(dead))
	mintToken(t, store, "revoked-long-ago", nil)
	mintToken(t, store, "expired-yesterday", timep(recent))
	mintToken(t, store, "revoked-yesterday", nil)
	revokeToken(t, store, "revoked-long-ago", dead)
	revokeToken(t, store, "revoked-yesterday", recent)

	n, err := store.PurgeDeadTokensBefore(ctx, now.Add(-90*24*time.Hour))
	if err != nil {
		t.Fatalf("PurgeDeadTokensBefore: %v", err)
	}
	if n != 2 {
		t.Errorf("purged %d rows, want 2", n)
	}

	rows, err := db.QueryContext(ctx, `SELECT id FROM api_tokens ORDER BY id`)
	if err != nil {
		t.Fatalf("reading survivors: %v", err)
	}
	defer rows.Close()
	kept := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scanning survivors: %v", err)
		}
		kept[id] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating survivors: %v", err)
	}
	for _, id := range []string{"expired-long-ago", "revoked-long-ago"} {
		if kept[id] {
			t.Errorf("%s survived a purge that should have removed it", id)
		}
	}
	for _, id := range []string{"live", "expires-later", "expired-yesterday", "revoked-yesterday"} {
		if !kept[id] {
			t.Errorf("%s was purged but should have survived, kept = %v", id, kept)
		}
	}
	if len(kept) != 4 {
		t.Errorf("%d rows left, want 4: %v", len(kept), kept)
	}

	// The secrets go with the rows: an orphaned hash would still resolve to
	// nothing, but it would also keep every refused secret forever.
	var secrets int
	if err := db.QueryRowContext(ctx,
		`SELECT count(*) FROM api_token_secrets`).Scan(&secrets); err != nil {
		t.Fatalf("counting secrets: %v", err)
	}
	if secrets != 4 {
		t.Errorf("%d secret rows left, want 4", secrets)
	}
}
