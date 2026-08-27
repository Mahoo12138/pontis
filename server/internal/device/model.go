// Package device implements device registration, one-time device
// credentials and device-space bindings. Sync protocol logic lives in the
// sync package; this module only manages lifecycle.
package device

import (
	"errors"
	"time"

	"pontis/internal/canonical"
)

// Errors.
var (
	// ErrDeviceNotFound is returned for unknown device ids.
	ErrDeviceNotFound = errors.New("device: device not found")

	// ErrDeviceRevoked is returned when using a revoked device credential.
	ErrDeviceRevoked = errors.New("device: device revoked")

	// ErrCredentialInvalid is returned for unknown or revoked credentials.
	ErrCredentialInvalid = errors.New("device: credential invalid")

	// ErrSpaceNotFound is returned when the binding target space is missing.
	ErrSpaceNotFound = errors.New("device: sync space not found")

	// ErrNotSpaceOwner is returned when the space belongs to another user.
	ErrNotSpaceOwner = errors.New("device: sync space not owned by user")

	// ErrBindingExists is returned when the device is already bound to the
	// space.
	ErrBindingExists = errors.New("device: binding already exists")

	// ErrBindingNotFound is returned for unknown bindings.
	ErrBindingNotFound = errors.New("device: binding not found")

	// ErrFullBindingLimit is returned when a full-mode device would get a
	// second binding.
	ErrFullBindingLimit = errors.New("device: full mode allows only one binding")

	// ErrSyncModeConflict is returned when the requested sync mode changes
	// an existing device's mode while bindings exist.
	ErrSyncModeConflict = errors.New("device: sync mode change requires unbinding first")
)

// SyncMode is the device-level sync mode. Full and partial are mutually
// exclusive per device.
type SyncMode string

const (
	SyncModeFull    SyncMode = "full"
	SyncModePartial SyncMode = "partial"
)

// BindingState is the lifecycle state of a device-space binding.
type BindingState string

const (
	// StatePendingInitial means the binding was created but initial sync
	// verification has not completed yet.
	StatePendingInitial BindingState = "pending_initial"
	// StateActive means incremental sync is allowed.
	StateActive BindingState = "active"
	// StateSuspended means sync is paused (e.g. mount missing).
	StateSuspended BindingState = "suspended"
)

// Device is one extension installation in one browser profile.
type Device struct {
	ID          string
	OwnerUserID canonical.UserID
	Name        string
	ClientType  string // extension | other
	Browser     string // edge | chrome | firefox | ...
	Platform    string
	SyncMode    SyncMode // empty until first binding
	CreatedAt   time.Time
	LastSeenAt  time.Time
	RevokedAt   time.Time
}

// Credential is a device credential. The raw secret is handed to the
// extension exactly once at registration; only hash and prefix persist.
type Credential struct {
	ID          string
	DeviceID    string
	TokenPrefix string
	TokenHash   string
	CreatedAt   time.Time
	LastUsedAt  time.Time
	RevokedAt   time.Time
}

// Binding is the Device x Space sync state unit.
type Binding struct {
	ID               string
	DeviceID         string
	SpaceID          canonical.SpaceID
	State            BindingState
	Epoch            int64
	AppliedRevision  int64
	ReceivedRevision int64
	MaxClientSeq     int64
	InitializedAt    time.Time
	LastSyncAt       time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}
