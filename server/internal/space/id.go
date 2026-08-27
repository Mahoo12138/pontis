package space

import "github.com/google/uuid"

// newSpaceID returns a UUIDv7 space identifier.
func newSpaceID() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return id.String(), nil
}
