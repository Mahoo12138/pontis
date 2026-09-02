// Package httpapi exposes the REST API: decode, authenticate, call a
// service, map errors, encode. Domain logic stays in the services.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"pontis/internal/auth"
	"pontis/internal/backup"
	"pontis/internal/device"
	"pontis/internal/library"
	"pontis/internal/jobs"
	"pontis/internal/organizer"
	"pontis/internal/plaza"
	"pontis/internal/schedule"
	"pontis/internal/space"
	"pontis/internal/store/sqlite"
	"pontis/internal/transfer"
	"pontis/internal/sync"
	"pontis/internal/token"
)

// ProductVersion is the server product version reported by /meta.
const ProductVersion = "0.1.0"

// APIVersion is the HTTP API version.
const APIVersion = "v1"

// SessionCookie is the web session cookie name.
const SessionCookie = "pontis_session"

// Server wires the HTTP API onto the domain services.
type Server struct {
	Auth     *auth.Service
	Devices  *device.Service
	Spaces   *space.Service
	Sync     *sync.Service
	Library   *library.Service
	Tokens    *token.Service
	Backups   *backup.Service
	Organizer *organizer.Service
	Plaza     *plaza.Service
	Jobs      *jobs.Service
	Schedules *schedule.Service
	Transfer  *transfer.Service
	Accounts  *sqlite.AccountStore

	// InstanceID identifies this server installation across URL changes.
	InstanceID string

	Logger *slog.Logger
}

// context keys for request principals.
type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxSessionToken
	ctxSessionID
	ctxDevice
)

// currentUser returns the authenticated user, if any.
func currentUser(r *http.Request) (auth.User, bool) {
	u, ok := r.Context().Value(ctxUser).(auth.User)
	return u, ok
}

// currentDevice returns the authenticated device, if any.
func currentDevice(r *http.Request) (device.Device, bool) {
	d, ok := r.Context().Value(ctxDevice).(device.Device)
	return d, ok
}

// Router builds the chi router with all routes.
func (s *Server) Router() http.Handler {
	r := chi.NewRouter()

	r.Get("/api/v1/meta", s.handleMeta)

	// Auth (web session).
	r.Post("/api/v1/auth/setup", s.handleSetup)
	r.Post("/api/v1/auth/login", s.handleLogin)
	r.Post("/api/v1/auth/reset", s.handleResetPassword)
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Post("/api/v1/auth/logout", s.handleLogout)
		r.Get("/api/v1/auth/me", s.handleMe)
		r.Patch("/api/v1/auth/me", s.handleUpdateProfile)
		r.Post("/api/v1/auth/password", s.handleChangePassword)
	})

	// User task view + plan schedules (web session, owner-scoped).
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Get("/api/v1/tasks", s.handleListMyTasks)
		r.Post("/api/v1/jobs/{jobID}/cancel", s.handleCancelMyJob)
		r.Get("/api/v1/schedules", s.handleListSchedules)
		r.Post("/api/v1/schedules", s.handleCreateSchedule)
		r.Patch("/api/v1/schedules/{scheduleID}", s.handleUpdateSchedule)
		r.Delete("/api/v1/schedules/{scheduleID}", s.handleDeleteSchedule)
		r.Post("/api/v1/schedules/{scheduleID}/run-now", s.handleRunScheduleNow)
	})

	// Admin: user management (admin session).
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Get("/api/v1/admin/users", s.handleListAdminUsers)
		r.Patch("/api/v1/admin/users/{userID}", s.handleUpdateAdminUser)
		r.Post("/api/v1/admin/users/{userID}/reset-link", s.handleCreateResetLink)
	})

	// Account management (web session).
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Get("/api/v1/devices/overview", s.handleDeviceOverview)
		r.Delete("/api/v1/devices/{deviceID}", s.handleRevokeDevice)
		r.Get("/api/v1/settings", s.handleGetSettings)
		r.Patch("/api/v1/settings", s.handleUpdateSettings)
		r.Get("/api/v1/admin/jobs", s.handleListJobs)
		r.Post("/api/v1/admin/jobs", s.handleEnqueueJob)
		r.Post("/api/v1/admin/jobs/{jobID}/cancel", s.handleCancelJob)
		r.Post("/api/v1/admin/jobs/{jobID}/retry", s.handleRetryJob)
		r.Get("/api/v1/tokens", s.handleListTokens)
		r.Post("/api/v1/tokens", s.handleCreateToken)
		r.Delete("/api/v1/tokens/{tokenID}", s.handleRevokeToken)
	})

	// Spaces (web session).
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Get("/api/v1/spaces", s.handleListSpaces)
		r.Post("/api/v1/spaces", s.handleCreateSpace)
	})

	// Canonical tree access (web session, owner-scoped).
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession, s.requireSpaceAccess)
		r.Get("/api/v1/spaces/{spaceID}/nodes", s.handleListNodes)
		r.Get("/api/v1/spaces/{spaceID}/root-slots", s.handleListRootSlots)
		r.Post("/api/v1/spaces/{spaceID}/nodes", s.handleCreateNode)
		r.Patch("/api/v1/spaces/{spaceID}/nodes/{nodeID}", s.handleUpdateNode)
		r.Patch("/api/v1/spaces/{spaceID}/nodes/{nodeID}/move", s.handleMoveNode)
		r.Delete("/api/v1/spaces/{spaceID}/nodes/{nodeID}", s.handleDeleteNode)
		r.Get("/api/v1/spaces/{spaceID}/activity", s.handleSpaceActivity)
		r.Post("/api/v1/spaces/{spaceID}/organizer/link-check", s.handleRunLinkCheck)
		r.Get("/api/v1/spaces/{spaceID}/organizer/link-check/results", s.handleLinkCheckResults)
		r.Get("/api/v1/spaces/{spaceID}/organizer/duplicates", s.handleDuplicates)
		r.Post("/api/v1/spaces/{spaceID}/export", s.handleExport)
		r.Post("/api/v1/spaces/{spaceID}/import/preview", s.handleImportPreview)
		r.Post("/api/v1/spaces/{spaceID}/import/apply", s.handleImportApply)
		r.Get("/api/v1/spaces/{spaceID}/backups", s.handleListBackups)
		r.Post("/api/v1/spaces/{spaceID}/backups", s.handleCreateBackup)
		r.Post("/api/v1/spaces/{spaceID}/backups/{backupID}/restore", s.handleRestoreBackup)
		r.Patch("/api/v1/spaces/{spaceID}/backups/{backupID}", s.handleUpdateBackup)
		r.Delete("/api/v1/spaces/{spaceID}/backups/{backupID}", s.handleDeleteBackup)
	})

	// Plaza / publications (web session).
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Get("/api/v1/plaza/publications", s.handleListPlaza)
		r.Post("/api/v1/publications", s.handlePublish)
		r.Get("/api/v1/publications/{publicationID}", s.handleGetPublication)
		r.Patch("/api/v1/publications/{publicationID}", s.handleUpdatePublication)
		r.Delete("/api/v1/publications/{publicationID}", s.handleUnpublish)
		r.Post("/api/v1/publications/{publicationID}/apply", s.handleApplyPublication)
	})

	// Device registration (web session): returns the one-time device secret.
	r.Group(func(r chi.Router) {
		r.Use(s.requireSession)
		r.Post("/api/v1/devices", s.handleRegisterDevice)
	})

	// Device-scoped API (device credential).
	r.Group(func(r chi.Router) {
		r.Use(s.requireDevice)
		r.Get("/api/v1/device/spaces", s.handleDeviceSpaces)
		r.Get("/api/v1/device/bindings", s.handleListBindings)
		r.Post("/api/v1/device/bindings", s.handleCreateBinding)
		r.Post("/api/v1/sync/bindings/{bindingID}", s.handleSync)       
		r.Get("/api/v1/sync/bindings/{bindingID}/snapshot", s.handleSnapshot)
	})

	return r
}

// --- error envelope ---

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	RequestID string         `json:"request_id"`
	Details   map[string]any `json:"details,omitempty"`
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorEnvelope{Error: errorBody{
		Code:      code,
		Message:   message,
		RequestID: requestID(r),
	}})
}

func requestID(r *http.Request) string {
	if id := r.Header.Get("X-Request-Id"); id != "" {
		return id
	}
	return "req_unknown"
}

// --- shared helpers ---

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(errorEnvelope{Error: errorBody{
			Code:    "INVALID_JSON",
			Message: err.Error(),
		}})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// --- handlers: meta ---

func (s *Server) handleMeta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"instance_id":            s.InstanceID,
		"product_version":        ProductVersion,
		"api_version":            APIVersion,
		"sync_protocol_versions": []int{sync.ProtocolVersion},
	})
}

// --- handlers: auth ---

type setupRequest struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	needs, err := s.Auth.NeedsSetup(r.Context())
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	if !needs {
		s.writeError(w, r, http.StatusConflict, "ALREADY_INITIALIZED", "instance already has an admin")
		return
	}

	var req setupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	user, err := s.Auth.CreateUser(r.Context(), auth.CreateUserParams{
		Username:    req.Username,
		Password:    req.Password,
		DisplayName: req.DisplayName,
		Email:       req.Email,
	})
	if err != nil {
		s.mapAuthError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, fromUser(user))
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	// Session token also serves extension pairing (doc 08 §3); clients
	// without cookies use the body token as a Bearer credential.
	token, sess, user, err := s.Auth.Login(r.Context(), req.Username, req.Password, r.UserAgent())
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			s.writeError(w, r, http.StatusUnauthorized, "INVALID_CREDENTIALS", "unknown user or wrong password")
			return
		}
		if errors.Is(err, auth.ErrUserDisabled) {
			s.writeError(w, r, http.StatusUnauthorized, "ACCOUNT_DISABLED", "this account is disabled")
			return
		}
		s.mapAuthError(w, r, err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, loginResponse{
		Token:     token,
		ExpiresAt: sess.ExpiresAt,
		User:      fromUser(user),
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	token, _ := r.Context().Value(ctxSessionToken).(string)
	if err := s.Auth.Logout(r.Context(), token); err != nil {
		s.writeError(w, r, http.StatusUnauthorized, "SESSION_INVALID", "no active session")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: SessionCookie, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	u, ok := currentUser(r)
	if !ok {
		s.writeError(w, r, http.StatusUnauthorized, "SESSION_INVALID", "no active session")
		return
	}
	writeJSON(w, http.StatusOK, fromUser(u))
}

func (s *Server) mapAuthError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, auth.ErrInvalidUsername):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_USERNAME", "username must be 3-32 chars of [A-Za-z0-9._-]")
	case errors.Is(err, auth.ErrInvalidPassword):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_PASSWORD", "password must be at least 8 characters")
	case errors.Is(err, auth.ErrUserExists):
		s.writeError(w, r, http.StatusConflict, "USERNAME_TAKEN", "username already in use")
	case errors.Is(err, auth.ErrEmailTaken):
		s.writeError(w, r, http.StatusConflict, "EMAIL_TAKEN", "email already in use")
	default:
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}

// --- DTOs ---

type userResponse struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
	Role        string `json:"role"`
	Status      string `json:"status"`
	Locale      string `json:"locale"`
	CreatedAt   string `json:"created_at"`
}

func fromUser(u auth.User) userResponse {
	return userResponse{
		ID:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		Email:       u.Email,
		Role:        string(u.Role),
		Status:      string(u.Status),
		Locale:      u.Locale,
		CreatedAt:   u.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

type loginResponse struct {
	Token     string       `json:"token"`
	ExpiresAt time.Time    `json:"expires_at"`
	User      userResponse `json:"user"`
}

// --- middleware ---

// requireSession resolves a web session from the cookie or a Bearer token.
func (s *Server) requireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			if c, err := r.Cookie(SessionCookie); err == nil {
				token = c.Value
			}
		}
		if token == "" {
			s.writeError(w, r, http.StatusUnauthorized, "UNAUTHENTICATED", "session required")
			return
		}
		sess, user, err := s.Auth.VerifySession(r.Context(), token)
		if err != nil {
			s.writeError(w, r, http.StatusUnauthorized, "SESSION_INVALID", "invalid or expired session")
			return
		}
		ctx := context.WithValue(r.Context(), ctxUser, user)
		ctx = context.WithValue(ctx, ctxSessionToken, token)
		ctx = context.WithValue(ctx, ctxSessionID, sess.ID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requireDevice resolves a device credential from the Bearer token.
func (s *Server) requireDevice(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearerToken(r)
		if token == "" {
			s.writeError(w, r, http.StatusUnauthorized, "UNAUTHENTICATED", "device credential required")
			return
		}
		dev, _, err := s.Devices.Authenticate(r.Context(), token)
		if err != nil {
			s.writeError(w, r, http.StatusUnauthorized, "DEVICE_CREDENTIAL_INVALID", "invalid device credential")
			return
		}
		ctx := context.WithValue(r.Context(), ctxDevice, dev)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func bearerToken(r *http.Request) string {
	authz := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(authz) > len(prefix) && authz[:len(prefix)] == prefix {
		return authz[len(prefix):]
	}
	return ""
}
