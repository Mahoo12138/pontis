package auth

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// Store is the persistence contract required by the auth service.
type Store interface {
	// CountUsers returns the number of registered users.
	CountUsers(ctx context.Context) (int64, error)

	// CreateUser inserts a user. Username/email uniqueness violations must
	// return ErrUserExists / ErrEmailTaken.
	CreateUser(ctx context.Context, u User, passwordHash string) error

	// GetUserByUsernameNormalized loads a user by normalized username.
	GetUserByUsernameNormalized(ctx context.Context, usernameNorm string) (User, error)

	// GetUser loads a user by id.
	GetUser(ctx context.Context, id string) (User, error)

	// InsertSession stores a new session.
	InsertSession(ctx context.Context, s Session) error

	// GetSessionByTokenHash loads a session by token hash joined with the
	// user's status. Expired sessions return ErrSessionInvalid.
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (Session, User, error)

	// TouchSession updates last_seen_at.
	TouchSession(ctx context.Context, sessionID string, at time.Time) error

	// DeleteSession removes one session (logout).
	DeleteSession(ctx context.Context, sessionID string) error

	// DeleteUserSessions removes all sessions of a user (password change,
	// disable).
	DeleteUserSessions(ctx context.Context, userID string) error
}

// Service implements user bootstrap, login and session management.
type Service struct {
	store Store
	// SessionTTL is how long a web session lives.
	SessionTTL time.Duration
}

// NewService returns an auth service with the given store and session TTL.
func NewService(store Store, sessionTTL time.Duration) *Service {
	return &Service{store: store, SessionTTL: sessionTTL}
}

// NeedsSetup reports whether the instance has no users yet and must run
// first-setup bootstrap.
func (s *Service) NeedsSetup(ctx context.Context) (bool, error) {
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return false, err
	}
	return n == 0, nil
}

// CreateUserParams carries the input for user creation.
type CreateUserParams struct {
	Username    string
	Password    string
	DisplayName string
	Email       string
}

// CreateUser registers a user. The first user of an instance becomes the
// admin; later users are regular users.
func (s *Service) CreateUser(ctx context.Context, p CreateUserParams) (User, error) {
	if !ValidateUsername(p.Username) {
		return User{}, ErrInvalidUsername
	}
	if !ValidatePassword(p.Password) {
		return User{}, ErrInvalidPassword
	}

	role := RoleUser
	if n, err := s.store.CountUsers(ctx); err != nil {
		return User{}, err
	} else if n == 0 {
		role = RoleAdmin
	}

	hash, err := HashPassword(p.Password)
	if err != nil {
		return User{}, err
	}

	displayName := p.DisplayName
	if displayName == "" {
		displayName = p.Username
	}

	now := time.Now().UTC()
	u := User{
		Username:          p.Username,
		UsernameNorm:      NormalizeUsername(p.Username),
		DisplayName:       displayName,
		EmailNorm:         foldASCII(p.Email),
		Email:             p.Email,
		Role:              role,
		Status:            StatusActive,
		Locale:            "zh-CN",
		PasswordChangedAt: now,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := s.store.CreateUser(ctx, u, hash); err != nil {
		return User{}, err
	}
	return u, nil
}

// Login verifies credentials and creates a web session. It returns the
// raw token (handed to the client exactly once) and the session.
func (s *Service) Login(ctx context.Context, username, password, userAgent string) (token string, session Session, user User, err error) {
	u, err := s.store.GetUserByUsernameNormalized(ctx, NormalizeUsername(username))
	if err != nil {
		// Burn comparable time to avoid trivially timing user existence.
		_, _ = VerifyPassword(password, "$argon2id$v=19$m=65536,t=1,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
		return "", Session{}, User{}, ErrInvalidCredentials
	}

	ok, err := VerifyPassword(password, u.PasswordHash)
	if err != nil || !ok {
		return "", Session{}, User{}, ErrInvalidCredentials
	}
	if u.Status == StatusDisabled {
		return "", Session{}, User{}, ErrUserDisabled
	}

	token, tokenHash, err := newSessionToken()
	if err != nil {
		return "", Session{}, User{}, err
	}

	sessionID, err := uuid.NewV7()
	if err != nil {
		return "", Session{}, User{}, err
	}

	now := time.Now().UTC()
	session = Session{
		ID:        sessionID.String(),
		UserID:    u.ID,
		TokenHash: tokenHash,
		CreatedAt: now,
		LastSeen:  now,
		ExpiresAt: now.Add(s.SessionTTL),
		UserAgent: userAgent,
	}
	if err := s.store.InsertSession(ctx, session); err != nil {
		return "", Session{}, User{}, err
	}
	return token, session, u, nil
}

// VerifySession resolves a raw session token to its session and user.
// Expired sessions and disabled users are rejected.
func (s *Service) VerifySession(ctx context.Context, token string) (Session, User, error) {
	session, user, err := s.store.GetSessionByTokenHash(ctx, hashToken(token))
	if err != nil {
		return Session{}, User{}, ErrSessionInvalid
	}
	if user.Status == StatusDisabled {
		return Session{}, User{}, ErrUserDisabled
	}
	_ = s.store.TouchSession(ctx, session.ID, time.Now().UTC())
	return session, user, nil
}

// Logout revokes a single session by raw token.
func (s *Service) Logout(ctx context.Context, token string) error {
	session, _, err := s.store.GetSessionByTokenHash(ctx, hashToken(token))
	if err != nil {
		return ErrSessionInvalid
	}
	return s.store.DeleteSession(ctx, session.ID)
}
