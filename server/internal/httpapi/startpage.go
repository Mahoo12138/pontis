package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"pontis/internal/canonical"
	"pontis/internal/device"
	"pontis/internal/startpage"
	"pontis/internal/token"
)

// The start page reads the canonical tree through a projection with no write
// path: no binding is created, no watermark moves, and no pending operation
// is touched on the way to showing one folder (start-page doc §11.1).
//
// Two identities reach these routes and they are not interchangeable. A
// device credential may read the source its owner approved for it and
// nothing else — the folder is named by the grant, never by the request. A
// web session acts as its user, so it may approve a source and read any
// folder of any space that user owns (start-page doc §11.2).

// --- DTOs ---

type startPageSourceResponse struct {
	GrantID      string `json:"grant_id"`
	DeviceID     string `json:"device_id"`
	SpaceID      string `json:"space_id"`
	SpaceName    string `json:"space_name"`
	FolderID     string `json:"folder_id"`
	FolderTitle  string `json:"folder_title"`
	GrantVersion int64  `json:"grant_version"`
}

func startPageSourceDTO(g startpage.Grant, spaceName, folderTitle string) startPageSourceResponse {
	return startPageSourceResponse{
		GrantID:      g.ID,
		DeviceID:     g.DeviceID,
		SpaceID:      string(g.SpaceID),
		SpaceName:    spaceName,
		FolderID:     string(g.FolderID),
		FolderTitle:  folderTitle,
		GrantVersion: g.Version,
	}
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
// along as integers, the same encoding the sync protocol uses for watermarks:
// a second wire format for the same number would be a second thing to get
// wrong when the two drift.
func (s *Server) snapshotDTO(userID canonical.UserID, g startpage.Grant, sub startpage.Subtree) startPageSnapshotResponse {
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

	source := startPageSourceDTO(g, sub.Space.Name, sub.Source.Title)
	return startPageSnapshotResponse{
		SchemaVersion: startpageSchemaVersion,
		InstanceID:    s.InstanceID,
		UserID:        string(userID),
		Source:        source,
		Snapshot: startPageSnapshotMeta{
			Epoch: sub.Space.Epoch,
			// The revision the tree was read at, not a revision the start page
			// may report back: this projection observes the tree, it never
			// advances anything in it.
			Revision:    sub.Space.CurrentRevision,
			CapturedAt:  capturedAt(sub),
			Complete:    true,
			SourceTitle: sub.Source.Title,
		},
		Nodes: nodes,
	}
}

// capturedAt is the instant the read was taken. time.Now is fine here — the
// value labels a snapshot already known to be internally consistent, and a
// clock read outside the transaction cannot make the tree inconsistent.
func capturedAt(sub startpage.Subtree) string {
	return sub.Space.UpdatedAt.Format("2006-01-02T15:04:05Z")
}

// --- handlers: device read side ---

// handleDeviceStartPageSource reports the source this device may read. It
// answers from the grant alone, so it cannot be pointed at another folder.
func (s *Server) handleDeviceStartPageSource(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	g, err := s.StartPage.ActiveGrant(r.Context(), dev.ID)
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	sp, folder, err := s.StartPage.Source(r.Context(), g)
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, startPageSourceDTO(g, sp.Name, folder.Title))
}

// handleDeviceStartPageSnapshot returns the whole approved source subtree.
func (s *Server) handleDeviceStartPageSnapshot(w http.ResponseWriter, r *http.Request) {
	dev, _ := currentDevice(r)
	g, err := s.StartPage.ActiveGrant(r.Context(), dev.ID)
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	s.writeStartPageSnapshot(w, r, g.UserID, g, func() (startpage.Subtree, error) {
		return s.StartPage.GrantSnapshot(r.Context(), g)
	})
}

// --- handlers: session side ---

type authorizeStartPageGrantRequest struct {
	DeviceID string `json:"device_id"`
	SpaceID  string `json:"space_id"`
	FolderID string `json:"folder_id"`
}

// handleAuthorizeStartPageGrant confirms a device's source. Only a web
// session may call it: the standing device credential that reads the snapshot
// must not be able to widen what it reads (§11.2).
func (s *Server) handleAuthorizeStartPageGrant(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	var req authorizeStartPageGrantRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	g, err := s.StartPage.Authorize(r.Context(), canonical.UserID(u.ID), req.DeviceID,
		canonical.SpaceID(req.SpaceID), canonical.NodeID(req.FolderID))
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	// The settings screen confirms what it just approved by name, so the
	// answer carries the folder's title rather than leaving the client to
	// look up an id it was never allowed to enumerate.
	sp, folder, err := s.StartPage.Source(r.Context(), g)
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, startPageSourceDTO(g, sp.Name, folder.Title))
}

func (s *Server) handleListStartPageGrants(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	grants, err := s.StartPage.ListGrants(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	// The account settings page lists sources with the names beside them, and
	// a space that has since gone away still has to be shown as one row the
	// user can revoke.
	spaces, err := s.Spaces.List(r.Context(), canonical.UserID(u.ID))
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	names := map[canonical.SpaceID]string{}
	for _, sp := range spaces {
		names[sp.ID] = sp.Name
	}
	out := make([]startPageSourceResponse, 0, len(grants))
	for _, g := range grants {
		out = append(out, startPageSourceDTO(g, names[g.SpaceID], ""))
	}
	writeJSON(w, http.StatusOK, map[string]any{"grants": out})
}

func (s *Server) handleRevokeStartPageGrant(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	if err := s.StartPage.Revoke(r.Context(), canonical.UserID(u.ID), chi.URLParam(r, "grantID")); err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleWebStartPageSnapshot serves the ordinary web start page: the visitor
// is a signed-in account, so ownership of the space is the boundary and no
// device grant is involved.
func (s *Server) handleWebStartPageSnapshot(w http.ResponseWriter, r *http.Request) {
	u, _ := currentUser(r)
	userID := canonical.UserID(u.ID)
	spaceID := canonical.SpaceID(r.URL.Query().Get("space_id"))
	folderID := canonical.NodeID(r.URL.Query().Get("folder_id"))
	if spaceID == "" || folderID == "" {
		s.writeError(w, r, http.StatusBadRequest, "START_PAGE_NOT_CONFIGURED", "space_id and folder_id are required")
		return
	}
	sub, err := s.StartPage.SessionSnapshot(r.Context(), userID, spaceID, folderID)
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	// A session read carries no grant; the source is described by the nodes
	// themselves and the field stays empty rather than inventing an id.
	g := startpage.Grant{UserID: userID, SpaceID: spaceID, FolderID: folderID}
	s.writeStartPageSnapshot(w, r, userID, g, func() (startpage.Subtree, error) { return sub, nil })
}

// writeStartPageSnapshot reads the source and encodes it, answering 304 only
// after the account, device, grant and source have all been checked.
//
// The order is the point. A conditional request whose ETag still matches is
// the one response that could be produced without reading the tree at all —
// and that is exactly how a revoked grant or a disabled account would keep
// serving cached private content for as long as its snapshot stayed
// unchanged (§13.3, SP-14).
func (s *Server) writeStartPageSnapshot(w http.ResponseWriter, r *http.Request,
	userID canonical.UserID, g startpage.Grant, read func() (startpage.Subtree, error)) {

	// Private data in a shared cache is a leak with a long half-life: the
	// application keeps its own snapshot and this response is not it.
	w.Header().Set("Cache-Control", "no-store")

	sub, err := read()
	if err != nil {
		s.writeStartPageError(w, r, err)
		return
	}
	resp := s.snapshotDTO(userID, g, sub)
	etag := startPageETag(g, sub)
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// startPageETag names the exact bytes this read produces: same source, same
// grant version, same tree, same tag. A re-pointed grant cannot reuse the tag
// of the folder it replaced, so a client holding the old snapshot is told to
// fetch rather than being quietly served.
func startPageETag(g startpage.Grant, sub startpage.Subtree) string {
	return fmt.Sprintf(`"sp-%s-%d-%d-%d"`,
		shorten(g.ID), g.Version, sub.Space.Epoch, sub.Space.CurrentRevision)
}

func shorten(id string) string {
	// Only the first id segment is needed to make the tag vary per grant, and
	// a full UUID in an ETag is a resource id on every proxy log between here
	// and the client (§16.3).
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
	case errors.Is(err, startpage.ErrNotConfigured):
		// 404, and with no source details: "this browser has no start-page
		// source yet" is the whole answer, and the client has its own config
		// to tell that apart from "the source you had is gone".
		s.writeError(w, r, http.StatusNotFound, "START_PAGE_NOT_CONFIGURED", "no start-page source is configured")
	case errors.Is(err, startpage.ErrSourceUnavailable):
		s.writeError(w, r, http.StatusNotFound, "START_PAGE_SOURCE_UNAVAILABLE", "the configured source is no longer available")
	case errors.Is(err, startpage.ErrSourceTooLarge):
		s.writeErrorWithDetails(w, r, http.StatusRequestEntityTooLarge, "START_PAGE_SOURCE_TOO_LARGE",
			"this folder is larger than the start page reads",
			map[string]any{"max_nodes": startpage.MaxDescendants, "max_bytes": startpage.MaxSnapshotBytes})
	case errors.Is(err, startpage.ErrDeviceNotFound), errors.Is(err, startpage.ErrSpaceNotFound),
		errors.Is(err, startpage.ErrGrantNotFound):
		// An unknown id and someone else's id deny the same way. Neither says
		// which one it was, so a caller cannot walk the account looking for
		// devices, spaces or grants that exist (§13.3).
		s.writeError(w, r, http.StatusNotFound, "START_PAGE_PERMISSION_REQUIRED",
			"the source or device cannot be used by this account")
	case errors.Is(err, token.ErrTokenInvalid):
		s.writeError(w, r, http.StatusUnauthorized, "TOKEN_INVALID", "credential invalid")
	default:
		s.Logger.Error("start-page internal error", "err", err)
		s.writeError(w, r, http.StatusInternalServerError, "INTERNAL", "internal error")
	}
}

// requireStartPageAdmin guards the routes that approve, move or revoke a
// source. The standing device credential is refused here by name, before it
// reaches the session middleware: it is the credential that *reads* a grant,
// and one that could widen its own read range would leave the grant
// describing nothing (§11.2).
//
// Left to requireSession a device secret is refused too, but as
// SESSION_INVALID — which an extension would read as "my login broke" and
// answer by re-pairing.
func (s *Server) requireStartPageAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(bearerToken(r), device.TokenPrefix) {
			s.writeError(w, r, http.StatusForbidden, "START_PAGE_PERMISSION_REQUIRED",
				"a start-page source is approved by the account, not by the device credential")
			return
		}
		next.ServeHTTP(w, r)
	})
}
