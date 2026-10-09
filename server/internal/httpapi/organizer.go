package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/organizer"
)

// --- handlers: organizer (session auth, owner-scoped) ---

type runLinkCheckResponse struct {
	JobID string `json:"job_id"`
	Total int    `json:"total"`
}

func (s *Server) handleRunLinkCheck(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	// The request only enqueues: the run is executed by the job queue, and
	// its progress is read back from the persisted rows.
	jobID, total, err := s.Organizer.StartLinkCheck(r.Context(), s.Jobs, canonical.UserID(u.ID), spaceID)
	if err != nil {
		s.Logger.Error("link check enqueue failed", "err", err, "space", string(spaceID))
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusAccepted, runLinkCheckResponse{JobID: jobID, Total: total})
}

func (s *Server) handleLinkCheckResults(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	run, ok, err := s.Organizer.LinkResults(r.Context(), spaceID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"job_id": "", "total": 0, "done": 0, "results": []organizer.LinkResult{}})
		return
	}
	writeJSON(w, http.StatusOK, run)
}

func (s *Server) handleDuplicates(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	groups, err := s.Organizer.Duplicates(r.Context(), spaceID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	if groups == nil {
		groups = []organizer.DuplicateGroup{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}
