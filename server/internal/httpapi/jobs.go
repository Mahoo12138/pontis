package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
)

// --- handlers: background jobs (admin session) ---

type jobDTO struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Status      string `json:"status"`
	Owner       string `json:"owner"`
	SpaceName   string `json:"space_name,omitempty"`
	Phase       string `json:"phase,omitempty"`
	Progress    *struct {
		Current int64 `json:"current"`
		Total   int64 `json:"total"`
	} `json:"progress,omitempty"`
	Attempt     int     `json:"attempt"`
	MaxAttempts int     `json:"max_attempts"`
	ScheduledAt string  `json:"scheduled_at"`
	StartedAt   *string `json:"started_at,omitempty"`
	FinishedAt  *string `json:"finished_at,omitempty"`
	Error       string  `json:"error,omitempty"`
}

func (s *Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(s, w, r); !ok {
		return
	}
	list, err := s.Jobs.List(r.Context(), 50)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]jobDTO, 0, len(list))
	for _, j := range list {
		dto := jobDTO{
			ID:          j.ID,
			Type:        string(j.Type),
			Status:      string(j.Status),
			Owner:       s.ownerName(r, j.OwnerUserID),
			SpaceName:   s.spaceName(r, j.SpaceID),
			Phase:       j.Phase,
			Attempt:     j.Attempt,
			MaxAttempts: j.MaxAttempts,
			ScheduledAt: j.ScheduledAt.Format("2006-01-02T15:04:05Z"),
			Error:       j.Error,
		}
		if j.ProgressCur != nil || j.ProgressTot != nil || j.Phase != "" {
			dto.Progress = &struct {
				Current int64 `json:"current"`
				Total   int64 `json:"total"`
			}{}
			if j.ProgressCur != nil {
				dto.Progress.Current = *j.ProgressCur
			}
			if j.ProgressTot != nil {
				dto.Progress.Total = *j.ProgressTot
			}
		}
		if j.StartedAt != nil {
			v := j.StartedAt.Format("2006-01-02T15:04:05Z")
			dto.StartedAt = &v
		}
		if j.FinishedAt != nil {
			v := j.FinishedAt.Format("2006-01-02T15:04:05Z")
			dto.FinishedAt = &v
		}
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, map[string]any{"jobs": out})
}

func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	if _, ok := requireAdmin(s, w, r); !ok {
		return
	}
	if err := s.Jobs.Cancel(r.Context(), chi.URLParam(r, "jobID")); err != nil {
		s.writeError(w, r, http.StatusNotFound, "JOB_NOT_FOUND", "unknown job")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) ownerName(r *http.Request, userID string) string {
	name, err := s.Accounts.UserName(r.Context(), userID)
	if err != nil || name == "" {
		return userID
	}
	return name
}

func (s *Server) spaceName(r *http.Request, spaceID string) string {
	if spaceID == "" {
		return ""
	}
	sp, err := s.Library.Space(r.Context(), canonical.SpaceID(spaceID))
	if err != nil {
		return ""
	}
	return sp.Name
}
