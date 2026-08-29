package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/plaza"
)

// --- handlers: plaza / publications ---

type publicationSummaryDTO struct {
	ID            string   `json:"id"`
	Slug          string   `json:"slug"`
	Title         string   `json:"title"`
	Description   string   `json:"description"`
	Publisher     string   `json:"publisher"`
	Version       int      `json:"version"`
	Visibility    string   `json:"visibility"`
	BookmarkCount int64    `json:"bookmark_count"`
	FolderCount   int64    `json:"folder_count"`
	Tags          []string `json:"tags"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
	IsMine        bool     `json:"is_mine"`
}

type publicationDetailDTO struct {
	publicationSummaryDTO
	Tree plaza.Node `json:"tree"`
}

func summaryDTO(p plaza.Publication, viewer canonical.UserID) publicationSummaryDTO {
	tags := p.Tags
	if tags == nil {
		tags = []string{}
	}
	return publicationSummaryDTO{
		ID:            p.ID,
		Slug:          p.Slug,
		Title:         p.Title,
		Description:   p.Description,
		Publisher:     p.PublisherName,
		Version:       p.Version,
		Visibility:    string(p.Visibility),
		BookmarkCount: p.BookmarkCount,
		FolderCount:   p.FolderCount,
		Tags:          tags,
		CreatedAt:     p.CreatedAt.Format("2006-01-02T15:04:05Z"),
		UpdatedAt:     p.UpdatedAt.Format("2006-01-02T15:04:05Z"),
		IsMine:        p.OwnerUserID == string(viewer),
	}
}

func detailDTO(p plaza.Publication, viewer canonical.UserID) publicationDetailDTO {
	tree := p.Tree
	if tree.Children == nil {
		tree.Children = []plaza.Node{}
	}
	return publicationDetailDTO{publicationSummaryDTO: summaryDTO(p, viewer), Tree: tree}
}

func (s *Server) handleListPlaza(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	q := r.URL.Query().Get("q")
	all, err := s.Plaza.ListPlaza(r.Context(), q)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	mine, err := s.Plaza.ListMine(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	// The plaza index carries only plaza-visible publications; private
	// ones reach their owner through the same endpoint flagged is_mine so
	// the 我的发布 tab works without a second round trip.
	byID := map[string]bool{}
	for _, p := range all {
		byID[p.ID] = true
	}
	all = append(all, filterPrivate(mine, byID)...)
	out := make([]publicationSummaryDTO, 0, len(all))
	for _, p := range all {
		out = append(out, summaryDTO(p, canonical.UserID(u.ID)))
	}
	writeJSON(w, http.StatusOK, map[string]any{"publications": out})
}

func filterPrivate(mine []plaza.Publication, plazaIDs map[string]bool) []plaza.Publication {
	var out []plaza.Publication
	for _, p := range mine {
		if !plazaIDs[p.ID] {
			out = append(out, p)
		}
	}
	return out
}

func (s *Server) handleGetPublication(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	pub, err := s.Plaza.Get(r.Context(), canonical.UserID(u.ID), chi.URLParam(r, "publicationID"))
	if err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, detailDTO(pub, canonical.UserID(u.ID)))
}

type publishRequest struct {
	SpaceID    string   `json:"space_id"`
	RootNodeID string   `json:"root_node_id"`
	Title      string   `json:"title"`
	Desc       string   `json:"description"`
	Tags       []string `json:"tags"`
	Visibility string   `json:"visibility"`
}

func (s *Server) handlePublish(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	var req publishRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	pub, err := s.Plaza.Publish(r.Context(), canonical.UserID(u.ID), plaza.PublishParams{
		SpaceID:    canonical.SpaceID(req.SpaceID),
		RootNodeID: req.RootNodeID,
		Title:      req.Title,
		Desc:       req.Desc,
		Tags:       req.Tags,
		Visibility: plaza.Visibility(req.Visibility),
	})
	if err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, detailDTO(pub, canonical.UserID(u.ID)))
}

type updatePublicationRequest struct {
	Title       *string `json:"title"`
	Description *string `json:"description"`
	Visibility  *string `json:"visibility"`
	// Snapshot signals a re-capture from the source space.
	Snapshot bool `json:"snapshot"`
}

func (s *Server) handleUpdatePublication(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	id := chi.URLParam(r, "publicationID")
	var req updatePublicationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Snapshot {
		pub, err := s.Plaza.UpdateSnapshot(r.Context(), canonical.UserID(u.ID), id)
		if err != nil {
			s.writePlazaError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, detailDTO(pub, canonical.UserID(u.ID)))
		return
	}
	var vis *plaza.Visibility
	if req.Visibility != nil {
		v := plaza.Visibility(*req.Visibility)
		vis = &v
	}
	pub, err := s.Plaza.UpdateMeta(r.Context(), canonical.UserID(u.ID), id, req.Title, req.Description, vis)
	if err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, detailDTO(pub, canonical.UserID(u.ID)))
}

func (s *Server) handleUnpublish(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	if err := s.Plaza.Unpublish(r.Context(), canonical.UserID(u.ID), chi.URLParam(r, "publicationID")); err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type applyPublicationRequest struct {
	SpaceID  string    `json:"space_id"`
	Parent   parentDTO `json:"parent"`
	Strategy string    `json:"strategy"`
}

func (s *Server) handleApplyPublication(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	id := chi.URLParam(r, "publicationID")
	var req applyPublicationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	res, err := s.Plaza.Apply(r.Context(), canonical.UserID(u.ID), id, plaza.ApplyParams{
		SpaceID:  canonical.SpaceID(req.SpaceID),
		Parent:   req.Parent.toDomain(),
		Strategy: req.Strategy,
	})
	if err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) writePlazaError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, plaza.ErrNotFound):
		s.writeError(w, r, http.StatusNotFound, "PUBLICATION_NOT_FOUND", "unknown publication")
	case errors.Is(err, plaza.ErrNotOwner):
		s.writeError(w, r, http.StatusForbidden, "NOT_PUBLICATION_OWNER", "publication belongs to another user")
	case errors.Is(err, plaza.ErrTitleRequired):
		s.writeError(w, r, http.StatusBadRequest, "TITLE_REQUIRED", "title must not be empty")
	case errors.Is(err, plaza.ErrSourceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SOURCE_NOT_FOUND", "source node not found")
	case errors.Is(err, plaza.ErrSpaceForbidden):
		s.writeError(w, r, http.StatusForbidden, "NOT_SPACE_OWNER", "space belongs to another user")
	case errors.Is(err, plaza.ErrInvalidApply):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_APPLY", "strategy must be merge or replace")
	case errors.Is(err, canonical.ErrSpaceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
	case errors.Is(err, canonical.ErrParentNotFolder), errors.Is(err, canonical.ErrNodeIsBookmark):
		s.writeError(w, r, http.StatusConflict, "PARENT_NOT_FOLDER", "target parent must be a folder")
	default:
		s.Logger.Error("plaza internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
