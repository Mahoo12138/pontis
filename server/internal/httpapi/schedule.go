package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/auth"
	"pontis/internal/canonical"
	"pontis/internal/jobs"
	"pontis/internal/schedule"
)

// --- handlers: user task view + plan schedules (doc 13 §4.1) ---

type scheduleDTO struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"`
	TitleKey   string  `json:"title_key"`
	SpaceID    string  `json:"space_id,omitempty"`
	SpaceName  string  `json:"space_name,omitempty"`
	Enabled    bool    `json:"enabled"`
	Kind       string  `json:"kind"`
	TimeOfDay  string  `json:"time_of_day"`
	Weekday    int     `json:"weekday"`
	DayOfMonth int     `json:"day_of_month"`
	Timezone   string  `json:"timezone"`
	NextRunAt  string  `json:"next_run_at"`
	LastRunAt  *string `json:"last_run_at,omitempty"`
	CreatedAt  string  `json:"created_at"`
}

func (s *Server) scheduleDTOOf(r *http.Request, sched schedule.Schedule) scheduleDTO {
	var lastRun *string
	if sched.LastRunAt != nil {
		v := sched.LastRunAt.Format("2006-01-02T15:04:05Z")
		lastRun = &v
	}
	titleKey := ""
	if def, ok := jobs.DefinitionOf(sched.Type); ok {
		titleKey = def.TitleKey
	}
	return scheduleDTO{
		ID:         sched.ID,
		Type:       string(sched.Type),
		TitleKey:   titleKey,
		SpaceID:    sched.SpaceID,
		SpaceName:  s.spaceName(r, sched.SpaceID),
		Enabled:    sched.Enabled,
		Kind:       string(sched.Kind),
		TimeOfDay:  sched.TimeOfDay,
		Weekday:    sched.Weekday,
		DayOfMonth: sched.DayOfMonth,
		Timezone:   sched.Timezone,
		NextRunAt:  sched.NextRunAt.Format("2006-01-02T15:04:05Z"),
		LastRunAt:  lastRun,
		CreatedAt:  sched.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

type scheduleRequest struct {
	Type       string `json:"type"`
	Kind       string `json:"kind"`
	TimeOfDay  string `json:"time_of_day"`
	Weekday    *int   `json:"weekday,omitempty"`
	DayOfMonth *int   `json:"day_of_month,omitempty"`
	Timezone   string `json:"timezone"`
	SpaceID    string `json:"space_id,omitempty"`
	Enabled    *bool  `json:"enabled,omitempty"`
}

func scheduleParams(req scheduleRequest) schedule.CreateParams {
	return schedule.CreateParams{
		Type:       jobs.Type(req.Type),
		Kind:       schedule.Kind(req.Kind),
		TimeOfDay:  req.TimeOfDay,
		Weekday:    req.Weekday,
		DayOfMonth: req.DayOfMonth,
		Timezone:   req.Timezone,
		SpaceID:    req.SpaceID,
	}
}

// validateScheduleSpace enforces that a non-empty space reference points to
// one of the caller's own spaces (doc 22 D.1: private resource owner check).
func (s *Server) validateScheduleSpace(w http.ResponseWriter, r *http.Request, u auth.User, spaceID string) bool {
	if spaceID == "" {
		return true
	}
	sp, err := s.Library.Space(r.Context(), canonical.SpaceID(spaceID))
	if err != nil {
		s.writeScheduleError(w, r, canonical.ErrSpaceNotFound)
		return false
	}
	if sp.OwnerUserID != canonical.UserID(u.ID) {
		s.writeScheduleError(w, r, schedule.ErrNotOwner)
		return false
	}
	return true
}

func (s *Server) handleListSchedules(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	list, err := s.Schedules.ListByOwner(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]scheduleDTO, 0, len(list))
	for _, sched := range list {
		out = append(out, s.scheduleDTOOf(r, sched))
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedules": out})
}

func (s *Server) handleCreateSchedule(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	var req scheduleRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	params := scheduleParams(req)
	if err := schedule.ValidateCreate(params); err != nil {
		s.writeScheduleError(w, r, err)
		return
	}
	if !s.validateScheduleSpace(w, r, u, params.SpaceID) {
		return
	}
	sched, err := s.Schedules.Create(r.Context(), canonical.UserID(u.ID), params)
	if err != nil {
		s.writeScheduleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, s.scheduleDTOOf(r, sched))
}

func (s *Server) handleUpdateSchedule(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	id := chi.URLParam(r, "scheduleID")
	var req scheduleRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	params := scheduleParams(req)
	if params.Type != "" {
		if err := schedule.ValidateCreate(params); err != nil {
			s.writeScheduleError(w, r, err)
			return
		}
	}
	if !s.validateScheduleSpace(w, r, u, params.SpaceID) {
		return
	}
	sched, err := s.Schedules.Update(r.Context(), canonical.UserID(u.ID), id, params, req.Enabled)
	if err != nil {
		s.writeScheduleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, s.scheduleDTOOf(r, sched))
}

func (s *Server) handleDeleteSchedule(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	if err := s.Schedules.Delete(r.Context(), canonical.UserID(u.ID), chi.URLParam(r, "scheduleID")); err != nil {
		s.writeScheduleError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRunScheduleNow enqueues an immediate occurrence.
func (s *Server) handleRunScheduleNow(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	job, err := s.Schedules.RunNow(r.Context(), canonical.UserID(u.ID), chi.URLParam(r, "scheduleID"))
	if err != nil {
		s.writeScheduleError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"id": job.ID, "status": string(job.Status)})
}

// handleListMyTasks is the user task view: own schedules plus recent
// own jobs (doc 13 §4.1). System tasks never appear here.
func (s *Server) handleListMyTasks(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	schedules, err := s.Schedules.ListByOwner(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	schedOut := make([]scheduleDTO, 0, len(schedules))
	for _, sched := range schedules {
		schedOut = append(schedOut, s.scheduleDTOOf(r, sched))
	}
	jobList, err := s.Jobs.ListMine(r.Context(), canonical.UserID(u.ID), 20)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	jobsOut := make([]map[string]any, 0, len(jobList))
	for _, j := range jobList {
		entry := map[string]any{
			"id":           j.ID,
			"type":         string(j.Type),
			"status":       string(j.Status),
			"space_id":     j.SpaceID,
			"space_name":   s.spaceName(r, j.SpaceID),
			"phase":        j.Phase,
			"attempt":      j.Attempt,
			"max_attempts": j.MaxAttempts,
			"scheduled_at": j.ScheduledAt.Format("2006-01-02T15:04:05Z"),
		}
		if def, ok := jobs.DefinitionOf(j.Type); ok {
			entry["title_key"] = def.TitleKey
		}
		if j.ScheduleID != "" {
			entry["schedule_id"] = j.ScheduleID
		}
		if j.ProgressCur != nil || j.ProgressTot != nil {
			progress := map[string]any{}
			if j.ProgressCur != nil {
				progress["current"] = *j.ProgressCur
			}
			if j.ProgressTot != nil {
				progress["total"] = *j.ProgressTot
			}
			entry["progress"] = progress
		}
		if j.Error != "" {
			entry["error"] = j.Error
		}
		if j.StartedAt != nil {
			v := j.StartedAt.Format("2006-01-02T15:04:05Z")
			entry["started_at"] = v
		}
		if j.FinishedAt != nil {
			v := j.FinishedAt.Format("2006-01-02T15:04:05Z")
			entry["finished_at"] = v
		}
		jobsOut = append(jobsOut, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"schedules": schedOut, "jobs": jobsOut})
}

func (s *Server) writeScheduleError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, schedule.ErrNotFound), errors.Is(err, canonical.ErrSpaceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SCHEDULE_NOT_FOUND", "unknown schedule")
	case errors.Is(err, schedule.ErrNotOwner):
		s.writeError(w, r, http.StatusForbidden, "NOT_SCHEDULE_OWNER", "schedule belongs to another user")
	case errors.Is(err, schedule.ErrBadType):
		s.writeError(w, r, http.StatusBadRequest, "TASK_NOT_SCHEDULABLE", "task type is not schedulable")
	case errors.Is(err, schedule.ErrNoSpace):
		s.writeError(w, r, http.StatusBadRequest, "SPACE_REQUIRED", "task needs a target space")
	case errors.Is(err, schedule.ErrBadKind):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_KIND", "kind must be daily, weekly or monthly")
	case errors.Is(err, schedule.ErrBadWeekday):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_WEEKDAY", "weekday must be 0-6")
	case errors.Is(err, schedule.ErrBadDayOfMonth):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_DAY_OF_MONTH", "day_of_month must be 1-28")
	case errors.Is(err, schedule.ErrBadTime):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_TIME", "time_of_day must be HH:MM")
	case errors.Is(err, schedule.ErrBadTimezone):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_TIMEZONE", "unknown timezone")
	case errors.Is(err, schedule.ErrNoEnqueuer):
		s.writeError(w, r, http.StatusServiceUnavailable, "SCHEDULER_UNAVAILABLE", "scheduler is not running")
	default:
		s.Logger.Error("schedule internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
