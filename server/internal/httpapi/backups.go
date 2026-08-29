package httpapi

import (
	"errors"
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"pontis/internal/backup"
	"pontis/internal/canonical"
)

// --- handlers: space backups (session auth, owner-scoped) ---

type backupDTO struct {
	ID            string `json:"id"`
	SpaceID       string `json:"space_id"`
	Kind          string `json:"kind"`
	Filename      string `json:"filename"`
	SizeBytes     int64  `json:"size_bytes"`
	NodeCount     int64  `json:"node_count"`
	BookmarkCount int64  `json:"bookmark_count"`
	Protected     bool   `json:"protected"`
	CreatedAt     string `json:"created_at"`
}

func backupDTOOf(b backup.Backup) backupDTO {
	return backupDTO{
		ID:            b.ID,
		SpaceID:       b.SpaceID,
		Kind:          string(b.Kind),
		Filename:      b.Filename,
		SizeBytes:     b.SizeBytes,
		NodeCount:     b.NodeCount,
		BookmarkCount: b.BookmarkCount,
		Protected:     b.Protected,
		CreatedAt:     b.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	list, err := s.Backups.List(r.Context(), spaceID)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	out := make([]backupDTO, 0, len(list))
	for _, b := range list {
		out = append(out, backupDTOOf(b))
	}
	writeJSON(w, http.StatusOK, map[string]any{"backups": out})
}

func (s *Server) handleCreateBackup(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	b, err := s.Backups.Create(r.Context(), spaceID, backup.KindManual)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, backupDTOOf(b))
}

type restoreBackupResponse struct {
	SafetyBackupID string `json:"safety_backup_id"`
	NewEpoch       int64  `json:"new_epoch"`
}

func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	backupID := chi.URLParam(r, "backupID")
	epoch, safetyID, err := s.Backups.Restore(r.Context(), spaceID, backupID)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, restoreBackupResponse{SafetyBackupID: safetyID, NewEpoch: epoch})
}

type updateBackupRequest struct {
	Protected *bool `json:"protected"`
}

func (s *Server) handleUpdateBackup(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	backupID := chi.URLParam(r, "backupID")
	var req updateBackupRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Protected != nil {
		if err := s.Backups.SetProtected(r.Context(), backupID, *req.Protected); err != nil {
			s.writeBackupError(w, r, err)
			return
		}
	}
	b, err := s.Backups.Get(r.Context(), backupID)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	if b.SpaceID != string(spaceID) {
		s.writeError(w, r, http.StatusNotFound, "BACKUP_NOT_FOUND", "unknown backup")
		return
	}
	writeJSON(w, http.StatusOK, backupDTOOf(b))
}

func (s *Server) handleDeleteBackup(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	backupID := chi.URLParam(r, "backupID")
	b, err := s.Backups.Get(r.Context(), backupID)
	if err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	if b.SpaceID != string(spaceID) {
		s.writeError(w, r, http.StatusNotFound, "BACKUP_NOT_FOUND", "unknown backup")
		return
	}
	if err := s.Backups.Delete(r.Context(), backupID); err != nil {
		s.writeBackupError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) writeBackupError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, backup.ErrNotFound):
		s.writeError(w, r, http.StatusNotFound, "BACKUP_NOT_FOUND", "unknown backup")
	case errors.Is(err, backup.ErrSpaceMismatch):
		s.writeError(w, r, http.StatusForbidden, "BACKUP_SPACE_MISMATCH", "backup belongs to another space")
	case errors.Is(err, backup.ErrInvalidPayload):
		s.writeError(w, r, http.StatusBadRequest, "BACKUP_INVALID", "backup payload is invalid")
	case errors.Is(err, canonical.ErrSpaceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
	case errors.Is(err, os.ErrNotExist):
		s.writeError(w, r, http.StatusNotFound, "BACKUP_FILE_MISSING", "backup file is missing")
	default:
		s.Logger.Error("backup internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
