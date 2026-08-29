package httpapi

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/library"
)

// requireSpaceAccess resolves {spaceID} and enforces that the session user
// owns it (V1: spaces are private, doc 09 §13). The loaded space is stored
// in the request context for the handlers.
func (s *Server) requireSpaceAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := currentUser(r)
		if !ok {
			s.writeError(w, r, http.StatusUnauthorized, "UNAUTHENTICATED", "session required")
			return
		}
		spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
		sp, err := s.Library.Space(r.Context(), spaceID)
		if err != nil {
			if errors.Is(err, canonical.ErrSpaceNotFound) {
				s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
				return
			}
			s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
			return
		}
		if sp.OwnerUserID != canonical.UserID(u.ID) {
			s.writeError(w, r, http.StatusForbidden, "NOT_SPACE_OWNER", "space belongs to another user")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// --- DTOs ---

type nodeResponse struct {
	ID                string `json:"id"`
	SpaceID           string `json:"space_id"`
	Type              string `json:"type"`
	Title             string `json:"title"`
	URL               *string `json:"url"`
	ParentID          *string `json:"parent_id"`
	RootKey           *string `json:"root_key"`
	Position          int64  `json:"position"`
	CreatedRevision   int64  `json:"created_revision"`
	TitleRevision     int64  `json:"title_revision"`
	URLRevision       int64  `json:"url_revision"`
	StructureRevision int64  `json:"structure_revision"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
}

func nodeDTO(n canonical.Node) nodeResponse {
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

type rootSlotResponse struct {
	SpaceID     string `json:"space_id"`
	Key         string `json:"key"`
	DisplayName string `json:"display_name"`
	Position    int64  `json:"position"`
	CreatedAt   string `json:"created_at"`
}

// --- handlers: tree reads ---

func (s *Server) handleListNodes(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	nodes, err := s.Library.Nodes(r.Context(), spaceID)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	out := make([]nodeResponse, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, nodeDTO(n))
	}
	writeJSON(w, http.StatusOK, map[string]any{"nodes": out})
}

func (s *Server) handleListRootSlots(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	slots, err := s.Library.RootSlots(r.Context(), spaceID)
	if err != nil {
		s.writeLibraryError(w, r, err)
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

// --- handlers: node CRUD ---

type createNodeRequest struct {
	Type     string     `json:"type"`
	Title    string     `json:"title"`
	URL      string     `json:"url"`
	Parent   parentDTO  `json:"parent"`
	BeforeID *string    `json:"before_id"`
}

func (s *Server) handleCreateNode(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	var req createNodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	var before *canonical.NodeID
	if req.BeforeID != nil && *req.BeforeID != "" {
		id := canonical.NodeID(*req.BeforeID)
		before = &id
	}
	node, err := s.Library.CreateNode(r.Context(), spaceID, canonical.UserID(u.ID), library.CreateParams{
		Type:     canonical.NodeType(req.Type),
		Title:    req.Title,
		URL:      req.URL,
		Parent:   req.Parent.toDomain(),
		BeforeID: before,
	})
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, nodeDTO(node))
}

type updateNodeRequest struct {
	Title *string `json:"title"`
	URL   *string `json:"url"`
}

func (s *Server) handleUpdateNode(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	nodeID := canonical.NodeID(chi.URLParam(r, "nodeID"))
	var req updateNodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	node, err := s.Library.UpdateNode(r.Context(), spaceID, canonical.UserID(u.ID), nodeID, library.UpdateParams{
		Title: req.Title,
		URL:   req.URL,
	})
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, nodeDTO(node))
}

type moveNodeRequest struct {
	Parent   parentDTO `json:"parent"`
	BeforeID *string   `json:"before_id"`
}

func (s *Server) handleMoveNode(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	nodeID := canonical.NodeID(chi.URLParam(r, "nodeID"))
	var req moveNodeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	var before *canonical.NodeID
	if req.BeforeID != nil && *req.BeforeID != "" {
		id := canonical.NodeID(*req.BeforeID)
		before = &id
	}
	node, err := s.Library.MoveNode(r.Context(), spaceID, canonical.UserID(u.ID), nodeID, library.MoveParams{
		Parent:   req.Parent.toDomain(),
		BeforeID: before,
	})
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, nodeDTO(node))
}

func (s *Server) handleDeleteNode(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	nodeID := canonical.NodeID(chi.URLParam(r, "nodeID"))
	if err := s.Library.DeleteNode(r.Context(), spaceID, canonical.UserID(u.ID), nodeID); err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- handlers: activity ---

type activityResponse struct {
	ID        string `json:"id"`
	Revision  int64  `json:"revision"`
	Actor     string `json:"actor"`
	Action    string `json:"action"`
	Summary   string `json:"summary"`
	Undoable  bool   `json:"undoable"`
}

func (s *Server) handleSpaceActivity(w http.ResponseWriter, r *http.Request) {
	spaceID := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	entries, err := s.Library.Activity(r.Context(), spaceID, library.DefaultActivityLimit)
	if err != nil {
		s.writeLibraryError(w, r, err)
		return
	}
	out := make([]activityResponse, 0, len(entries))
	for _, e := range entries {
		out = append(out, activityResponse{
			ID:       "rev-" + strconv.FormatInt(e.Revision, 10),
			Revision: e.Revision,
			Actor:    e.Actor,
			Action:   e.Action,
			Summary:  e.Summary,
			Undoable: true, // V1: recent canonical changes are undoable in principle.
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"activity": out})
}

// writeLibraryError maps domain errors to the unified envelope.
func (s *Server) writeLibraryError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, canonical.ErrSpaceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
	case errors.Is(err, canonical.ErrNodeNotFound):
		s.writeError(w, r, http.StatusNotFound, "NODE_NOT_FOUND", "unknown node")
	case errors.Is(err, canonical.ErrRootSlotNotFound):
		s.writeError(w, r, http.StatusNotFound, "ROOT_SLOT_NOT_FOUND", "unknown root slot")
	case errors.Is(err, canonical.ErrParentNotFolder):
		s.writeError(w, r, http.StatusConflict, "PARENT_NOT_FOLDER", "parent must be a folder")
	case errors.Is(err, canonical.ErrNodeIsBookmark):
		s.writeError(w, r, http.StatusConflict, "PARENT_NOT_FOLDER", "parent is a bookmark")
	case errors.Is(err, canonical.ErrNodeIsSelf), errors.Is(err, canonical.ErrTreeCycle):
		s.writeError(w, r, http.StatusConflict, "INVALID_MOVE", "move would create a cycle")
	case errors.Is(err, canonical.ErrURLRequired):
		s.writeError(w, r, http.StatusBadRequest, "URL_REQUIRED", "bookmark requires a url")
	case errors.Is(err, canonical.ErrURLNotAllowed):
		s.writeError(w, r, http.StatusBadRequest, "URL_NOT_ALLOWED", "folder cannot have a url")
	case errors.Is(err, canonical.ErrTitleRequired):
		s.writeError(w, r, http.StatusBadRequest, "TITLE_REQUIRED", "title must not be empty")
	case errors.Is(err, library.ErrTitleTooLong):
		s.writeError(w, r, http.StatusBadRequest, "TITLE_TOO_LONG", "title too long")
	case errors.Is(err, library.ErrURLTooLong):
		s.writeError(w, r, http.StatusBadRequest, "URL_TOO_LONG", "url too long")
	default:
		s.Logger.Error("library internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
