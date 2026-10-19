// Package space implements sync space lifecycle: creation with the default
// root slot and owner-scoped listing.
package space

import (
	"context"
	"errors"
	"strings"
	"time"

	"pontis/internal/canonical"
)

// Errors.
var (
	// ErrEmptyName is returned when the space name is blank.
	ErrEmptyName = errors.New("space: name must not be empty")
	// ErrBadName is returned when the name is not a plain display string.
	// Space titles reach backup file names and the browser's download
	// naming, so path segments and control characters are rejected here
	// rather than sanitized everywhere downstream.
	ErrBadName = errors.New("space: name must not contain path separators or control characters")
	// ErrTooManySpaces guards the V1 soft limit per owner.
	ErrTooManySpaces = errors.New("space: too many spaces")
	// ErrSpaceNotFound is returned when the id is not one of the owner's spaces.
	ErrSpaceNotFound = errors.New("space: no such space for this owner")
	// ErrSpaceNotEmpty guards deletion. Five tables reference sync_spaces(id)
	// with no ON DELETE clause and foreign_keys is on, so a space holding nodes,
	// backups, bindings, publications or schedules cannot be removed without
	// first deciding what happens to each of them. V1 decides: it does not. The
	// API refuses and says why, rather than half-cascading.
	ErrSpaceNotEmpty = errors.New("space: space still has content or devices bound to it")
)

// SpaceBlocker names one kind of row that keeps a space from being deleted.
// The set is the tables that reference sync_spaces(id); see ErrSpaceNotEmpty.
type SpaceBlocker string

const (
	BlockerContent     SpaceBlocker = "content"
	BlockerBinding     SpaceBlocker = "binding"
	BlockerBackup      SpaceBlocker = "backup"
	BlockerPublication SpaceBlocker = "publication"
	BlockerSchedule    SpaceBlocker = "schedule"
)

// NotEmptyError carries every blocker found in one pass, not just the first.
// A space emptied of bookmarks but still bound to a device was told it "still
// has bookmarks, backups or devices" — a sentence that describes three things
// and rules out none of them, so the reader could not act on it. Reporting the
// set lets the answer name what is actually left.
type NotEmptyError struct {
	Blockers []SpaceBlocker
}

func (e *NotEmptyError) Error() string {
	parts := make([]string, 0, len(e.Blockers))
	for _, b := range e.Blockers {
		parts = append(parts, string(b))
	}
	return "space: still referenced by " + strings.Join(parts, ", ")
}

// Is keeps `errors.Is(err, ErrSpaceNotEmpty)` working for callers that only
// need to know that the space was not empty.
func (e *NotEmptyError) Is(target error) bool { return target == ErrSpaceNotEmpty }

// MaxSpacesPerUser is the V1 soft limit.
const MaxSpacesPerUser = 16

// DefaultRootKey is the root slot every new space starts with.
const DefaultRootKey = "main"

// Store is the persistence contract required by the space service.
type Store interface {
	// CreateSpace inserts the space and its default root slot atomically.
	CreateSpace(ctx context.Context, s canonical.SyncSpace, rootDisplayName string) error

	// ListByOwner returns the owner's spaces ordered by creation.
	ListByOwner(ctx context.Context, owner canonical.UserID) ([]canonical.SyncSpace, error)

	// CountByOwner returns how many spaces the owner has.
	CountByOwner(ctx context.Context, owner canonical.UserID) (int64, error)

	// RenameSpace sets the display name of one of the owner's spaces. It
	// reports false when the id is not theirs, so the caller can answer 404
	// rather than pretending a rename succeeded somewhere else.
	RenameSpace(ctx context.Context, owner canonical.UserID, id canonical.SpaceID, name string, at time.Time) (bool, error)

	// DeleteSpace removes an empty space together with its root slots, and
	// clears it from the owner's default. It reports false without deleting
	// anything when the id is not the owner's or when any other row still
	// refers to the space.
	DeleteSpace(ctx context.Context, owner canonical.UserID, id canonical.SpaceID) (bool, error)
}

// Service implements space lifecycle.
type Service struct {
	store Store
}

// NewService returns a space service.
func NewService(store Store) *Service { return &Service{store: store} }

// Create creates a space with the default root slot.
func (s *Service) Create(ctx context.Context, owner canonical.UserID, name string) (canonical.SyncSpace, error) {
	if err := ValidateName(name); err != nil {
		return canonical.SyncSpace{}, err
	}
	if n, err := s.store.CountByOwner(ctx, owner); err != nil {
		return canonical.SyncSpace{}, err
	} else if n >= MaxSpacesPerUser {
		return canonical.SyncSpace{}, ErrTooManySpaces
	}

	id, err := newSpaceID()
	if err != nil {
		return canonical.SyncSpace{}, err
	}
	now := time.Now().UTC()
	created := canonical.SyncSpace{
		ID:          canonical.SpaceID(id),
		OwnerUserID: owner,
		Name:        name,
		Epoch:       1,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.store.CreateSpace(ctx, created, "Main"); err != nil {
		return canonical.SyncSpace{}, err
	}
	return created, nil
}

// List returns the owner's spaces.
func (s *Service) List(ctx context.Context, owner canonical.UserID) ([]canonical.SyncSpace, error) {
	return s.store.ListByOwner(ctx, owner)
}

// Rename changes a space's display name. The name goes through the same
// validation as creation, because it reaches backup and export file names.
func (s *Service) Rename(ctx context.Context, owner canonical.UserID, id canonical.SpaceID, name string) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	renamed, err := s.store.RenameSpace(ctx, owner, id, name, time.Now().UTC())
	if err != nil {
		return err
	}
	if !renamed {
		return ErrSpaceNotFound
	}
	return nil
}

// Delete removes a space, but only while nothing refers to it. A blocked
// deletion comes back as ErrSpaceNotEmpty from the store, which is what the
// API surfaces; a silent cascade is not available at this layer.
func (s *Service) Delete(ctx context.Context, owner canonical.UserID, id canonical.SpaceID) error {
	deleted, err := s.store.DeleteSpace(ctx, owner, id)
	if err != nil {
		return err
	}
	if !deleted {
		return ErrSpaceNotFound
	}
	return nil
}

// ValidateName accepts a space title once it can safely appear in a file
// name: non-blank, no path separators, no control characters.
func ValidateName(name string) error {
	if strings.TrimSpace(name) == "" {
		return ErrEmptyName
	}
	if strings.ContainsAny(name, `/\`) {
		return ErrBadName
	}
	if name == "." || name == ".." {
		return ErrBadName
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return ErrBadName
		}
	}
	return nil
}
