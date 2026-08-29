package httpapi

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"pontis/internal/auth"
	"pontis/internal/canonical"
	"pontis/internal/store/sqlite"
)

// --- handlers: device overview (session auth) ---

type bindingOverviewDTO struct {
	ID              string `json:"id"`
	SpaceID         string `json:"space_id"`
	SpaceName       string `json:"space_name"`
	SyncMode        string `json:"sync_mode"`
	State           string `json:"state"`
	Health          string `json:"health"`
	Epoch           int64  `json:"epoch"`
	AppliedRevision int64  `json:"applied_revision"`
	ServerRevision  int64  `json:"server_revision"`
	LastSyncAt      *string `json:"last_sync_at"`
}

type deviceOverviewDTO struct {
	ID          string               `json:"id"`
	Name        string               `json:"name"`
	ClientType  string               `json:"client_type"`
	Browser     string               `json:"browser"`
	Platform    string               `json:"platform"`
	SyncMode    string               `json:"sync_mode"`
	CreatedAt   string               `json:"created_at"`
	LastSeenAt  *string              `json:"last_seen_at"`
	Bindings    []bindingOverviewDTO `json:"bindings"`
}

func (s *Server) handleDeviceOverview(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	rows, err := s.Accounts.ListOwnerDeviceBindings(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}

	byDevice := map[string]*deviceOverviewDTO{}
	order := []string{}
	for _, row := range rows {
		dev, ok := byDevice[row.DeviceID]
		if !ok {
			dev = &deviceOverviewDTO{
				ID:         row.DeviceID,
				Name:       row.DeviceName,
				ClientType: row.ClientType,
				Browser:    row.Browser,
				Platform:   row.Platform,
				SyncMode:   row.SyncMode,
				CreatedAt:  row.CreatedAt,
				LastSeenAt: row.LastSeenAt,
				Bindings:   []bindingOverviewDTO{},
			}
			byDevice[row.DeviceID] = dev
			order = append(order, row.DeviceID)
		}
		if row.BindingID == "" {
			continue // device without bindings
		}
		dev.Bindings = append(dev.Bindings, bindingOverviewDTO{
			ID:              row.BindingID,
			SpaceID:         row.SpaceID,
			SpaceName:       row.SpaceName,
			SyncMode:        row.SyncMode,
			State:           row.BindingState,
			Health:          deriveBindingHealth(row),
			Epoch:           row.Epoch,
			AppliedRevision: row.AppliedRevision,
			ServerRevision:  row.ServerRevision,
			LastSyncAt:      row.LastSyncAt,
		})
	}

	out := make([]deviceOverviewDTO, 0, len(order))
	for _, id := range order {
		out = append(out, *byDevice[id])
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

// deriveBindingHealth mirrors the web UI's semantics: normal states stay
// quiet, problems are elevated.
func deriveBindingHealth(row sqlite.DeviceBindingRow) string {
	switch row.BindingState {
	case "suspended":
		return "suspended"
	case "pending_initial":
		return "warning"
	}
	if row.Epoch != row.SpaceEpoch {
		return "recovery"
	}
	if row.AppliedRevision < row.ServerRevision {
		return "syncing"
	}
	return "healthy"
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	deviceID := chi.URLParam(r, "deviceID")

	// Ownership check via the overview join: an unknown or foreign device
	// is indistinguishable (404).
	rows, err := s.Accounts.ListOwnerDeviceBindings(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	owned := false
	for _, row := range rows {
		if row.DeviceID == deviceID {
			owned = true
			break
		}
	}
	if !owned {
		s.writeError(w, r, http.StatusNotFound, "DEVICE_NOT_FOUND", "unknown device")
		return
	}

	if err := s.Devices.RevokeDevice(r.Context(), deviceID); err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	// Remove bindings and credentials so the device disappears cleanly;
	// history rows keep their origin ids for the journal.
	if err := s.Accounts.DeleteDeviceChildren(r.Context(), deviceID); err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	if err := s.Accounts.DeleteOwnerDevice(r.Context(), canonical.UserID(u.ID), deviceID); err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- handlers: profile & password ---

type updateProfileRequest struct {
	DisplayName *string `json:"display_name"`
	Email       *string `json:"email"`
}

func (s *Server) handleUpdateProfile(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	var req updateProfileRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	displayName, email := u.DisplayName, u.Email
	if req.DisplayName != nil {
		if *req.DisplayName == "" {
			s.writeError(w, r, http.StatusBadRequest, "INVALID_NAME", "display name must not be empty")
			return
		}
		displayName = *req.DisplayName
	}
	if req.Email != nil {
		email = *req.Email
	}
	if err := s.Accounts.UpdateProfile(r.Context(), u.ID, displayName, email, time.Now().UTC()); err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	updated, err := s.Auth.UserByID(r.Context(), u.ID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, fromUser(updated))
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	sessionID, _ := r.Context().Value(ctxSessionID).(string)
	var req changePasswordRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if !auth.ValidatePassword(req.NewPassword) {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_PASSWORD", "password must be at least 8 characters")
		return
	}
	hash, err := s.Accounts.GetPasswordHash(r.Context(), u.ID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	ok, err := auth.VerifyPassword(req.CurrentPassword, hash)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	if !ok {
		s.writeError(w, r, http.StatusForbidden, "INVALID_CREDENTIALS", "current password is wrong")
		return
	}
	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	now := time.Now().UTC()
	if err := s.Accounts.UpdatePassword(r.Context(), u.ID, newHash, now); err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	// Other web sessions die immediately; devices and API tokens are
	// independent credentials (doc 09 §5).
	if err := s.Accounts.DeleteUserSessionsExcept(r.Context(), u.ID, sessionID); err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// --- handlers: system settings (admin) ---

var settingDefaults = map[string]string{
	"registration_mode":   "closed",
	"default_locale":      "zh-CN",
	"session_ttl_hours":   "24",
	"max_spaces_per_user": "16",
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Accounts.ListSettings(r.Context())
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	values := map[string]string{}
	for k, v := range settingDefaults {
		values[k] = v
	}
	for _, row := range rows {
		if _, known := settingDefaults[row.Key]; known {
			values[row.Key] = row.Value
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": values})
}

type updateSettingsRequest struct {
	RegistrationMode *string `json:"registration_mode"`
	DefaultLocale    *string `json:"default_locale"`
	SessionTTLHours  *int    `json:"session_ttl_hours"`
	MaxSpacesPerUser *int    `json:"max_spaces_per_user"`
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	if u.Role != auth.RoleAdmin {
		s.writeError(w, r, http.StatusForbidden, "ADMIN_REQUIRED", "admin role required")
		return
	}
	var req updateSettingsRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	kv := map[string]string{}
	if req.RegistrationMode != nil {
		switch *req.RegistrationMode {
		case "closed", "open", "invite":
			kv["registration_mode"] = *req.RegistrationMode
		default:
			s.writeError(w, r, http.StatusBadRequest, "INVALID_VALUE", "unknown registration mode")
			return
		}
	}
	if req.DefaultLocale != nil {
		kv["default_locale"] = *req.DefaultLocale
	}
	if req.SessionTTLHours != nil {
		kv["session_ttl_hours"] = itoa(*req.SessionTTLHours)
	}
	if req.MaxSpacesPerUser != nil {
		kv["max_spaces_per_user"] = itoa(*req.MaxSpacesPerUser)
	}
	if err := s.Accounts.UpsertSettings(r.Context(), kv, time.Now().UTC()); err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	s.handleGetSettings(w, r)
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
