package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"pontis/internal/canonical"
	"pontis/internal/device"
)

// setupDeviceTest returns a device service with a seeded user "u1" and a
// space "s1" (epoch 1) owned by that user.
func setupDeviceTest(t *testing.T) (*device.Service, *sqlDBHelper) {
	t.Helper()
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO users (id, username, username_normalized, display_name, password_hash, role, status, locale, password_changed_at, created_at, updated_at)
		VALUES ('u1', 'alice', 'alice', 'Alice', 'x', 'admin', 'active', 'zh-CN', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO sync_spaces (id, owner_user_id, name, created_at, updated_at)
		VALUES ('s1', 'u1', 'Main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users (id, username, username_normalized, display_name, password_hash, role, status, locale, password_changed_at, created_at, updated_at)
		VALUES ('u2', 'bob', 'bob', 'Bob', 'x', 'user', 'active', 'zh-CN', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO sync_spaces (id, owner_user_id, name, created_at, updated_at)
		VALUES ('s2', 'u2', 'Bobs', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	return device.NewService(NewDeviceStore(db)), &sqlDBHelper{db: db}
}

type sqlDBHelper struct {
	db *sql.DB
}

func TestRegisterAndAuthenticateDevice(t *testing.T) {
	svc, _ := setupDeviceTest(t)
	ctx := context.Background()

	dev, secret, err := svc.RegisterDevice(ctx, "u1", "Edge@Home", "extension", "edge", "windows")
	if err != nil {
		t.Fatalf("RegisterDevice: %v", err)
	}
	if secret == "" || len(secret) < 40 {
		t.Fatalf("secret must be non-trivial: %q", secret)
	}

	gotDev, _, err := svc.Authenticate(ctx, secret)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if gotDev.ID != dev.ID {
		t.Errorf("device id mismatch: %s != %s", gotDev.ID, dev.ID)
	}

	// Wrong token.
	if _, _, err := svc.Authenticate(ctx, "pdv_bogus"); !errors.Is(err, device.ErrCredentialInvalid) {
		t.Errorf("bogus token: err = %v, want ErrCredentialInvalid", err)
	}

	// Revoke kills the credential (device and credentials are revoked
	// together, so the credential check fires first).
	if err := svc.RevokeDevice(ctx, dev.ID); err != nil {
		t.Fatalf("RevokeDevice: %v", err)
	}
	if _, _, err := svc.Authenticate(ctx, secret); !errors.Is(err, device.ErrCredentialInvalid) {
		t.Errorf("revoked device: err = %v, want ErrCredentialInvalid", err)
	}
}

func TestAuthenticateGatesOnOwnerAccountStatus(t *testing.T) {
	svc, h := setupDeviceTest(t)
	ctx := context.Background()

	dev, secret, err := svc.RegisterDevice(ctx, "u1", "Edge@Home", "extension", "edge", "windows")
	if err != nil {
		t.Fatalf("RegisterDevice: %v", err)
	}
	if _, _, err := svc.Authenticate(ctx, secret); err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	usedAt := func() string {
		t.Helper()
		var lastUsed sql.NullString
		if err := h.db.QueryRowContext(ctx,
			`SELECT c.last_used_at FROM device_credentials c WHERE c.device_id = ?`, dev.ID).Scan(&lastUsed); err != nil {
			t.Fatal(err)
		}
		return lastUsed.String
	}
	before := usedAt()
	if before == "" {
		t.Fatalf("the accepted attempt should have stamped last_used_at")
	}

	// Disabling an account rewrites users.status and drops web sessions;
	// the device credential of that account has to be refused as well.
	if _, err := h.db.ExecContext(ctx,
		`UPDATE users SET status = 'disabled' WHERE id = 'u1'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Authenticate(ctx, secret); !errors.Is(err, device.ErrAccountDisabled) {
		t.Fatalf("disabled owner: err = %v, want ErrAccountDisabled", err)
	}

	// A refused credential is not activity.
	if after := usedAt(); after != before {
		t.Errorf("disabled owner moved last_used_at from %q to %q", before, after)
	}

	// Policy: disable gates credentials, revoke kills them. The same secret
	// works again as soon as the account is active.
	if _, err := h.db.ExecContext(ctx,
		`UPDATE users SET status = 'active' WHERE id = 'u1'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Authenticate(ctx, secret); err != nil {
		t.Fatalf("re-enabled owner: Authenticate = %v", err)
	}
}

func TestBindSpaceLifecycle(t *testing.T) {
	svc, h := setupDeviceTest(t)
	ctx := context.Background()

	dev, _, err := svc.RegisterDevice(ctx, "u1", "Edge@Home", "extension", "edge", "windows")
	if err != nil {
		t.Fatal(err)
	}

	b, err := svc.BindSpace(ctx, dev.ID, canonical.SpaceID("s1"))
	if err != nil {
		t.Fatalf("BindSpace: %v", err)
	}
	if b.State != device.StatePendingInitial {
		t.Errorf("state = %q, want pending_initial", b.State)
	}
	if b.Epoch != 1 {
		t.Errorf("epoch = %d, want 1", b.Epoch)
	}

	var mode string
	if err := h.db.QueryRow(`SELECT sync_mode FROM devices WHERE id = ?`, dev.ID).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "partial" {
		t.Errorf("sync_mode = %q, want partial (implicit after first binding)", mode)
	}

	// A second bind of a still-pending space hands the same row back: the
	// device may have dropped its local replica and be starting over, and a
	// conflict would leave it nothing to bind to.
	again, err := svc.BindSpace(ctx, dev.ID, canonical.SpaceID("s1"))
	if err != nil {
		t.Fatalf("rebind a pending space: %v", err)
	}
	if again.ID != b.ID {
		t.Errorf("rebind opened %s, want the existing row %s", again.ID, b.ID)
	}

	// Once the binding is live, its watermarks describe a replica the
	// requester does not hold, so binding again stays a conflict.
	if _, err := h.db.ExecContext(ctx,
		`UPDATE device_space_bindings SET state = 'active' WHERE id = ?`, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.BindSpace(ctx, dev.ID, canonical.SpaceID("s1")); !errors.Is(err, device.ErrBindingExists) {
		t.Errorf("rebind an active space: err = %v, want ErrBindingExists", err)
	}

	// Foreign space rejected.
	if _, err := svc.BindSpace(ctx, dev.ID, canonical.SpaceID("s2")); !errors.Is(err, device.ErrNotSpaceOwner) {
		t.Errorf("foreign space: err = %v, want ErrNotSpaceOwner", err)
	}

	// Unknown space rejected.
	if _, err := svc.BindSpace(ctx, dev.ID, canonical.SpaceID("nope")); !errors.Is(err, device.ErrSpaceNotFound) {
		t.Errorf("unknown space: err = %v, want ErrSpaceNotFound", err)
	}
}

func TestFullModeSingleBinding(t *testing.T) {
	svc, h := setupDeviceTest(t)
	ctx := context.Background()

	dev, _, err := svc.RegisterDevice(ctx, "u1", "Edge@Home", "extension", "edge", "windows")
	if err != nil {
		t.Fatal(err)
	}
	// Force full mode with one existing binding.
	if _, err := svc.BindSpace(ctx, dev.ID, canonical.SpaceID("s1")); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`UPDATE devices SET sync_mode = 'full' WHERE id = ?`, dev.ID); err != nil {
		t.Fatal(err)
	}
	// Full devices cannot gain a second space: create a second own space.
	if _, err := h.db.Exec(`INSERT INTO sync_spaces (id, owner_user_id, name, created_at, updated_at)
		VALUES ('s3', 'u1', 'Second', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.BindSpace(ctx, dev.ID, canonical.SpaceID("s3")); !errors.Is(err, device.ErrFullBindingLimit) {
		t.Errorf("second binding on full device: err = %v, want ErrFullBindingLimit", err)
	}
}
