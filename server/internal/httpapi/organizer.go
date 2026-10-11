package httpapi

import (
	"errors"
	"fmt"
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

// maxLinkDeletionBatch bounds one cleanup request. A run can hold thousands of
// bookmarks; a page that tried to delete them all at once would hold a request
// open through that many transactions.
const maxLinkDeletionBatch = 200

type deleteBrokenLinksRequest struct {
	JobID   string   `json:"job_id"`
	NodeIDs []string `json:"node_ids"`
}

type deleteBrokenLinksResponse struct {
	Deleted []string                 `json:"deleted"`
	Skipped []organizer.DeletionSkip `json:"skipped"`
}

// handleDeleteBrokenLinks deletes the findings of the CURRENT run, after
// re-reading each one: the plan's rule is that a classification is not a
// deletion order, and the node must still be the thing that was scanned.
func (s *Server) handleDeleteBrokenLinks(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	var req deleteBrokenLinksRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.JobID == "" || len(req.NodeIDs) == 0 {
		s.writeError(w, r, http.StatusBadRequest, "BATCH_REQUIRED", "job_id and node_ids must not be empty")
		return
	}
	if len(req.NodeIDs) > maxLinkDeletionBatch {
		s.writeError(w, r, http.StatusBadRequest, "BATCH_TOO_LARGE",
			fmt.Sprintf("at most %d nodes per request", maxLinkDeletionBatch))
		return
	}
	verified, skipped, err := s.Organizer.VerifyDeletion(r.Context(), spaceID, req.JobID, req.NodeIDs)
	switch {
	case errors.Is(err, organizer.ErrNoRun):
		s.writeError(w, r, http.StatusNotFound, "LINK_RUN_NOT_FOUND", "this space has no link check run")
		return
	case errors.Is(err, organizer.ErrStaleRun):
		s.writeError(w, r, http.StatusConflict, "LINK_RUN_STALE",
			"these findings are from a superseded run; reload the results")
		return
	case err != nil:
		s.Logger.Error("link deletion re-check failed", "err", err, "space", string(spaceID))
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	if skipped == nil {
		skipped = []organizer.DeletionSkip{}
	}
	deleted := make([]string, 0, len(verified))
	for _, id := range verified {
		err := s.Library.DeleteNode(r.Context(), spaceID, canonical.UserID(u.ID), canonical.NodeID(id))
		if err == nil {
			deleted = append(deleted, id)
			continue
		}
		// The tree had the last word. Say so instead of counting it as deleted:
		// the page must not report a bookmark it can still see as gone.
		reason := organizer.SkipDeleteFailed
		if errors.Is(err, canonical.ErrNodeNotFound) {
			reason = organizer.SkipNodeGone
		}
		s.Logger.Warn("link deletion refused by the tree", "err", err, "node", id)
		skipped = append(skipped, organizer.DeletionSkip{NodeID: id, Reason: reason})
	}
	writeJSON(w, http.StatusOK, deleteBrokenLinksResponse{Deleted: deleted, Skipped: skipped})
}
