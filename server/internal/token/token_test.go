package token

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"pontis/internal/canonical"
)

// fakeStore is an in-memory Store for unit-testing the token service.
type fakeStore struct {
	inserted    []Token
	insertedAny bool
	revokedID   string
	revokedAt   time.Time
	tokens      []Token // returned by ListByUser / Get
}

func (f *fakeStore) InsertToken(_ context.Context, t Token, _ /*prefix*/, _ /*hash*/ string) error {
	f.inserted = append(f.inserted, t)
	f.insertedAny = true
	return nil
}

func (f *fakeStore) ListByUser(_ context.Context, _ canonical.UserID) ([]Token, error) {
	return f.tokens, nil
}

func (f *fakeStore) Get(_ context.Context, id string) (Token, error) {
	for _, t := range f.tokens {
		if t.ID == id {
			return t, nil
		}
	}
	return Token{}, ErrTokenNotFound
}

func (f *fakeStore) Revoke(_ context.Context, id string, at time.Time) error {
	f.revokedID = id
	f.revokedAt = at
	return nil
}

const validScope = string(ScopeBookmarksRead)

func TestCreateValidation(t *testing.T) {
	cases := []struct {
		name    string
		params  CreateParams
		wantErr error
	}{
		{"empty name", CreateParams{Name: "", Scopes: []string{validScope}}, ErrNameRequired},
		{"no scopes", CreateParams{Name: "ci", Scopes: nil}, ErrInvalidScopes},
		{"unknown scope", CreateParams{Name: "ci", Scopes: []string{"space:delete"}}, ErrInvalidScopes},
		{"one bad scope among good", CreateParams{Name: "ci", Scopes: []string{validScope, "nope"}}, ErrInvalidScopes},
		{"empty space scope json", CreateParams{Name: "ci", Scopes: []string{validScope}, SpaceScope: "[]"}, ErrInvalidScopes},
		{"space scope not json", CreateParams{Name: "ci", Scopes: []string{validScope}, SpaceScope: "space-1"}, ErrInvalidScopes},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := NewService(&fakeStore{})
			_, _, err := s.Create(context.Background(), "u1", c.params)
			if !errors.Is(err, c.wantErr) {
				t.Errorf("Create err = %v, want %v", err, c.wantErr)
			}
		})
	}
}

func TestCreateSuccess(t *testing.T) {
	store := &fakeStore{}
	s := NewService(store)
	tok, secret, err := s.Create(context.Background(), canonical.UserID("u1"), CreateParams{
		Name:   "ci token",
		Scopes: []string{string(ScopeBookmarksRead), string(ScopeBackupsWrite)},
	})
	if err != nil {
		t.Fatalf("Create error: %v", err)
	}
	if tok.ID == "" || tok.Name != "ci token" || tok.UserID != "u1" {
		t.Errorf("unexpected token: %+v", tok)
	}
	if tok.SpaceScope != SpaceAll {
		t.Errorf("SpaceScope = %q, want default %q", tok.SpaceScope, SpaceAll)
	}
	if tok.CreatedAt.IsZero() {
		t.Error("CreatedAt is zero")
	}
	if !strings.HasPrefix(secret, "pnt_") {
		t.Errorf("secret = %q, want pnt_ prefix", secret)
	}
	if len(store.inserted) != 1 {
		t.Fatalf("store received %d inserts, want 1", len(store.inserted))
	}
	if store.inserted[0].ID != tok.ID {
		t.Error("stored token id differs from returned token")
	}
}

func TestCreateWithSpaceScopeList(t *testing.T) {
	store := &fakeStore{}
	s := NewService(store)
	_, _, err := s.Create(context.Background(), "u1", CreateParams{
		Name:       "scoped",
		Scopes:     []string{validScope},
		SpaceScope: `["space-a","space-b"]`,
	})
	if err != nil {
		t.Fatalf("Create with space scope list error: %v", err)
	}
	if got := store.inserted[0].SpaceScope; got != `["space-a","space-b"]` {
		t.Errorf("SpaceScope = %q, want the provided JSON list", got)
	}
}

func TestListFiltersRevoked(t *testing.T) {
	now := time.Now().UTC()
	active := Token{ID: "t1", Name: "active"}
	revoked := Token{ID: "t2", Name: "revoked", RevokedAt: &now}
	store := &fakeStore{tokens: []Token{active, revoked}}
	s := NewService(store)

	got, err := s.List(context.Background(), "u1")
	if err != nil {
		t.Fatalf("List error: %v", err)
	}
	if len(got) != 1 || got[0].ID != "t1" {
		t.Errorf("List = %+v, want only the non-revoked token", got)
	}
}

func TestRevoke(t *testing.T) {
	t.Run("own token revoked", func(t *testing.T) {
		store := &fakeStore{tokens: []Token{{ID: "t1", UserID: "u1"}}}
		s := NewService(store)
		if err := s.Revoke(context.Background(), "u1", "t1"); err != nil {
			t.Fatalf("Revoke error: %v", err)
		}
		if store.revokedID != "t1" {
			t.Errorf("store.Revoke id = %q, want t1", store.revokedID)
		}
		if store.revokedAt.IsZero() {
			t.Error("store.Revoke received zero timestamp")
		}
	})
	t.Run("unknown id", func(t *testing.T) {
		store := &fakeStore{}
		s := NewService(store)
		if err := s.Revoke(context.Background(), "u1", "missing"); !errors.Is(err, ErrTokenNotFound) {
			t.Errorf("Revoke err = %v, want ErrTokenNotFound", err)
		}
	})
	t.Run("other user's token is not revocable", func(t *testing.T) {
		store := &fakeStore{tokens: []Token{{ID: "t1", UserID: "someone-else"}}}
		s := NewService(store)
		if err := s.Revoke(context.Background(), "u1", "t1"); !errors.Is(err, ErrTokenNotFound) {
			t.Errorf("Revoke err = %v, want ErrTokenNotFound (resource ids are not capabilities)", err)
		}
		if store.revokedID != "" {
			t.Error("store.Revoke was called for a foreign token")
		}
	})
}
