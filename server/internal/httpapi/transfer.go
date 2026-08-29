package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/transfer"
)

// --- handlers: import / export (session auth, owner-scoped) ---

type exportRequest struct {
	Format  string `json:"format"`
	RootKey string `json:"root_key"`
}

func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	var req exportRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	filename, contentType, content, err := s.Transfer.Export(r.Context(), spaceID, transfer.Format(req.Format), req.RootKey)
	if err != nil {
		s.writeTransferError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"filename":      filename,
		"content_type":  contentType,
		"content":       content,
	})
}

type previewImportRequest struct {
	Format  string `json:"format"`
	Content string `json:"content"`
}

func (s *Server) handleImportPreview(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	var req previewImportRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	plan, err := s.Transfer.Preview(r.Context(), spaceID, transfer.Format(req.Format), req.Content)
	if err != nil {
		s.writeTransferError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

type applyImportRequest struct {
	PlanID   string    `json:"plan_id"`
	Parent   parentDTO `json:"parent"`
	Strategy string    `json:"strategy"`
}

func (s *Server) handleImportApply(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	var req applyImportRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	res, err := s.Transfer.Apply(r.Context(), canonical.UserID(u.ID), spaceID, req.PlanID, req.Parent.toDomain(), req.Strategy)
	if err != nil {
		s.writeTransferError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) writeTransferError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, transfer.ErrInvalidFormat):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_FORMAT", "format must be netscape_html or native_json")
	case errors.Is(err, transfer.ErrContentTooLarge):
		s.writeError(w, r, http.StatusBadRequest, "CONTENT_TOO_LARGE", "import file exceeds the size limit")
	case errors.Is(err, transfer.ErrTooManyNodes):
		s.writeError(w, r, http.StatusBadRequest, "TOO_MANY_NODES", "import file exceeds the node limit")
	case errors.Is(err, transfer.ErrTooDeep):
		s.writeError(w, r, http.StatusBadRequest, "TOO_DEEP", "import tree exceeds the depth limit")
	case errors.Is(err, transfer.ErrInvalidPayload):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_IMPORT", "content is not a valid import file")
	case errors.Is(err, transfer.ErrPlanNotFound):
		s.writeError(w, r, http.StatusNotFound, "PLAN_NOT_FOUND", "plan not found or expired, re-run the preview")
	case errors.Is(err, transfer.ErrPlanStale):
		s.writeError(w, r, http.StatusConflict, "PLAN_STALE", "the space changed since the preview, re-run it")
	case errors.Is(err, transfer.ErrInvalidStrategy):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_STRATEGY", "strategy must be merge or replace")
	case errors.Is(err, canonical.ErrSpaceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
	default:
		s.Logger.Error("transfer internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
