package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/token"
)

// --- handlers: API tokens (session auth) ---

type apiTokenDTO struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	SpaceScope string   `json:"space_scope"`
	CreatedAt  string   `json:"created_at"`
	LastUsedAt *string  `json:"last_used_at"`
}

func tokenDTO(t token.Token) apiTokenDTO {
	var lastUsed *string
	if t.LastUsedAt != nil {
		v := t.LastUsedAt.Format("2006-01-02T15:04:05Z")
		lastUsed = &v
	}
	return apiTokenDTO{
		ID:         t.ID,
		Name:       t.Name,
		Scopes:     t.Scopes,
		SpaceScope: t.SpaceScope,
		CreatedAt:  t.CreatedAt.Format("2006-01-02T15:04:05Z"),
		LastUsedAt: lastUsed,
	}
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	list, err := s.Tokens.List(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]apiTokenDTO, 0, len(list))
	for _, t := range list {
		out = append(out, tokenDTO(t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": out})
}

type createTokenRequest struct {
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	SpaceScope string   `json:"space_scope"`
}

type createTokenResponse struct {
	Token  apiTokenDTO `json:"token"`
	Secret string      `json:"secret"`
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	var req createTokenRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	t, secret, err := s.Tokens.Create(r.Context(), canonical.UserID(u.ID), token.CreateParams{
		Name:       req.Name,
		Scopes:     req.Scopes,
		SpaceScope: req.SpaceScope,
	})
	if err != nil {
		s.writeTokenError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, createTokenResponse{Token: tokenDTO(t), Secret: secret})
}

func (s *Server) handleRevokeToken(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	if err := s.Tokens.Revoke(r.Context(), canonical.UserID(u.ID), chi.URLParam(r, "tokenID")); err != nil {
		s.writeTokenError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeTokenError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, token.ErrNameRequired):
		s.writeError(w, r, http.StatusBadRequest, "NAME_REQUIRED", "name must not be empty")
	case errors.Is(err, token.ErrInvalidScopes):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_SCOPES", "unknown or missing scope")
	case errors.Is(err, token.ErrTokenNotFound):
		s.writeError(w, r, http.StatusNotFound, "TOKEN_NOT_FOUND", "unknown token")
	default:
		s.Logger.Error("token internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
