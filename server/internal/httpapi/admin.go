package httpapi

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"pontis/internal/auth"
)

// --- handlers: admin user management (admin session) ---

func requireAdmin(s *Server, w http.ResponseWriter, r *http.Request) (auth.User, bool) {
	u, ok := currentUser(r)
	if !ok {
		s.writeError(w, r, http.StatusUnauthorized, "UNAUTHENTICATED", "session required")
		return auth.User{}, false
	}
	if u.Role != auth.RoleAdmin {
		s.writeError(w, r, http.StatusForbidden, "ADMIN_REQUIRED", "admin role required")
		return auth.User{}, false
	}
	return u, true
}

type adminUserDTO struct {
	ID          string  `json:"id"`
	Username    string  `json:"username"`
	DisplayName string  `json:"display_name"`
	Email       string  `json:"email"`
	Role        string  `json:"role"`
	Status      string  `json:"status"`
	SpaceCount  int64   `json:"space_count"`
	CreatedAt   string  `json:"created_at"`
	LastSeenAt  *string `json:"last_seen_at"`
}

func (s *Server) handleListAdminUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(s, w, r); !ok {
		return
	}
	rows, err := s.Accounts.ListUsersWithStats(r.Context())
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]adminUserDTO, 0, len(rows))
	for _, row := range rows {
		out = append(out, adminUserDTO{
			ID:          row.ID,
			Username:    row.Username,
			DisplayName: row.DisplayName,
			Email:       row.Email,
			Role:        row.Role,
			Status:      row.Status,
			SpaceCount:  row.SpaceCount,
			CreatedAt:   row.CreatedAt,
			LastSeenAt:  row.LastSeenAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

type updateAdminUserRequest struct {
	Status *string `json:"status"`
	Role   *string `json:"role"`
}

func (s *Server) handleUpdateAdminUser(w http.ResponseWriter, r *http.Request) {
	admin, ok := requireAdmin(s, w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "userID")
	var req updateAdminUserRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if userID == admin.ID {
		// Self-lockout protection: roles and own status are not editable
		// through the admin endpoint.
		s.writeError(w, r, http.StatusConflict, "SELF_MUTATION", "cannot change your own status or role here")
		return
	}
	now := time.Now().UTC()
	if req.Status != nil {
		switch *req.Status {
		case "active", "disabled":
		default:
			s.writeError(w, r, http.StatusBadRequest, "INVALID_VALUE", "status must be active or disabled")
			return
		}
		if err := s.Accounts.SetUserStatus(r.Context(), userID, *req.Status, now); err != nil {
			s.writeAdminError(w, r, err)
			return
		}
		if *req.Status == "disabled" {
			// Disabled accounts are rejected at every credential check;
			// dropping their sessions makes it immediate.
			_ = s.Accounts.DeleteUserSessions(r.Context(), userID)
		}
	}
	if req.Role != nil {
		switch *req.Role {
		case "admin", "user":
		default:
			s.writeError(w, r, http.StatusBadRequest, "INVALID_VALUE", "role must be admin or user")
			return
		}
		if err := s.Accounts.SetUserRole(r.Context(), userID, *req.Role, now); err != nil {
			s.writeAdminError(w, r, err)
			return
		}
	}
	updated, err := s.Auth.UserByID(r.Context(), userID)
	if err != nil {
		s.writeAdminError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, fromUser(updated))
}

func (s *Server) handleCreateResetLink(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(s, w, r); !ok {
		return
	}
	userID := chi.URLParam(r, "userID")
	raw, err := s.Auth.CreateResetLink(r.Context(), userID)
	if err != nil {
		s.writeAdminError(w, r, err)
		return
	}
	// The link points at the web UI's reset route; the raw token is the
	// single-use secret delivered out of band.
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"reset_link": scheme + "://" + r.Host + "/reset?token=" + raw,
	})
}

// handleResetPassword is the public counterpart: token + new password.
func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token       string `json:"token"`
		NewPassword string `json:"new_password"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := s.Auth.ResetPassword(r.Context(), req.Token, req.NewPassword); err != nil {
		switch {
		case errors.Is(err, auth.ErrResetTokenInvalid):
			s.writeError(w, r, http.StatusForbidden, "RESET_TOKEN_INVALID", "reset link is invalid, used or expired")
		case errors.Is(err, auth.ErrInvalidPassword):
			s.writeError(w, r, http.StatusBadRequest, "INVALID_PASSWORD", "password must be at least 8 characters")
		default:
			s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) writeAdminError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		s.writeError(w, r, http.StatusNotFound, "USER_NOT_FOUND", "unknown user")
	case errors.Is(err, auth.ErrResetTokenInvalid):
		s.writeError(w, r, http.StatusForbidden, "RESET_TOKEN_INVALID", "reset link is invalid, used or expired")
	default:
		s.Logger.Error("admin internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
