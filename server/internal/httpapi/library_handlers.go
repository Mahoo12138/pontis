package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/library"
)

// --- handlers: web-facing bookmark library (session auth, doc 08 §4) ---

// requireOwnedSpace resolves the space URL param and enforces that the
// authenticated user owns it.
func (s *Server) requireOwnedSpace(w http.ResponseWriter, r *http.Request) (canonical.SyncSpace, bool) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	spaces, err := s.Spaces.List(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return canonical.SyncSpace{}, false
	}
	for _, space := range spaces {
		if space.ID == spaceID {
			return space, true
		}
	}
	s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
	return canonical.SyncSpace{}, false
}

type nodeResponse struct {
	ID                string  `json:"id"`
	SpaceID           string  `json:"space_id"`
	Type              string  `json:"type"`
	Title             string  `json:"title"`
	URL               *string `json:"url"`
	ParentID          *string `json:"parent_id"`
	RootKey           *string `json:"root_key"`
	Position          int64   `json:"position"`
	CreatedRevision   int64   `json:"created_revision"`
	TitleRevision     int64   `json:"title_revision"`
	URLRevision       int64   `json:"url_revision"`
	StructureRevision int64   `json:"structure_revision"`
	CreatedAt         string  `json:"created_at"`
	UpdatedAt         string  `json:"updated_at"`
}

func fromNode(n canonical.Node) nodeResponse {
	var url, parentID, rootKey *string
	if n.URL != "" {
		u := n.URL
		url = &u
	}
	if n.Parent.Type == canonical.ParentTypeNode {
		p := string(n.Parent.NodeID)
		parentID = &p
	} else {
		k := n.Parent.RootKey
		rootKey = &k
	}
	return nodeResponse{
		ID:                string(n.ID),
		SpaceID:           string(n.SpaceID),
		Type:              string(n.Type),
		Title:             n.Title,
		URL:               url,
		ParentID:          parentID,
		RootKey:           rootKey,
		Position:          n.Position,
		CreatedRevision:   n.CreatedRevision,
		TitleRevision:     n.TitleRevision,
		URLRevision:       n.URLRevision,
		StructureRevision: n.StructureRevision,
		CreatedAt:         n.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt:         n.UpdatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

func (s *Server) handleListNodes(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	nodes, err := s.Library.ListNodes(r.Context(), space.ID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]nodeResponse, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, fromNode(n))
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": out})
}

type rootSlotResponse struct {
	SpaceID     string `json:"space_id"`
	Key         string `json:"key"`
	DisplayName string `json:"display_name"`
	Position    int64  `json:"position"`
	CreatedAt   string `json:"created_at"`
}

func (s *Server) handleListRootSlots(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	slots, err := s.Library.RootSlots(r.Context(), space.ID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]rootSlotResponse, 0, len(slots))
	for _, slot := range slots {
		out = append(out, rootSlotResponse{
			SpaceID:     string(slot.SpaceID),
			Key:         slot.Key,
			DisplayName: slot.DisplayName,
			Position:    slot.Position,
			CreatedAt:   slot.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"root_slots": out})
}

type createNodeRequest struct {
	Type     string     `json:"type"`
	Title    string     `json:"title"`
	URL      string     `json:"url"`
	Parent   *parentDTO `json:"parent"`
	BeforeID string     `json:"before_id"`
}

func (s *Server) handleCreateNode(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	u, _ := currentUser(r)
	var req createNodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Parent == nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_PARENT", "parent is required")
		return
	}
	params := library.CreateParams{
		Type:   canonical.NodeType(req.Type),
		Title:  req.Title,
		URL:    req.URL,
		Parent: req.Parent.toDomain(),
	}
	if req.BeforeID != "" {
		id := canonical.NodeID(req.BeforeID)
		params.BeforeID = &id
	}
	node, err := s.Library.Create(r.Context(), space.ID, canonical.UserID(u.ID), params)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, fromNode(node))
}

type updateNodeRequest struct {
	Title *string `json:"title"`
	URL   *string `json:"url"`
}

func (s *Server) handleUpdateNode(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	u, _ := currentUser(r)
	var req updateNodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	node, err := s.Library.Update(r.Context(), space.ID, canonical.UserID(u.ID),
		canonical.NodeID(chi.URLParam(r, "nodeID")), req.Title, req.URL)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, fromNode(node))
}

func (s *Server) handleMoveNode(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	u, _ := currentUser(r)
	var req struct {
		Parent   *parentDTO `json:"parent"`
		BeforeID string     `json:"before_id"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Parent == nil {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_PARENT", "parent is required")
		return
	}
	var beforeID *canonical.NodeID
	if req.BeforeID != "" {
		id := canonical.NodeID(req.BeforeID)
		beforeID = &id
	}
	node, err := s.Library.Move(r.Context(), space.ID, canonical.UserID(u.ID),
		canonical.NodeID(chi.URLParam(r, "nodeID")), req.Parent.toDomain(), beforeID)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, fromNode(node))
}

func (s *Server) handleDeleteNode(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	u, _ := currentUser(r)
	err := s.Library.Delete(r.Context(), space.ID, canonical.UserID(u.ID), canonical.NodeID(chi.URLParam(r, "nodeID")))
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type activityResponse struct {
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Actor     string `json:"actor"`
	Action    string `json:"action"`
	Summary   string `json:"summary"`
	Undoable  bool   `json:"undoable"`
}

func (s *Server) handleListActivity(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	entries, err := s.Library.Activity(r.Context(), space.ID, 100)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]activityResponse, 0, len(entries))
	for _, e := range entries {
		out = append(out, activityResponse{
			ID:        e.ID,
			Timestamp: e.Timestamp.Format("2006-01-02T15:04:05Z"),
			Actor:     e.Actor,
			Action:    e.Action,
			Summary:   e.Summary,
			Undoable:  e.Undoable,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"activity": out})
}

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	devices, err := s.Devices.ListOwnerDevices(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]deviceResponse, 0, len(devices))
	for _, d := range devices {
		out = append(out, fromDevice(d))
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

// handleSettings exposes the product settings the web settings page
// renders. V1 values are static; system_settings wiring comes later.
func (s *Server) handleSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"settings": map[string]any{
			"registration_mode":   "closed",
			"default_locale":      "zh-CN",
			"session_ttl_hours":   24,
			"max_spaces_per_user": 16,
		},
	})
}

// handleUndoActivity applies the inverse of one ChangeSet (doc 15 §8).
// Review-required plans surface as 409 with stable codes; newer state
// is never clobbered.
func (s *Server) handleUndoActivity(w http.ResponseWriter, r *http.Request) {
	space, ok := s.requireOwnedSpace(w, r)
	if !ok {
		return
	}
	u, _ := currentUser(r)
	plan, err := s.Library.UndoChangeSet(r.Context(), space.ID, canonical.UserID(u.ID),
		chi.URLParam(r, "changeSetID"))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	switch plan.Status {
	case canonical.UndoClean:
		if plan.ChangeSet.ID == "" {
			writeJSON(w, http.StatusOK, map[string]any{"status": "nothing_to_undo"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":         "undone",
			"change_set_id":  plan.ChangeSet.ID,
			"last_revision":  plan.ChangeSet.LastRevision,
		})
	case canonical.UndoReviewRequired:
		s.writeError(w, r, http.StatusConflict, "REVIEW_REQUIRED", "undoing would clobber newer state")
	case canonical.UndoExpired:
		s.writeError(w, r, http.StatusConflict, "UNDO_EXPIRED", "the undo window has passed")
	default:
		s.writeError(w, r, http.StatusConflict, "NOT_UNDOABLE", "this operation cannot be undone")
	}
}

// writeLibraryError maps library failures onto the unified envelope.
func (s *Server) writeLibraryError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	code := "INTERNAL"
	switch {
	case errors.Is(err, library.ErrNodeNotFound):
		status, code = http.StatusNotFound, "NODE_NOT_FOUND"
	case errors.Is(err, library.ErrNothingToUpdate):
		status, code = http.StatusBadRequest, "NOTHING_TO_UPDATE"
	case errors.Is(err, canonical.ErrTitleRequired),
		errors.Is(err, canonical.ErrURLRequired),
		errors.Is(err, canonical.ErrURLNotAllowed),
		errors.Is(err, canonical.ErrParentMissing):
		status, code = http.StatusBadRequest, "INVALID_PAYLOAD"
	case errors.Is(err, canonical.ErrParentNotFolder):
		status, code = http.StatusBadRequest, "PARENT_NOT_FOLDER"
	case errors.Is(err, canonical.ErrNodeNotFound):
		status, code = http.StatusNotFound, "NODE_NOT_FOUND"
	case errors.Is(err, canonical.ErrNodeIsSelf),
		errors.Is(err, canonical.ErrTreeCycle):
		status, code = http.StatusConflict, "TREE_CYCLE"
	case errors.Is(err, canonical.ErrSpaceNotFound):
		status, code = http.StatusNotFound, "SPACE_NOT_FOUND"
	}
	if code == "INTERNAL" {
		s.Logger.Error("library internal error", "err", err)
		err = errors.New("internal error")
	}
	s.writeError(w, r, status, code, err.Error())
}
