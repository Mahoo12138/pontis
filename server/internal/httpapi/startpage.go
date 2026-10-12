package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"pontis/internal/canonical"
	"pontis/internal/startpage"
)

// The start page reads the canonical tree through a projection with no write
// path: no binding is created, no watermark moves, and no pending operation is
// touched on the way to showing one folder (start-page doc §11.1).
//
// One route, one credential. A device asks for the subtree of a folder in a
// space it already syncs; entitlement is derived from that binding rather than
// from a second approval the account would have to grant again. What the
// endpoint still refuses is the shape: one folder, its descendants only,
// within the size the page can honestly render (§11.3).

// --- DTOs ---

type startPageSourceResponse struct {
	SpaceID     string `json:"space_id"`
	SpaceName   string `json:"space_name"`
	FolderID    string `json:"folder_id"`
	FolderTitle string `json:"folder_title"`
}

type startPageSnapshotMeta struct {
	Epoch       int64  `json:"epoch"`
	Revision    int64  `json:"revision"`
	CapturedAt  string `json:"captured_at"`
	Complete    bool   `json:"complete"`
	SourceTitle string `json:"source_title"`
}

type startPageNodeResponse struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	ParentID   string `json:"parent_id"`
	Title      string `json:"title"`
	URL        string `json:"url,omitempty"`
	Position   int64  `json:"position"`
	ChildCount int64  `json:"child_count,omitempty"`
	UpdatedAt  string `json:"updated_at"`
}

type startPageSnapshotResponse struct {
	SchemaVersion int                     `json:"schema_version"`
	InstanceID    string                  `json:"instance_id"`
	UserID        string                  `json:"user_id"`
	Source        startPageSourceResponse `json:"source"`
	Snapshot      startPageSnapshotMeta   `json:"snapshot"`
	Nodes         []startPageNodeResponse `json:"nodes"`
}

// startpageSchemaVersion is the shape of the snapshot payload. A client that
// cannot read this version refuses the snapshot rather than mis-rendering it.
const startpageSchemaVersion = 1

// snapshotDTO projects one consistent subtree read. Epoch and revision ride
// along as integers, the encoding the sync protocol already uses for
// watermarks: a second wire format for the same number would be a second thing
// to get wrong when the two drift.
func (s *Server) snapshotDTO(userID canonical.UserID, sub startpage.Subtree) startPageSnapshotResponse {
	// Every node in a source subtree hangs off a folder inside it; only the
	// space's own root slots are parentless, and those are above the source.
	childCount := map[canonical.NodeID]int64{}
	for _, n := range sub.Nodes {
		if n.Parent.Type == canonical.ParentTypeNode {
			childCount[n.Parent.NodeID]++
		}
	}

	nodes := make([]startPageNodeResponse, 0, len(sub.Nodes))
	for _, n := range sub.Nodes {
		nodes = append(nodes, startPageNodeResponse{
			ID:       string(n.ID),
			Type:     string(n.Type),
			ParentID: string(n.Parent.NodeID),
			Title:    n.Title,
			URL:      n.URL,
			Position: n.Position,
			// The folder entry card may show how many direct children it has;
			// counting them here costs nothing and keeps the client from
			// walking the tree for a decoration.
			ChildCount: childCount[n.ID],
			UpdatedAt:  n.UpdatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}

	return startPageSnapshotResponse{
		SchemaVersion: startpageSchemaVersion,
		InstanceID:    s.InstanceID,
		UserID:        string(userID),
		Source: startPageSourceResponse{
			SpaceID:     string(sub.Space.ID),
			SpaceName:   sub.Space.Name,
			FolderID:    string(sub.Source.ID),
			FolderTitle: sub.Source.Title,
		},
		Snapshot: startPageSnapshotMeta{
			Epoch: sub.Space.Epoch,
			// The revision the tree was read at, not one the start page may
			// report back: this projection observes the tree, it never advances
			// anything in it.
			Revision:    sub.Space.CurrentRevision,
			CapturedAt:  sub.Space.UpdatedAt.Format("2006-01-02T15:04:05Z"),
			Complete:    true,
			SourceTitle: sub.Source.Title,
		},
		Nodes: nodes,
	}
}

// --- handlers ---

// handleDeviceStartPageSnapshot returns the subtree of one folder in a space
// this device already syncs.
//
// The folder arrives on the request because the device is entitled to the whole
// space already — naming a folder inside it is not a widening. The two things
// that are NOT taken from the request are which space the device may read
// (its bindings decide) and how far the answer reaches (the subtree, never the
// folder's parents or another space).
func (s *Server) handleDeviceStartPageSnapshot(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	spaceID := canonical.SpaceID(r.URL.Query().Get("space_id"))
	folderID := canonical.NodeID(r.URL.Query().Get("folder_id"))
	if spaceID == "" || folderID == "" {
		s.writeError(w, r, http.StatusBadRequest, "START_PAGE_NOT_CONFIGURED", "space_id and folder_id are required")
		return
	}

	sub, err := s.StartPage.Snapshot(r.Context(), dev.ID, spaceID, folderID)
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}

	// Private data in a shared cache is a leak with a long half-life: the
	// application keeps its own snapshot and this response is not it.
	w.Header().Set("Cache-Control", "no-store")

	resp := s.snapshotDTO(dev.OwnerUserID, sub)
	etag := startPageETag(sub)
	w.Header().Set("ETag", etag)
	// The conditional check happens after the read that validates the device,
	// its account and its binding. Answering 304 from the tag alone is the one
	// path that could keep serving a revoked device's bookmarks for as long as
	// its folder happened not to change (§13.3, SP-14).
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// startPageETag names the exact bytes this read produces: this source, at this
// tree position. A folder that moved out from under the reader, or a space that
// advanced, produces a different tag, so a client holding the old snapshot is
// told to fetch rather than being quietly served.
func startPageETag(sub startpage.Subtree) string {
	return fmt.Sprintf(`"sp-%s-%s-%d-%d"`,
		shorten(string(sub.Space.ID)), shorten(string(sub.Source.ID)),
		sub.Space.Epoch, sub.Space.CurrentRevision)
}

func shorten(id string) string {
	// Only the first id segment is needed to make the tag vary per resource,
	// and a full UUID in an ETag is a resource id on every proxy log between
	// here and the client (§16.3).
	if i := strings.IndexByte(id, '-'); i > 0 {
		return id[:i]
	}
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// writeStartPageError maps the projection's failures to the unified envelope.
func (s *Server) writeStartPageError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, startpage.ErrSpaceNotSynced):
		// Same answer for "no such space" and "not yours to sync": the first
		// would tell a caller which space ids this account has (§13.3).
		s.writeError(w, r, http.StatusNotFound, "START_PAGE_PERMISSION_REQUIRED",
			"this device does not sync that space")
	case errors.Is(err, startpage.ErrSourceUnavailable):
		s.writeError(w, r, http.StatusNotFound, "START_PAGE_SOURCE_UNAVAILABLE", "the configured source is no longer available")
	case errors.Is(err, startpage.ErrSourceTooLarge):
		s.writeErrorWithDetails(w, r, http.StatusRequestEntityTooLarge, "START_PAGE_SOURCE_TOO_LARGE",
			"this folder is larger than the start page reads",
			map[string]any{"max_nodes": startpage.MaxDescendants, "max_bytes": startpage.MaxSnapshotBytes})
	default:
		s.Logger.Error("start-page internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}
