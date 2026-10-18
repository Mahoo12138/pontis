package space

import (
	"context"
	"errors"
	"testing"
	"time"

	"pontis/internal/canonical"
)

type fakeStore struct {
	created   []canonical.SyncSpace
	count     int64
	renamed   []renameCall
	renameOK  bool
	deleted   []canonical.SpaceID
	deleteOK  bool
	deleteErr error
}

type renameCall struct {
	id   canonical.SpaceID
	name string
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

func (f *fakeStore) RenameSpace(_ context.Context, _ canonical.UserID, id canonical.SpaceID, name string, at time.Time) (bool, error) {
	if at.IsZero() {
		panic("RenameSpace called with a zero timestamp")
	}
	f.renamed = append(f.renamed, renameCall{id: id, name: name})
	return f.renameOK, nil
}

func (f *fakeStore) DeleteSpace(_ context.Context, _ canonical.UserID, id canonical.SpaceID) (bool, error) {
	f.deleted = append(f.deleted, id)
	return f.deleteOK, f.deleteErr
}

// A rename is the same name contract as a creation: the title reaches backup
// and export file names, so a path segment must not get through this door
// either.
func TestRenameValidatesNames(t *testing.T) {
	for _, tc := range []struct {
		name string
		want error
	}{
		{"", ErrEmptyName},
		{"   ", ErrEmptyName},
		{"nested/name", ErrBadName},
		{"Renamed", nil},
	} {
		store := &fakeStore{renameOK: true}
		err := NewService(store).Rename(context.Background(), "user-1", "space-1", tc.name)
		if !errors.Is(err, tc.want) {
			t.Fatalf("Rename(%q) err = %v, want %v", tc.name, err, tc.want)
		}
		wantStored := tc.want == nil
		if wantStored && len(store.renamed) != 1 {
			t.Fatalf("Rename(%q) stored %+v, want one call", tc.name, store.renamed)
		}
		if !wantStored && len(store.renamed) != 0 {
			t.Fatalf("Rename(%q) reached the store despite %v", tc.name, tc.want)
		}
	}
}

func TestRenameReportsUnknownSpace(t *testing.T) {
	store := &fakeStore{renameOK: false}
	if err := NewService(store).Rename(context.Background(), "user-1", "space-x", "Renamed"); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("Rename err = %v, want ErrSpaceNotFound", err)
	}
}

// Deletion is guarded, not cascading: whatever the store refuses to remove
// must reach the caller as the same refusal rather than a silent success.
func TestDeleteSurfacesStoreOutcomes(t *testing.T) {
	empty := &fakeStore{deleteOK: true}
	if err := NewService(empty).Delete(context.Background(), "user-1", "space-1"); err != nil {
		t.Fatalf("Delete of an empty space: %v", err)
	}

	blocked := &fakeStore{deleteOK: false, deleteErr: ErrSpaceNotEmpty}
	if err := NewService(blocked).Delete(context.Background(), "user-1", "space-1"); !errors.Is(err, ErrSpaceNotEmpty) {
		t.Fatalf("Delete err = %v, want ErrSpaceNotEmpty", err)
	}
	if len(blocked.deleted) != 1 {
		t.Fatalf("Delete did not ask the store")
	}

	missing := &fakeStore{deleteOK: false}
	if err := NewService(missing).Delete(context.Background(), "user-1", "space-x"); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("Delete err = %v, want ErrSpaceNotFound", err)
	}
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
