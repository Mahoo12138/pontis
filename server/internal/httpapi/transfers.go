package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/spacetransfer"
)

// --- handlers: cross-space transfer (doc 08 §15) ---
// Two entry points share one service: the device endpoint for
// extension-initiated transfers (e.g. a drag across two mounts) and the
// session endpoint for the web explorer.

type transferRequest struct {
	TransferID    string    `json:"transfer_id"`
	SourceSpaceID string    `json:"source_space_id"`
	TargetSpaceID string    `json:"target_space_id"`
	NodeID        string    `json:"node_id"`
	TargetParent  parentDTO `json:"target_parent"`
	BeforeID      *string   `json:"before_id"`
}

type nodeMappingDTO struct {
	SourceNodeID string `json:"source_node_id"`
	TargetNodeID string `json:"target_node_id"`
}

type transferResponse struct {
	TransferID     string           `json:"transfer_id"`
	SourceRevision int64            `json:"source_revision"`
	TargetRevision int64            `json:"target_revision"`
	Mapping        []nodeMappingDTO `json:"mapping"`
}

func transferResponseOf(res spacetransfer.TransferResult) transferResponse {
	mapping := make([]nodeMappingDTO, 0, len(res.Mapping))
	for _, m := range res.Mapping {
		mapping = append(mapping, nodeMappingDTO{
			SourceNodeID: string(m.SourceNodeID),
			TargetNodeID: string(m.TargetNodeID),
		})
	}
	return transferResponse{
		TransferID:     res.TransferID,
		SourceRevision: res.SourceRevision,
		TargetRevision: res.TargetRevision,
		Mapping:        mapping,
	}
}

func toTransferRequest(req transferRequest, sourceSpace string) (spacetransfer.Request, error) {
	source := sourceSpace
	if source == "" {
		source = req.SourceSpaceID
	}
	if source == "" || req.TargetSpaceID == "" || req.NodeID == "" {
		return spacetransfer.Request{}, spacetransfer.ErrInvalidRequest
	}
	out := spacetransfer.Request{
		TransferID:   req.TransferID,
		SourceSpace:  canonical.SpaceID(source),
		TargetSpace:  canonical.SpaceID(req.TargetSpaceID),
		NodeID:       canonical.NodeID(req.NodeID),
		TargetParent: req.TargetParent.toDomain(),
	}
	if req.BeforeID != nil && *req.BeforeID != "" {
		before := canonical.NodeID(*req.BeforeID)
		out.BeforeID = &before
	}
	return out, nil
}

// handleDeviceTransfer: POST /api/v1/sync/transfers (device credential).
func (s *Server) handleDeviceTransfer(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	var req transferRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	parsed, err := toTransferRequest(req, "")
	if err != nil {
		s.writeSpaceTransferError(w, r, err)
		return
	}
	res, err := s.SpaceTransfer.Transfer(r.Context(), canonical.UserID(dev.OwnerUserID), parsed)
	if err != nil {
		s.writeSpaceTransferError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, transferResponseOf(res))
}

// handleSpaceTransfer: POST /api/v1/spaces/{spaceID}/transfers (web session).
func (s *Server) handleSpaceTransfer(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	sourceSpace := canonical.SpaceID(chi.URLParam(r, "spaceID"))
	var req transferRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	parsed, err := toTransferRequest(req, string(sourceSpace))
	if err != nil {
		s.writeSpaceTransferError(w, r, err)
		return
	}
	res, err := s.SpaceTransfer.Transfer(r.Context(), canonical.UserID(u.ID), parsed)
	if err != nil {
		s.writeSpaceTransferError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, transferResponseOf(res))
}

func (s *Server) writeSpaceTransferError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, spacetransfer.ErrInvalidRequest):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_TRANSFER", "malformed transfer request")
	case errors.Is(err, spacetransfer.ErrSameSpace):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_TRANSFER", "source and target space must differ")
	case errors.Is(err, spacetransfer.ErrTargetParentInvalid):
		s.writeError(w, r, http.StatusBadRequest, "INVALID_TRANSFER", "target parent must be a folder in the target space")
	case errors.Is(err, spacetransfer.ErrTransferIDReused):
		s.writeError(w, r, http.StatusConflict, "TRANSFER_ID_REUSED", "transfer_id reused with a different payload")
	case errors.Is(err, spacetransfer.ErrNotSpaceOwner):
		s.writeError(w, r, http.StatusForbidden, "NOT_SPACE_OWNER", "space belongs to another user")
	case errors.Is(err, canonical.ErrSpaceNotFound):
		s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
	case errors.Is(err, canonical.ErrNodeNotFound):
		s.writeError(w, r, http.StatusNotFound, "NODE_NOT_FOUND", "unknown node")
	default:
		s.Logger.Error("space transfer internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
