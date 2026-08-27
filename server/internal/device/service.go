package device

import (
	"context"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Store is the persistence contract required by the device service.
type Store interface {
	// InsertDevice stores a device and its initial credential atomically.
	InsertDevice(ctx context.Context, d Device, cred Credential) error

	// GetDevice loads a device by id.
	GetDevice(ctx context.Context, id string) (Device, error)

	// GetCredentialByTokenHash loads a credential with its device.
	GetCredentialByTokenHash(ctx context.Context, tokenHash string) (Credential, Device, error)

	// TouchCredential updates credential last_used_at.
	TouchCredential(ctx context.Context, credID string, at time.Time) error

	// RevokeDevice marks the device and all its credentials revoked.
	RevokeDevice(ctx context.Context, deviceID string, at time.Time) error

	// CountBindings returns the number of bindings of a device.
	CountBindings(ctx context.Context, deviceID string) (int64, error)

	// SetDeviceSyncMode records the device sync mode.
	SetDeviceSyncMode(ctx context.Context, deviceID string, mode SyncMode) error

	// InsertBinding creates a binding. The store verifies the target space
	// exists and is owned by the device owner.
	InsertBinding(ctx context.Context, b Binding) error

	// GetBinding loads the binding of a device for a space.
	GetBinding(ctx context.Context, deviceID string, space canonical.SpaceID) (Binding, error)

	// ActivateBinding moves a pending binding to active and stamps
	// initialized_at.
	ActivateBinding(ctx context.Context, bindingID string, at time.Time) error

	// UpdateBindingSync advances the binding watermarks after a successful
	// sync round.
	UpdateBindingSync(ctx context.Context, bindingID string, appliedRevision, receivedRevision, maxClientSeq int64, lastSyncAt time.Time) error
}

// Service implements device and binding lifecycle.
type Service struct {
	store Store
}

// NewService returns a device service.
func NewService(store Store) *Service { return &Service{store: store} }

// RegisterDevice creates a device owned by user and returns the one-time
// device secret. The secret is never retrievable again.
func (s *Service) RegisterDevice(ctx context.Context, ownerUserID canonical.UserID, name, clientType, browser, platform string) (Device, string, error) {
	now := time.Now().UTC()
	deviceID, err := uuid.NewV7()
	if err != nil {
		return Device{}, "", err
	}
	d := Device{
		ID:          deviceID.String(),
		OwnerUserID: ownerUserID,
		Name:        name,
		ClientType:  clientType,
		Browser:     browser,
		Platform:    platform,
		CreatedAt:   now,
	}

	token, prefix, hash, err := newDeviceToken()
	if err != nil {
		return Device{}, "", err
	}

	if err := s.store.InsertDevice(ctx, d, Credential{
		TokenPrefix: prefix,
		TokenHash:   hash,
		CreatedAt:   now,
	}); err != nil {
		return Device{}, "", err
	}
	return d, token, nil
}

// Authenticate resolves a device token to its device. Revoked devices and
// revoked credentials are rejected.
func (s *Service) Authenticate(ctx context.Context, token string) (Device, Credential, error) {
	cred, dev, err := s.store.GetCredentialByTokenHash(ctx, hashToken(token))
	if err != nil {
		return Device{}, Credential{}, ErrCredentialInvalid
	}
	if !cred.RevokedAt.IsZero() {
		return Device{}, Credential{}, ErrCredentialInvalid
	}
	if !dev.RevokedAt.IsZero() {
		return Device{}, Credential{}, ErrDeviceRevoked
	}
	_ = s.store.TouchCredential(ctx, cred.ID, time.Now().UTC())
	return dev, cred, nil
}

// RevokeDevice permanently revokes a device and its credentials.
func (s *Service) RevokeDevice(ctx context.Context, deviceID string) error {
	if _, err := s.store.GetDevice(ctx, deviceID); err != nil {
		return err
	}
	return s.store.RevokeDevice(ctx, deviceID, time.Now().UTC())
}

// BindSpace binds a device to a space. The binding starts in
// pending_initial; a full-mode device may hold at most one binding.
func (s *Service) BindSpace(ctx context.Context, deviceID string, space canonical.SpaceID) (Binding, error) {
	dev, err := s.store.GetDevice(ctx, deviceID)
	if err != nil {
		return Binding{}, err
	}

	mode := SyncModePartial
	if n, err := s.store.CountBindings(ctx, deviceID); err != nil {
		return Binding{}, err
	} else if n > 0 {
		if dev.SyncMode == SyncModeFull {
			return Binding{}, ErrFullBindingLimit
		}
		if dev.SyncMode == "" {
			// First binding defines the mode implicitly as partial.
			mode = SyncModePartial
		} else {
			mode = dev.SyncMode
		}
	}

	if dev.SyncMode == "" {
		if err := s.store.SetDeviceSyncMode(ctx, deviceID, mode); err != nil {
			return Binding{}, err
		}
	}

	now := time.Now().UTC()
	b := Binding{
		DeviceID:  deviceID,
		SpaceID:   space,
		State:     StatePendingInitial,
		Epoch:     1, // corrected by the store from the space row
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := s.store.InsertBinding(ctx, b); err != nil {
		return Binding{}, err
	}
	return s.store.GetBinding(ctx, deviceID, space)
}

// GetBinding returns the binding of a device for a space.
func (s *Service) GetBinding(ctx context.Context, deviceID string, space canonical.SpaceID) (Binding, error) {
	return s.store.GetBinding(ctx, deviceID, space)
}
