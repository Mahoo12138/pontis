package httpapi

import (
	"errors"
	"net/http"
	"strconv"

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
	// Matches carries up to three paths inside the published tree that hit the
	// search term. Absent when nothing was searched or only metadata matched.
	Matches []string `json:"matches,omitempty"`
}

// publicationImportDTO is what the viewer's own apply of this publication
// looks like: which version is in place, where, and whether the publisher has
// moved on since.
type publicationImportDTO struct {
	LastVersion  int    `json:"last_version"`
	SpaceID      string `json:"space_id"`
	TargetParent string `json:"target_parent"`
	HasUpdate    bool   `json:"has_update"`
}

type publicationDetailDTO struct {
	publicationSummaryDTO
	Tree   plaza.Node            `json:"tree"`
	Import *publicationImportDTO `json:"import,omitempty"`
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
	viewer := canonical.UserID(u.ID)
	query := r.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))

	results, total, err := s.Plaza.Search(r.Context(), viewer, plaza.SearchParams{
		Q:         query.Get("q"),
		Tag:       query.Get("tag"),
		Publisher: query.Get("publisher"),
		Sort:      query.Get("sort"),
		Limit:     limit,
		Offset:    offset,
		OnlyMine:  query.Get("mine") == "1",
	})
	if err != nil {
		s.Logger.Error("plaza search failed", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]publicationSummaryDTO, 0, len(results))
	for _, res := range results {
		dto := summaryDTO(res.Publication, viewer)
		dto.Matches = res.Matches
		out = append(out, dto)
	}
	// total counts every match before paging, so the interface can tell "this
	// is the whole answer" from "there is more to load".
	writeJSON(w, http.StatusOK, map[string]any{"publications": out, "total": total})
}

func (s *Server) handlePlazaFacets(w http.ResponseWriter, r *http.Request) {
	tags, publishers, err := s.Plaza.Facets(r.Context())
	if err != nil {
		s.Logger.Error("plaza facets failed", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags, "publishers": publishers})
}

func (s *Server) handleGetPublication(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	viewer := canonical.UserID(u.ID)
	pub, err := s.Plaza.Get(r.Context(), viewer, chi.URLParam(r, "publicationID"))
	if err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	dto := detailDTO(pub, viewer)
	imp, err := s.Plaza.LatestImport(r.Context(), viewer, pub.ID)
	switch {
	case err == nil:
		dto.Import = &publicationImportDTO{
			LastVersion:  imp.LastVersion,
			SpaceID:      string(imp.SpaceID),
			TargetParent: plaza.ParentKey(imp.Parent),
			HasUpdate:    imp.LastVersion < pub.Version,
		}
	case !errors.Is(err, plaza.ErrNotFound):
		s.writePlazaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, dto)
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
	Title       *string   `json:"title"`
	Description *string   `json:"description"`
	Tags        *[]string `json:"tags"`
	Visibility  *string   `json:"visibility"`
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
	meta := plaza.MetaParams{
		Title:       req.Title,
		Description: req.Description,
		Tags:        req.Tags,
		Visibility:  vis,
	}
	pub, err := s.Plaza.UpdateMeta(r.Context(), canonical.UserID(u.ID), id, meta)
	if err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, detailDTO(pub, canonical.UserID(u.ID)))
}

// publicationVersionDTO is one entry of a publication's snapshot history.
type publicationVersionDTO struct {
	Version       int    `json:"version"`
	BookmarkCount int64  `json:"bookmark_count"`
	FolderCount   int64  `json:"folder_count"`
	Note          string `json:"note"`
	CreatedAt     string `json:"created_at"`
}

func (s *Server) handleListPublicationVersions(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	versions, err := s.Plaza.Versions(r.Context(), canonical.UserID(u.ID), chi.URLParam(r, "publicationID"))
	if err != nil {
		s.writePlazaError(w, r, err)
		return
	}
	out := make([]publicationVersionDTO, 0, len(versions))
	for _, v := range versions {
		out = append(out, publicationVersionDTO{
			Version:       v.Version,
			BookmarkCount: v.BookmarkCount,
			FolderCount:   v.FolderCount,
			Note:          v.Note,
			CreatedAt:     v.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": out})
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

// handlePreviewApplyPublication answers with the counts an apply would report,
// without keeping any of them.
func (s *Server) handlePreviewApplyPublication(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	id := chi.URLParam(r, "publicationID")
	var req applyPublicationRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	res, err := s.Plaza.PreviewApply(r.Context(), canonical.UserID(u.ID), id, plaza.ApplyParams{
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
	case errors.Is(err, plaza.ErrInvalidVisibility):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_VISIBILITY", "visibility must be private or plaza")
	case errors.Is(err, plaza.ErrTitleTooLong):
		s.writeError(w, r, http.StatusBadRequest, "TITLE_TOO_LONG", "title must be at most 255 characters")
	case errors.Is(err, plaza.ErrTooManyTags):
		s.writeError(w, r, http.StatusBadRequest, "TOO_MANY_TAGS", "at most 10 tags")
	case errors.Is(err, plaza.ErrTagTooLong):
		s.writeError(w, r, http.StatusBadRequest, "TAG_TOO_LONG", "each tag must be at most 32 characters")
	case errors.Is(err, canonical.ErrSpaceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
	case errors.Is(err, canonical.ErrParentNotFolder), errors.Is(err, canonical.ErrNodeIsBookmark):
		s.writeError(w, r, http.StatusConflict, "PARENT_NOT_FOLDER", "target parent must be a folder")
	case errors.Is(err, canonical.ErrRootSlotNotFound):
		s.writeError(w, r, http.StatusBadRequest, "TARGET_NOT_FOUND", "target root slot does not exist")
	default:
		s.Logger.Error("plaza internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
