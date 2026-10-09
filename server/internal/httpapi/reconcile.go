// Reconciliation endpoints (doc 08 §9-§14): the initialization lifecycle a
// device runs before its binding can take part in incremental sync. The
// engine lives in internal/reconcile; this file is its wire surface.

package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"pontis/internal/device"
	"pontis/internal/reconcile"
)

// sessionDTO is a reconciliation session as the client sees it. Phase, not
// state, carries the progress a client resumes after an MV3 restart.
type sessionDTO struct {
	ID              string `json:"id"`
	BindingID       string `json:"binding_id"`
	SpaceID         string `json:"space_id"`
	Type            string `json:"type"`
	Reason          string `json:"reason,omitempty"`
	State           string `json:"state"`
	Phase           string `json:"phase"`
	SourceEpoch     int64  `json:"source_epoch"`
	SourceRevision  int64  `json:"source_revision"`
	TargetEpoch     int64  `json:"target_epoch"`
	TargetRevision  int64  `json:"target_revision"`
	PlanHash        string `json:"plan_hash,omitempty"`
	ServerCommitted bool   `json:"server_committed"`
	CommitRevision  int64  `json:"commit_revision"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at"`
	CompletedAt     string `json:"completed_at,omitempty"`
}

func fromSession(sess reconcile.Session) sessionDTO {
	return sessionDTO{
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
		CreatedAt:       rfc3339(sess.CreatedAt),
		UpdatedAt:       rfc3339(sess.UpdatedAt),
		CompletedAt:     rfc3339(sess.CompletedAt),
	}
}

// rfc3339 formats an optional timestamp; a zero time is absent, not year 1.
func rfc3339(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02T15:04:05Z")
}

type issueDTO struct {
	ID             string                     `json:"id"`
	Type           string                     `json:"type"`
	Payload        reconcile.IssuePayloadJSON `json:"payload"`
	DefaultChoice  string                     `json:"default_choice"`
	SelectedChoice *string                    `json:"selected_choice,omitempty"`
}

func fromIssues(issues []reconcile.Issue) []issueDTO {
	out := make([]issueDTO, 0, len(issues))
	for _, issue := range issues {
		out = append(out, issueDTO{
			ID:             issue.ID,
			Type:           issue.Type,
			Payload:        issue.Payload,
			DefaultChoice:  issue.DefaultChoice,
			SelectedChoice: issue.SelectedChoice,
		})
	}
	return out
}

type serverSnapshotDTO struct {
	SnapshotID string `json:"snapshot_id"`
	BindingID  string `json:"binding_id"`
	SpaceID    string `json:"space_id"`
	Epoch      int64  `json:"epoch"`
	Revision   int64  `json:"revision"`
	NodeCount  int    `json:"node_count"`
	Checksum   string `json:"checksum"`
	ExpiresAt  string `json:"expires_at"`
	CreatedAt  string `json:"created_at"`
}

func fromServerSnapshot(snap reconcile.ServerSnapshot) serverSnapshotDTO {
	return serverSnapshotDTO{
		SnapshotID: snap.ID,
		BindingID:  snap.BindingID,
		SpaceID:    string(snap.SpaceID),
		Epoch:      snap.Epoch,
		Revision:   snap.Revision,
		NodeCount:  snap.NodeCount,
		Checksum:   snap.Checksum,
		ExpiresAt:  rfc3339(snap.ExpiresAt),
		CreatedAt:  rfc3339(snap.CreatedAt),
	}
}

// serverSnapshotNodeDTO is one frozen row; node_ref is the session-local ref,
// never a canonical id (doc 08 §9).
type serverSnapshotNodeDTO struct {
	NodeRef   string `json:"node_ref"`
	ParentRef string `json:"parent_ref"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	URL       string `json:"url,omitempty"`
	RootKey   string `json:"root_key,omitempty"`
	Position  int64  `json:"position"`
}

// --- ownership ---

// deviceBinding loads a binding and checks it belongs to the calling device.
// Resource ids are never authorization capabilities (doc 22 D.6).
func (s *Server) deviceBinding(w http.ResponseWriter, r *http.Request, bindingID string) (device.Binding, bool) {
	dev, _ := currentDevice(r)
	binding, err := s.Devices.GetBindingByID(r.Context(), bindingID)
	if err != nil {
		s.writeError(w, r, http.StatusNotFound, "BINDING_NOT_FOUND", "unknown binding")
		return device.Binding{}, false
	}
	if binding.DeviceID != dev.ID {
		s.writeError(w, r, http.StatusForbidden, "NOT_BINDING_OWNER", "binding belongs to another device")
		return device.Binding{}, false
	}
	return binding, true
}

// deviceSession loads a session and checks its binding belongs to the
// calling device.
func (s *Server) deviceSession(w http.ResponseWriter, r *http.Request, sessionID string) (reconcile.Session, bool) {
	sess, err := s.Reconcile.Session(r.Context(), sessionID)
	if err != nil {
		s.writeError(w, r, http.StatusNotFound, "RECONCILIATION_NOT_FOUND", "unknown reconciliation")
		return reconcile.Session{}, false
	}
	if _, ok := s.deviceBinding(w, r, sess.BindingID); !ok {
		return reconcile.Session{}, false
	}
	return sess, true
}

// --- handlers ---

// planOf attaches the stored plan preview. A session that has not been
// planned yet simply carries no plan field rather than inventing one.
func (s *Server) planOf(ctx context.Context, sess reconcile.Session) (reconcile.PlanArtifactJSON, bool) {
	if sess.PlanArtifact == "" {
		return reconcile.PlanArtifactJSON{}, false
	}
	plan, err := s.Reconcile.PlanPreview(ctx, sess.ID)
	if err != nil {
		return reconcile.PlanArtifactJSON{}, false
	}
	return plan, true
}

func (s *Server) writeReconcileError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, reconcile.ErrSessionNotFound):
		s.writeError(w, r, http.StatusNotFound, "RECONCILIATION_NOT_FOUND", "unknown reconciliation")
	case errors.Is(err, reconcile.ErrSnapshotInvalid):
		s.writeError(w, r, http.StatusBadRequest, "CLIENT_SNAPSHOT_INVALID", err.Error())
	case errors.Is(err, reconcile.ErrActiveSessionExists):
		s.writeError(w, r, http.StatusConflict, "RECONCILIATION_IN_PROGRESS", "this binding already runs a reconciliation")
	case errors.Is(err, reconcile.ErrBindingNotEligible):
		s.writeError(w, r, http.StatusConflict, "BINDING_NOT_ELIGIBLE", "the binding state does not allow this reconciliation type")
	case errors.Is(err, reconcile.ErrSnapshotMissing):
		s.writeError(w, r, http.StatusConflict, "RECONCILIATION_SNAPSHOTS_MISSING", "both snapshots are needed first")
	case errors.Is(err, reconcile.ErrPlanStale):
		s.writeError(w, r, http.StatusConflict, "PLAN_STALE", "the canonical target moved; preview again")
	case errors.Is(err, reconcile.ErrNotCommitted):
		s.writeError(w, r, http.StatusConflict, "RECONCILIATION_NOT_COMMITTED", "commit the reconciliation first")
	case errors.Is(err, reconcile.ErrInvalidSessionState):
		s.writeError(w, r, http.StatusConflict, "RECONCILIATION_PHASE_INVALID", "this call does not fit the session's phase")
	default:
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}

// handleCreateReconciliation opens the binding's reconciliation session
// (doc 08 §11). An initial session is exactly what a pending binding is
// allowed to open, and completing it is the only way it becomes active.
func (s *Server) handleCreateReconciliation(w http.ResponseWriter, r *http.Request) {
	binding, ok := s.deviceBinding(w, r, chi.URLParam(r, "bindingID"))
	if !ok {
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
	writeJSON(w, http.StatusCreated, map[string]any{"session": fromSession(sess)})
}

// handleSubmitClientSnapshot stores the browser tree for the binding's open
// session (doc 08 §10): session-local refs only, never browser ids.
func (s *Server) handleSubmitClientSnapshot(w http.ResponseWriter, r *http.Request) {
	binding, ok := s.deviceBinding(w, r, chi.URLParam(r, "bindingID"))
	if !ok {
		return
	}
	var snapshot reconcile.ClientSnapshotJSON
	if !decodeJSON(w, r, &snapshot) {
		return
	}
	sess, err := s.Reconcile.SubmitClientSnapshot(r.Context(), binding.ID, snapshot)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": fromSession(sess)})
}

// handleCreateServerSnapshot freezes the canonical tree (doc 08 §9).
// Creating twice returns the snapshot that is already frozen.
func (s *Server) handleCreateServerSnapshot(w http.ResponseWriter, r *http.Request) {
	binding, ok := s.deviceBinding(w, r, chi.URLParam(r, "bindingID"))
	if !ok {
		return
	}
	snap, err := s.Reconcile.CreateServerSnapshot(r.Context(), binding.ID)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, fromServerSnapshot(snap))
}

func (s *Server) handleGetServerSnapshot(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.deviceSnapshot(w, r, chi.URLParam(r, "snapshotID"))
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, fromServerSnapshot(snap))
}

// handleListServerSnapshotNodes pages a frozen snapshot (doc 08 §9). The
// cursor is the offset into this snapshot's own rows, so paging keeps reading
// the point-in-time tree even while the live revision advances.
func (s *Server) handleListServerSnapshotNodes(w http.ResponseWriter, r *http.Request) {
	snap, ok := s.deviceSnapshot(w, r, chi.URLParam(r, "snapshotID"))
	if !ok {
		return
	}
	offset := 0
	if c := r.URL.Query().Get("cursor"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil || n < 0 {
			s.writeError(w, r, http.StatusBadRequest, "INVALID_CURSOR", "cursor is not a snapshot offset")
			return
		}
		offset = n
	}
	limit := 500
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 || n > 2000 {
			s.writeError(w, r, http.StatusBadRequest, "INVALID_LIMIT", "limit must be between 1 and 2000")
			return
		}
		limit = n
	}
	nodes, err := s.Reconcile.ListSnapshotNodes(r.Context(), snap.ID, offset, limit)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	out := map[string]any{
		"nodes": make([]serverSnapshotNodeDTO, 0, len(nodes)),
		"total": snap.NodeCount,
	}
	for _, n := range nodes {
		out["nodes"] = append(out["nodes"].([]serverSnapshotNodeDTO), serverSnapshotNodeDTO{
			NodeRef: n.NodeRef, ParentRef: n.ParentRef, Type: n.Type,
			Title: n.Title, URL: n.URL, RootKey: n.RootKey, Position: n.Position,
		})
	}
	if page := out["nodes"].([]serverSnapshotNodeDTO); len(page) == limit && offset+len(page) < snap.NodeCount {
		out["next_cursor"] = strconv.Itoa(offset + len(page))
	} else {
		out["next_cursor"] = ""
	}
	writeJSON(w, http.StatusOK, out)
}

// deviceSnapshot loads a frozen snapshot and checks its binding belongs to
// the calling device.
func (s *Server) deviceSnapshot(w http.ResponseWriter, r *http.Request, snapshotID string) (reconcile.ServerSnapshot, bool) {
	dev, _ := currentDevice(r)
	snap, err := s.Reconcile.GetServerSnapshot(r.Context(), snapshotID)
	if err != nil {
		s.writeError(w, r, http.StatusNotFound, "SNAPSHOT_NOT_FOUND", "unknown server snapshot")
		return reconcile.ServerSnapshot{}, false
	}
	binding, err := s.Devices.GetBindingByID(r.Context(), snap.BindingID)
	if err != nil || binding.DeviceID != dev.ID {
		s.writeError(w, r, http.StatusForbidden, "NOT_BINDING_OWNER", "snapshot belongs to another device")
		return reconcile.ServerSnapshot{}, false
	}
	return snap, true
}

// handleGetReconciliation returns the session, its issues and the plan
// preview when one exists.
func (s *Server) handleGetReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.deviceSession(w, r, chi.URLParam(r, "sessionID"))
	if !ok {
		return
	}
	_, issues, err := s.Reconcile.GetSessionWithIssues(r.Context(), sess.ID)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	body := map[string]any{"session": fromSession(sess), "issues": fromIssues(issues)}
	if plan, hasPlan := s.planOf(r.Context(), sess); hasPlan {
		body["plan"] = plan
	}
	writeJSON(w, http.StatusOK, body)
}

// handlePlanReconciliation computes the plan and the apply steps, and
// returns what the client must preview (doc 08 §11-12).
func (s *Server) handlePlanReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.deviceSession(w, r, chi.URLParam(r, "sessionID"))
	if !ok {
		return
	}
	planned, issues, err := s.Reconcile.Plan(r.Context(), sess.ID)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	body := map[string]any{"session": fromSession(planned), "issues": fromIssues(issues)}
	if plan, hasPlan := s.planOf(r.Context(), planned); hasPlan {
		body["plan"] = plan
	}
	writeJSON(w, http.StatusOK, body)
}

// handleDecideReconciliation records the user's answers on the open issues
// and recomputes the plan with them folded in (doc 08 §11).
func (s *Server) handleDecideReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.deviceSession(w, r, chi.URLParam(r, "sessionID"))
	if !ok {
		return
	}
	var req struct {
		Decisions map[string]string `json:"decisions"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	decided, issues, err := s.Reconcile.Decide(r.Context(), sess.ID, req.Decisions)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	body := map[string]any{"session": fromSession(decided), "issues": fromIssues(issues)}
	if plan, hasPlan := s.planOf(r.Context(), decided); hasPlan {
		body["plan"] = plan
	}
	writeJSON(w, http.StatusOK, body)
}

// handleCommitReconciliation runs the plan server-side (doc 08 §12). A stale
// plan is refused: the client must preview the new target first.
func (s *Server) handleCommitReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.deviceSession(w, r, chi.URLParam(r, "sessionID"))
	if !ok {
		return
	}
	committed, err := s.Reconcile.Commit(r.Context(), sess.ID)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": fromSession(committed)})
}

// handleReconciliationSteps returns the ensure-state steps the client applies
// to the browser (doc 08 §13).
func (s *Server) handleReconciliationSteps(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.deviceSession(w, r, chi.URLParam(r, "sessionID"))
	if !ok {
		return
	}
	steps, err := s.Reconcile.Steps(r.Context(), sess.ID)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, steps)
}

// handleCompleteReconciliation finishes the session: the binding's baseline
// moves to the committed revision and it becomes active for /sync
// (doc 06 §8).
func (s *Server) handleCompleteReconciliation(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.deviceSession(w, r, chi.URLParam(r, "sessionID"))
	if !ok {
		return
	}
	done, err := s.Reconcile.Complete(r.Context(), sess.ID)
	if err != nil {
		s.writeReconcileError(w, r, err)
		return
	}
	binding, err := s.Devices.GetBindingByID(r.Context(), done.BindingID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session": fromSession(done),
		"binding": map[string]any{
			"id":                binding.ID,
			"state":             string(binding.State),
			"epoch":             binding.Epoch,
			"applied_revision":  binding.AppliedRevision,
			"received_revision": binding.ReceivedRevision,
		},
	})
}
