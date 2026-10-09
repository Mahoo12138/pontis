package space

import (
	"context"
	"errors"
	"testing"

	"pontis/internal/canonical"
)

type fakeStore struct {
	created []canonical.SyncSpace
	count   int64
}

func (f *fakeStore) CreateSpace(_ context.Context, s canonical.SyncSpace, _ string) error {
	f.created = append(f.created, s)
	return nil
}

func (f *fakeStore) ListByOwner(_ context.Context, _ canonical.UserID) ([]canonical.SyncSpace, error) {
	return f.created, nil
}

func (f *fakeStore) CountByOwner(_ context.Context, _ canonical.UserID) (int64, error) {
	return f.count, nil
}

// A space title ends up in backup file names, so a name carrying a path
// segment is refused at the boundary instead of being sanitized downstream.
func TestCreateValidatesNames(t *testing.T) {
	for _, tc := range []struct {
		name string
		want error
	}{
		{"", ErrEmptyName},
		{"   ", ErrEmptyName},
		{"../../etc/passwd", ErrBadName},
		{`a\b`, ErrBadName},
		{"nested/name", ErrBadName},
		{"..", ErrBadName},
		{"line\nbreak", ErrBadName},
		{"Personal", nil},
		{"工作 · 项目", nil},
	} {
		store := &fakeStore{}
		svc := NewService(store)
		_, err := svc.Create(context.Background(), "user-1", tc.name)
		if !errors.Is(err, tc.want) {
			t.Fatalf("Create(%q) err = %v, want %v", tc.name, err, tc.want)
		}
		if tc.want != nil {
			if len(store.created) != 0 {
				t.Fatalf("Create(%q) reached the store despite %v", tc.name, tc.want)
			}
			continue
		}
		if len(store.created) != 1 || store.created[0].Name != tc.name {
			t.Fatalf("Create(%q) stored %+v", tc.name, store.created)
		}
		if store.created[0].CreatedAt.IsZero() || store.created[0].Epoch != 1 {
			t.Fatalf("Create(%q) stored %+v", tc.name, store.created[0])
		}
	}
}
