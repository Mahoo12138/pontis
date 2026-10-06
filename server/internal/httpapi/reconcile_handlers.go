package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"pontis/internal/device"
	"pontis/internal/reconcile"
)

// --- handlers: reconciliation + snapshots (device auth, doc 08 §9-11) ---

// loadOwnedBinding resolves the binding URL param and enforces that it
// belongs to the authenticated device. Resource ids are never
// authorization capabilities (doc 22 D.6).
func (s *Server) loadOwnedBinding(w http.ResponseWriter, r *http.Request) *device.Binding {
	dev, _ := currentDevice(r)
	binding, err := s.Devices.GetBindingByID(r.Context(), chi.URLParam(r, "bindingID"))
	if err != nil {
		s.writeError(w, r, http.StatusNotFound, "BINDING_NOT_FOUND", "unknown binding")
		return nil
	}
	if binding.DeviceID != dev.ID {
		s.writeError(w, r, http.StatusForbidden, "NOT_BINDING_OWNER", "binding belongs to another device")
		return nil
	}
	return &binding
}

// writeReconcileError maps service failures onto the unified envelope.
func (s *Server) writeReconcileError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	code := "INTERNAL"
	switch {
	case errors.Is(err, reconcile.ErrSessionNotFound):
		status, code = http.StatusNotFound, "RECONCILIATION_NOT_FOUND"
	case errors.Is(err, reconcile.ErrActiveSessionExists):
		status, code = http.StatusConflict, "ACTIVE_RECONCILIATION_EXISTS"
	case errors.Is(err, reconcile.ErrBindingNotEligible):
		status, code = http.StatusConflict, "BINDING_NOT_ELIGIBLE"
	case errors.Is(err, reconcile.ErrInvalidSessionState):
		status, code = http.StatusConflict, "INVALID_SESSION_STATE"
	case errors.Is(err, reconcile.ErrSnapshotMissing):
		status, code = http.StatusConflict, "SNAPSHOT_MISSING"
	case errors.Is(err, reconcile.ErrPlanStale):
		status, code = http.StatusConflict, "PLAN_STALE"
	case errors.Is(err, reconcile.ErrNotCommitted):
		status, code = http.StatusConflict, "NOT_COMMITTED"
	case errors.Is(err, reconcile.ErrDecisionInvalid):
		status, code = http.StatusBadRequest, "INVALID_DECISION"
	case errors.Is(err, reconcile.ErrUnmappedRoot),
		errors.Is(err, reconcile.ErrUnknownRoot),
		errors.Is(err, reconcile.ErrDuplicateRootKey):
		status, code = http.StatusBadRequest, "INVALID_SNAPSHOT"
	}
	if code == "INTERNAL" {
		s.Logger.Error("reconcile internal error", "err", err)
		err = errors.New("internal error")
	}
	s.writeError(w, r, status, code, err.Error())
}

// --- client snapshot (doc 08 §10) ---

func (s *Server) handleSubmitClientSnapshot(w http.ResponseWriter, r *http.Request) {
	binding := s.loadOwnedBinding(w, r)
	if binding == nil {
		return
	}
	var req reconcile.ClientSnapshotJSON
	if !decodeJSON(w, r, &req) {
		return
	}
	sess, err := s.Reconcile.SubmitClientSnapshot(r.Context(), binding.ID, req)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, reconcileSessionResponse(sess, nil))
}

// --- server snapshot (doc 08 §9) ---

type serverSnapshotResponse struct {
	SnapshotID string `json:"snapshot_id"`
	Epoch      int64  `json:"epoch"`
	Revision   int64  `json:"revision"`
	NodeCount  int    `json:"node_count"`
	Checksum   string `json:"checksum"`
	ExpiresAt  string `json:"expires_at,omitempty"`
}

func fromSnapshot(snap reconcile.ServerSnapshot) serverSnapshotResponse {
	return serverSnapshotResponse{
		SnapshotID: snap.ID,
		Epoch:      snap.Epoch,
		Revision:   snap.Revision,
		NodeCount:  snap.NodeCount,
		Checksum:   snap.Checksum,
		ExpiresAt:  formatTimestamp(snap.ExpiresAt),
	}
}

func (s *Server) handleCreateServerSnapshot(w http.ResponseWriter, r *http.Request) {
	binding := s.loadOwnedBinding(w, r)
	if binding == nil {
		return
	}
	snap, err := s.Reconcile.CreateServerSnapshot(r.Context(), binding.ID)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, fromSnapshot(snap))
}

func (s *Server) handleGetServerSnapshot(w http.ResponseWriter, r *http.Request) {
	snap, err := s.Reconcile.GetServerSnapshot(r.Context(), chi.URLParam(r, "snapshotID"))
	if err != nil {
		s.writeError(w, r, http.StatusNotFound, "SNAPSHOT_NOT_FOUND", "unknown snapshot")
		return
	}
	writeJSON(w, http.StatusOK, fromSnapshot(snap))
}

type snapshotNodeDTO struct {
	NodeRef   string `json:"node_ref"`
	ParentRef string `json:"parent_ref"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	URL       string `json:"url,omitempty"`
	RootKey   string `json:"root_key,omitempty"`
	Position  int64  `json:"position"`
}

func (s *Server) handleListServerSnapshotNodes(w http.ResponseWriter, r *http.Request) {
	snapshotID := chi.URLParam(r, "snapshotID")
	if _, err := s.Reconcile.GetServerSnapshot(r.Context(), snapshotID); err != nil {
		s.writeError(w, r, http.StatusNotFound, "SNAPSHOT_NOT_FOUND", "unknown snapshot")
		return
	}
	limit := 500
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
			limit = n
		}
	}
	offset := 0
	if v := r.URL.Query().Get("cursor"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			offset = n
		}
	}
	nodes, err := s.Reconcile.ListSnapshotNodes(r.Context(), snapshotID, offset, limit+1)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	hasMore := len(nodes) > limit
	if hasMore {
		nodes = nodes[:limit]
	}
	out := make([]snapshotNodeDTO, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, snapshotNodeDTO{
			NodeRef:   n.NodeRef,
			ParentRef: n.ParentRef,
			Type:      n.Type,
			Title:     n.Title,
			URL:       n.URL,
			RootKey:   n.RootKey,
			Position:  n.Position,
		})
	}
	resp := map[string]any{"nodes": out, "has_more": hasMore}
	if hasMore {
		resp["next_cursor"] = strconv.Itoa(offset + limit)
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- reconciliation sessions (doc 08 §11) ---

type issueResponse struct {
	ID             string                     `json:"id"`
	Type           string                     `json:"type"`
	Payload        reconcile.IssuePayloadJSON `json:"payload"`
	DefaultChoice  string                     `json:"default_choice"`
	SelectedChoice *string                    `json:"selected_choice"`
}

type sessionResponse struct {
	ID              string          `json:"id"`
	BindingID       string          `json:"binding_id"`
	SpaceID         string          `json:"space_id"`
	Type            string          `json:"type"`
	Reason          string          `json:"reason"`
	State           string          `json:"state"`
	Phase           string          `json:"phase"`
	SourceEpoch     int64           `json:"source_epoch"`
	SourceRevision  int64           `json:"source_revision"`
	TargetEpoch     int64           `json:"target_epoch"`
	TargetRevision  int64           `json:"target_revision"`
	PlanHash        string          `json:"plan_hash,omitempty"`
	ServerCommitted bool            `json:"server_committed"`
	CommitRevision  int64           `json:"commit_revision"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
	CompletedAt     string          `json:"completed_at,omitempty"`
	Issues          []issueResponse `json:"issues,omitempty"`
}

func formatTimestamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

func reconcileSessionResponse(sess reconcile.Session, issues []reconcile.Issue) sessionResponse {
	out := sessionResponse{
		ID:              sess.ID,
		BindingID:       sess.BindingID,
		SpaceID:         string(sess.SpaceID),
		Type:            string(sess.Type),
		Reason:          sess.Reason,
		State:           string(sess.State),
		Phase:           sess.Phase,
		SourceEpoch:     sess.SourceEpoch,
		SourceRevision:  sess.SourceRevision,
		TargetEpoch:     sess.TargetEpoch,
		TargetRevision:  sess.TargetRevision,
		PlanHash:        sess.PlanHash,
		ServerCommitted: sess.ServerCommitted,
		CommitRevision:  sess.CommitRevision,
		CreatedAt:       formatTimestamp(sess.CreatedAt),
		UpdatedAt:       formatTimestamp(sess.UpdatedAt),
		CompletedAt:     formatTimestamp(sess.CompletedAt),
	}
	for _, issue := range issues {
		out.Issues = append(out.Issues, issueResponse{
			ID:             issue.ID,
			Type:           issue.Type,
			Payload:        issue.Payload,
			DefaultChoice:  issue.DefaultChoice,
			SelectedChoice: issue.SelectedChoice,
		})
	}
	return out
}

func (s *Server) handleCreateReconciliation(w http.ResponseWriter, r *http.Request) {
	binding := s.loadOwnedBinding(w, r)
	if binding == nil {
		return
	}
	var req struct {
		Type   string `json:"type"`
		Reason string `json:"reason"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	sess, err := s.Reconcile.CreateSession(r.Context(), binding.ID, reconcile.SessionType(req.Type), req.Reason)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, reconcileSessionResponse(sess, nil))
}

func (s *Server) handleGetReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, issues, err := s.Reconcile.GetSessionWithIssues(r.Context(), chi.URLParam(r, "reconciliationID"))
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, reconcileSessionResponse(sess, issues))
}

func (s *Server) handlePlanReconciliation(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "reconciliationID")
	sess, issues, err := s.Reconcile.Plan(r.Context(), id)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, reconcileSessionResponse(sess, issues))
}

func (s *Server) handleDecideReconciliation(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "reconciliationID")
	var req struct {
		Decisions map[string]string `json:"decisions"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	sess, issues, err := s.Reconcile.Decide(r.Context(), id, req.Decisions)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, reconcileSessionResponse(sess, issues))
}

func (s *Server) handleCommitReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, err := s.Reconcile.Commit(r.Context(), chi.URLParam(r, "reconciliationID"))
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"committed":       true,
		"commit_revision": sess.CommitRevision,
		"plan_hash":       sess.PlanHash,
	})
}

func (s *Server) handleReconciliationSteps(w http.ResponseWriter, r *http.Request) {
	steps, err := s.Reconcile.Steps(r.Context(), chi.URLParam(r, "reconciliationID"))
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	out := make([]reconcile.StepJSON, 0, len(steps.Steps))
	out = append(out, steps.Steps...)
	writeJSON(w, http.StatusOK, map[string]any{"plan_hash": steps.PlanHash, "steps": out})
}

func (s *Server) handleCompleteReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, err := s.Reconcile.Complete(r.Context(), chi.URLParam(r, "reconciliationID"))
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, reconcileSessionResponse(sess, nil))
}
