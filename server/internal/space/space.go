// Package space implements sync space lifecycle: creation with the default
// root slot and owner-scoped listing.
package space

import (
	"context"
	"errors"
	"time"

	"pontis/internal/canonical"
)

// Errors.
var (
	// ErrEmptyName is returned when the space name is blank.
	ErrEmptyName = errors.New("space: name must not be empty")
	// ErrTooManySpaces guards the V1 soft limit per owner.
	ErrTooManySpaces = errors.New("space: too many spaces")
)

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
}

// Service implements space lifecycle.
type Service struct {
	store Store
}

// NewService returns a space service.
func NewService(store Store) *Service { return &Service{store: store} }

// Create creates a space with the default root slot.
func (s *Service) Create(ctx context.Context, owner canonical.UserID, name string) (canonical.SyncSpace, error) {
	if name == "" {
		return canonical.SyncSpace{}, ErrEmptyName
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
