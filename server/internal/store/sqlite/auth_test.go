package sqlite

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"pontis/internal/auth"
)

func setupAuthTest(t *testing.T) *auth.Service {
	t.Helper()
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return auth.NewService(NewAuthStore(db), 24*time.Hour)
}

func TestHashAndVerifyPassword(t *testing.T) {
	hash, err := auth.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if hash == "correct horse battery staple" {
		t.Fatal("hash must not contain the password")
	}

	ok, err := auth.VerifyPassword("correct horse battery staple", hash)
	if err != nil || !ok {
		t.Errorf("correct password rejected: ok=%v err=%v", ok, err)
	}

	ok, err = auth.VerifyPassword("wrong password", hash)
	if err != nil || ok {
		t.Errorf("wrong password accepted: ok=%v err=%v", ok, err)
	}

	// Two hashes of the same password differ (random salt).
	hash2, _ := auth.HashPassword("correct horse battery staple")
	if hash == hash2 {
		t.Error("salt not randomized")
	}
}

func TestFirstUserBecomesAdmin(t *testing.T) {
	svc := setupAuthTest(t)
	ctx := context.Background()

	needs, err := svc.NeedsSetup(ctx)
	if err != nil || !needs {
		t.Fatalf("NeedsSetup = %v, %v; want true", needs, err)
	}

	admin, err := svc.CreateUser(ctx, auth.CreateUserParams{
		Username: "alice", Password: "password123", DisplayName: "Alice",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if admin.Role != auth.RoleAdmin {
		t.Errorf("first user role = %q, want admin", admin.Role)
	}

	needs, err = svc.NeedsSetup(ctx)
	if err != nil || needs {
		t.Fatalf("NeedsSetup after bootstrap = %v, %v; want false", needs, err)
	}

	bob, err := svc.CreateUser(ctx, auth.CreateUserParams{
		Username: "bob", Password: "password456",
	})
	if err != nil {
		t.Fatalf("CreateUser bob: %v", err)
	}
	if bob.Role != auth.RoleUser {
		t.Errorf("second user role = %q, want user", bob.Role)
	}
	if bob.DisplayName != "bob" {
		t.Errorf("default display name = %q, want username", bob.DisplayName)
	}
}

func TestCreateUserValidation(t *testing.T) {
	svc := setupAuthTest(t)
	ctx := context.Background()

	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "ab", Password: "password123"}); !errors.Is(err, auth.ErrInvalidUsername) {
		t.Errorf("short username: err = %v, want ErrInvalidUsername", err)
	}
	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "bad name!", Password: "password123"}); !errors.Is(err, auth.ErrInvalidUsername) {
		t.Errorf("invalid charset: err = %v, want ErrInvalidUsername", err)
	}
	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "valid", Password: "short"}); !errors.Is(err, auth.ErrInvalidPassword) {
		t.Errorf("short password: err = %v, want ErrInvalidPassword", err)
	}

	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "alice", Password: "password123"}); err != nil {
		t.Fatalf("seed alice: %v", err)
	}
	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "Alice", Password: "password123"}); !errors.Is(err, auth.ErrUserExists) {
		t.Errorf("duplicate username: err = %v, want ErrUserExists", err)
	}
	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "bob", Password: "password123", Email: "a@x.com"}); err != nil {
		t.Fatalf("seed bob: %v", err)
	}
	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "carol", Password: "password123", Email: "A@X.com"}); !errors.Is(err, auth.ErrEmailTaken) {
		t.Errorf("duplicate email: err = %v, want ErrEmailTaken", err)
	}
}

func TestLoginSessionLifecycle(t *testing.T) {
	svc := setupAuthTest(t)
	ctx := context.Background()

	if _, _, _, err := svc.Login(ctx, "alice", "password123", "ua"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("unknown user: err = %v, want ErrInvalidCredentials", err)
	}

	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "alice", Password: "password123"}); err != nil {
		t.Fatal(err)
	}

	token, sess, user, err := svc.Login(ctx, "alice", "password123", "test-agent")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if token == "" {
		t.Fatal("token must not be empty")
	}
	if sess.TokenHash == token {
		t.Fatal("stored hash must not equal raw token")
	}
	if user.ID == "" {
		t.Fatal("user must be resolved")
	}

	// Wrong password.
	if _, _, _, err := svc.Login(ctx, "alice", "wrong-pass", "ua"); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Errorf("wrong password: err = %v, want ErrInvalidCredentials", err)
	}

	// Verify round trip.
	gotSess, gotUser, err := svc.VerifySession(ctx, token)
	if err != nil {
		t.Fatalf("VerifySession: %v", err)
	}
	if gotSess.ID != sess.ID || gotUser.ID != user.ID {
		t.Error("session/user mismatch after verify")
	}

	// Logout then verify fails.
	if err := svc.Logout(ctx, token); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if _, _, err := svc.VerifySession(ctx, token); !errors.Is(err, auth.ErrSessionInvalid) {
		t.Errorf("verify after logout: err = %v, want ErrSessionInvalid", err)
	}
}

func TestSessionExpiry(t *testing.T) {
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	// TTL in the past: every session is instantly expired.
	svc := auth.NewService(NewAuthStore(db), -time.Minute)
	ctx := context.Background()

	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "alice", Password: "password123"}); err != nil {
		t.Fatal(err)
	}
	token, _, _, err := svc.Login(ctx, "alice", "password123", "ua")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if _, _, err := svc.VerifySession(ctx, token); !errors.Is(err, auth.ErrSessionInvalid) {
		t.Errorf("expired session: err = %v, want ErrSessionInvalid", err)
	}
}

func TestDisabledUserRejected(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}

	svc := auth.NewService(NewAuthStore(db), 24*time.Hour)
	ctx := context.Background()
	if _, err := svc.CreateUser(ctx, auth.CreateUserParams{Username: "alice", Password: "password123"}); err != nil {
		t.Fatal(err)
	}
	token, _, _, err := svc.Login(ctx, "alice", "password123", "ua")
	if err != nil {
		t.Fatal(err)
	}

	// Disable the user directly in the store.
	if _, err := db.Exec(`UPDATE users SET status = 'disabled' WHERE username_normalized = 'alice'`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.VerifySession(ctx, token); !errors.Is(err, auth.ErrUserDisabled) {
		t.Errorf("disabled user session: err = %v, want ErrUserDisabled", err)
	}
	if _, _, _, err := svc.Login(ctx, "alice", "password123", "ua"); !errors.Is(err, auth.ErrUserDisabled) {
		t.Errorf("disabled user login: err = %v, want ErrUserDisabled", err)
	}
}
