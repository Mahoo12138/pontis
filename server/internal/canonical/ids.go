package canonical

// Typed IDs to prevent mixing identifiers at compile time.
// They stay lightweight string newtypes, not full DDD value objects.

// SpaceID identifies a Sync Space.
type SpaceID string

// String returns the raw identifier.
func (id SpaceID) String() string { return string(id) }

// NodeID identifies a Canonical Node (UUIDv7).
type NodeID string

// String returns the raw identifier.
func (id NodeID) String() string { return string(id) }

// UserID identifies an account.
type UserID string

// String returns the raw identifier.
func (id UserID) String() string { return string(id) }

// DeviceID identifies an extension installation.
type DeviceID string

// String returns the raw identifier.
func (id DeviceID) String() string { return string(id) }

// BindingID identifies a Device x Space sync state unit.
type BindingID string

// String returns the raw identifier.
func (id BindingID) String() string { return string(id) }
