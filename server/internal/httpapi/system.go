package httpapi

// System status.
//
// /auth/setup, /auth/login and /auth/reset are public, and the login page has to
// know two things before anyone has a session: whether this instance has an
// admin yet, and whether it accepts new accounts. GET /settings cannot answer —
// it sits behind requireSession — so this handler is the narrow public
// projection of it.
//
// What stays private is the rest of system_settings. `session_ttl_hours` and
// `max_spaces_per_user` are operator policy; an anonymous reader has no use for
// them, and a self-hosted instance is often reachable from the internet.

import (
	"net/http"
)

type systemStatusResponse struct {
	// Initialized is false until the first admin exists. `users = 0` is the
	// whole test: there is no stored flag to flip (doc 09 §3).
	Initialized bool `json:"initialized"`
	// RegistrationMode is the stored policy value, so a client can distinguish
	// `closed` from `invite` even though neither offers a form today.
	RegistrationMode string `json:"registration_mode"`
	// AllowRegistration is what the login page acts on: the server's own gate,
	// so no client re-derives the rule and disagrees with it.
	AllowRegistration bool `json:"allow_registration"`
}

func (s *Server) handleSystemStatus(w http.ResponseWriter, r *http.Request) {
	settings, err := s.currentSettings(r.Context())
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	needs, err := s.Auth.NeedsSetup(r.Context())
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", err.Error())
		return
	}
	mode := settings["registration_mode"]
	writeJSON(w, http.StatusOK, systemStatusResponse{
		Initialized:       !needs,
		RegistrationMode:  mode,
		AllowRegistration: !needs && mode == registrationOpen,
	})
}
