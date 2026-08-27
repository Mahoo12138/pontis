package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/device"
	"pontis/internal/space"
	"pontis/internal/sync"
)

// --- handlers: spaces (session auth) ---

type spaceRequest struct {
	Name string `json:"name"`
}

func (s *Server) handleListSpaces(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	spaces, err := s.Spaces.List(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]spaceResponse, 0, len(spaces))
	for _, sp := range spaces {
		out = append(out, fromSpace(sp))
	}
	writeJSON(w, http.StatusOK, map[string]any{"spaces": out})
}

func (s *Server) handleCreateSpace(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	var req spaceRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	sp, err := s.Spaces.Create(r.Context(), canonical.UserID(u.ID), req.Name)
	if err != nil {
		switch {
		case errors.Is(err, space.ErrEmptyName):
			s.writeError(w, r, http.StatusBadRequest, "INVALID_NAME", "name must not be empty")
		case errors.Is(err, space.ErrTooManySpaces):
			s.writeError(w, r, http.StatusConflict, "TOO_MANY_SPACES", "space limit reached")
		default:
			s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		}
		return
	}
	writeJSON(w, http.StatusCreated, fromSpace(sp))
}

type spaceResponse struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Epoch        int64  `json:"epoch"`
	Revision     int64  `json:"revision"`
	JournalFloor int64  `json:"journal_floor_revision"`
	CreatedAt    string `json:"created_at"`
}

func fromSpace(sp canonical.SyncSpace) spaceResponse {
	return spaceResponse{
		ID:           string(sp.ID),
		Name:         sp.Name,
		Epoch:        sp.Epoch,
		Revision:     sp.CurrentRevision,
		JournalFloor: sp.JournalFloorRevision,
		CreatedAt:    sp.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

// --- handlers: device registration (session auth) ---

type registerDeviceRequest struct {
	Name       string `json:"name"`
	ClientType string `json:"client_type"`
	Browser    string `json:"browser"`
	Platform   string `json:"platform"`
}

type registerDeviceResponse struct {
	Device deviceResponse `json:"device"`
	Token  string         `json:"token"`
}

func (s *Server) handleRegisterDevice(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	var req registerDeviceRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == "" {
		s.writeError(w, r, http.StatusBadRequest, "INVALID_NAME", "device name must not be empty")
		return
	}
	if req.ClientType == "" {
		req.ClientType = "extension"
	}

	dev, secret, err := s.Devices.RegisterDevice(r.Context(), canonical.UserID(u.ID),
		req.Name, req.ClientType, req.Browser, req.Platform)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	writeJSON(w, http.StatusCreated, registerDeviceResponse{
		Device: fromDevice(dev),
		Token:  secret,
	})
}

type deviceResponse struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ClientType string `json:"client_type"`
	Browser    string `json:"browser"`
	Platform   string `json:"platform"`
	SyncMode   string `json:"sync_mode,omitempty"`
	CreatedAt  string `json:"created_at"`
}

func fromDevice(d device.Device) deviceResponse {
	return deviceResponse{
		ID:         d.ID,
		Name:       d.Name,
		ClientType: d.ClientType,
		Browser:    d.Browser,
		Platform:   d.Platform,
		SyncMode:   string(d.SyncMode),
		CreatedAt:  d.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
}

// --- handlers: device-scoped API (device auth) ---

func (s *Server) handleDeviceSpaces(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	spaces, err := s.Spaces.List(r.Context(), dev.OwnerUserID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]spaceResponse, 0, len(spaces))
	for _, sp := range spaces {
		out = append(out, fromSpace(sp))
	}
	writeJSON(w, http.StatusOK, map[string]any{"spaces": out})
}

type createBindingRequest struct {
	SpaceID string `json:"space_id"`
}

func (s *Server) handleListBindings(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	bindings, err := s.Devices.ListBindings(r.Context(), dev.ID)
	if err != nil {
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	out := make([]bindingResponse, 0, len(bindings))
	for _, b := range bindings {
		out = append(out, fromBinding(b))
	}
	writeJSON(w, http.StatusOK, map[string]any{"bindings": out})
}

func (s *Server) handleCreateBinding(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	var req createBindingRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	b, err := s.Devices.BindSpace(r.Context(), dev.ID, canonical.SpaceID(req.SpaceID))
	if err != nil {
		switch {
		case errors.Is(err, device.ErrSpaceNotFound):
			s.writeError(w, r, http.StatusNotFound, "SPACE_NOT_FOUND", "unknown space")
		case errors.Is(err, device.ErrNotSpaceOwner):
			s.writeError(w, r, http.StatusForbidden, "NOT_SPACE_OWNER", "space belongs to another user")
		case errors.Is(err, device.ErrBindingExists):
			s.writeError(w, r, http.StatusConflict, "BINDING_EXISTS", "device already bound to this space")
		case errors.Is(err, device.ErrFullBindingLimit):
			s.writeError(w, r, http.StatusConflict, "FULL_MODE_LIMIT", "full mode allows only one binding")
		default:
			s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		}
		return
	}
	writeJSON(w, http.StatusCreated, fromBinding(b))
}

type bindingResponse struct {
	ID               string `json:"id"`
	DeviceID         string `json:"device_id"`
	SpaceID          string `json:"space_id"`
	State            string `json:"state"`
	Epoch            int64  `json:"epoch"`
	AppliedRevision  int64  `json:"applied_revision"`
	ReceivedRevision int64  `json:"received_revision"`
	MaxClientSeq     int64  `json:"max_client_seq"`
}

func fromBinding(b device.Binding) bindingResponse {
	return bindingResponse{
		ID:               b.ID,
		DeviceID:         b.DeviceID,
		SpaceID:          string(b.SpaceID),
		State:            string(b.State),
		Epoch:            b.Epoch,
		AppliedRevision:  b.AppliedRevision,
		ReceivedRevision: b.ReceivedRevision,
		MaxClientSeq:     b.MaxClientSeq,
	}
}

// --- handlers: /sync ---

type parentDTO struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Key  string `json:"key,omitempty"`
}

type operationDTO struct {
	OpID         string     `json:"op_id"`
	ClientSeq    int64      `json:"client_seq"`
	BaseRevision int64      `json:"base_revision"`
	Type         string     `json:"type"`
	NodeID       string     `json:"node_id"`
	NodeType     string     `json:"node_type,omitempty"`
	Title        string     `json:"title,omitempty"`
	URL          string     `json:"url,omitempty"`
	Parent       *parentDTO `json:"parent,omitempty"`
	BeforeID     *string    `json:"before_id,omitempty"`
}

type syncRequestDTO struct {
	ProtocolVersion  int            `json:"protocol_version"`
	Epoch            int64          `json:"epoch"`
	AppliedRevision  int64          `json:"applied_revision"`
	ReceivedRevision int64          `json:"received_revision"`
	Operations       []operationDTO `json:"operations"`
	MaxChanges       int            `json:"max_changes"`
}

func (dto parentDTO) toDomain() canonical.ParentRef {
	if dto.Type == "node" {
		return canonical.NewNodeParent(canonical.NodeID(dto.ID))
	}
	return canonical.NewRootParent(dto.Key)
}

func toDomainOperation(dto operationDTO) sync.Operation {
	op := sync.Operation{
		OpID:         dto.OpID,
		ClientSeq:    dto.ClientSeq,
		BaseRevision: dto.BaseRevision,
		Type:         sync.OpType(dto.Type),
		NodeID:       canonical.NodeID(dto.NodeID),
		NodeType:     canonical.NodeType(dto.NodeType),
		Title:        dto.Title,
		URL:          dto.URL,
	}
	if dto.Parent != nil {
		op.Parent = dto.Parent.toDomain()
	}
	if dto.BeforeID != nil {
		id := canonical.NodeID(*dto.BeforeID)
		op.BeforeID = &id
	}
	return op
}

type operationResultDTO struct {
	OpID                string `json:"op_id"`
	ClientSeq           int64  `json:"client_seq"`
	Status              string `json:"status"`
	Reason              string `json:"reason"`
	ResultRevision      int64  `json:"result_revision"`
	SettleAfterRevision int64  `json:"settle_after_revision"`
}

type changeDTO struct {
	Revision int64           `json:"revision"`
	Type     string          `json:"type"`
	NodeID   string          `json:"node_id"`
	Payload  json.RawMessage `json:"payload"`
}

type syncResponseDTO struct {
	ProtocolVersion      int                  `json:"protocol_version"`
	Epoch                int64                `json:"epoch"`
	JournalFloorRevision int64                `json:"journal_floor_revision"`
	FromRevision         int64                `json:"from_revision"`
	ThroughRevision      int64                `json:"through_revision"`
	ServerRevision       int64                `json:"server_revision"`
	HasMore              bool                 `json:"has_more"`
	OperationResults     []operationResultDTO `json:"operation_results"`
	Changes              []changeDTO          `json:"changes"`
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	bindingID := chi.URLParam(r, "bindingID")

	binding, err := s.Devices.GetBindingByID(r.Context(), bindingID)
	if err != nil {
		s.writeError(w, r, http.StatusNotFound, "BINDING_NOT_FOUND", "unknown binding")
		return
	}
	if binding.DeviceID != dev.ID {
		// Resource ids are never authorization capabilities (doc 22 D.6).
		s.writeError(w, r, http.StatusForbidden, "NOT_BINDING_OWNER", "binding belongs to another device")
		return
	}

	var dto syncRequestDTO
	if !decodeJSON(w, r, &dto) {
		return
	}

	ops := make([]sync.Operation, 0, len(dto.Operations))
	for _, opDTO := range dto.Operations {
		ops = append(ops, toDomainOperation(opDTO))
	}

	resp, err := s.Sync.Sync(r.Context(), sync.SyncRequest{
		ProtocolVersion:  dto.ProtocolVersion,
		DeviceID:         canonical.DeviceID(dev.ID),
		DeviceName:       dev.Name,
		SpaceID:          binding.SpaceID,
		Epoch:            dto.Epoch,
		AppliedRevision:  dto.AppliedRevision,
		ReceivedRevision: dto.ReceivedRevision,
		Operations:       ops,
		MaxChanges:       dto.MaxChanges,
	})
	if err != nil {
		s.writeSyncError(w, r, err)
		return
	}

	out := syncResponseDTO{
		ProtocolVersion:      resp.ProtocolVersion,
		Epoch:                resp.Epoch,
		JournalFloorRevision: resp.JournalFloorRevision,
		FromRevision:         resp.FromRevision,
		ThroughRevision:      resp.ThroughRevision,
		ServerRevision:       resp.ServerRevision,
		HasMore:              resp.HasMore,
		Changes:              make([]changeDTO, 0, len(resp.Changes)),
	}
	for _, res := range resp.OperationResults {
		out.OperationResults = append(out.OperationResults, operationResultDTO{
			OpID:                res.OpID,
			ClientSeq:           res.ClientSeq,
			Status:              string(res.Status),
			Reason:              res.Reason,
			ResultRevision:      res.ResultRevision,
			SettleAfterRevision: res.SettleAfterRevision,
		})
	}
	for _, ch := range resp.Changes {
		out.Changes = append(out.Changes, changeDTO{
			Revision: ch.Revision,
			Type:     ch.Type,
			NodeID:   ch.NodeID,
			Payload:  json.RawMessage(ch.PayloadJSON),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// writeSyncError maps protocol failures to the unified error envelope.
func (s *Server) writeSyncError(w http.ResponseWriter, r *http.Request, err error) {
	var perr *sync.ProtocolError
	if !errors.As(err, &perr) {
		s.Logger.Error("sync internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
		return
	}
	status := http.StatusConflict
	switch perr.Code {
	case sync.CodeSyncProtocolUnsupported, sync.CodeInvalidWatermark:
		status = http.StatusBadRequest
	case sync.CodeBindingNotActive, sync.CodeOpIDReused:
		status = http.StatusConflict
	}
	s.writeError(w, r, status, perr.Code, perr.Message)
}
