// Package auth implements users, Argon2id password hashing and
// server-side opaque web sessions.
package auth

import "errors"

// Errors. Domain-level only; the HTTP layer maps them to status codes.
var (
	// ErrInvalidUsername is returned for usernames failing validation.
	ErrInvalidUsername = errors.New("auth: invalid username")

	// ErrInvalidPassword is returned for passwords failing validation.
	ErrInvalidPassword = errors.New("auth: invalid password")

	// ErrUserExists is returned when username or email is already taken.
	ErrUserExists = errors.New("auth: user already exists")

	// ErrInvalidCredentials is returned on unknown user or wrong password.
	ErrInvalidCredentials = errors.New("auth: invalid credentials")

	// ErrUserDisabled is returned when the account is disabled.
	ErrUserDisabled = errors.New("auth: user disabled")

	// ErrSessionInvalid is returned for unknown, expired or revoked sessions.
	ErrSessionInvalid = errors.New("auth: session invalid")

	// ErrEmailTaken is returned when the email is already in use.
	ErrEmailTaken = errors.New("auth: email already in use")
)
