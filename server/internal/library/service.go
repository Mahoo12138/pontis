// Package library implements the web-side canonical tree access: reading
// the explorer tree and applying user-initiated CRUD through the canonical
// executor, plus the activity feed derived from the journal.
package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Store is the read-side persistence contract required by the service.
type Store interface {
	GetSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	GetNode(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error)
	ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)
	ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error)
	ListJournal(ctx context.Context, space canonical.SpaceID, epoch int64, limit int) ([]JournalRow, error)
	DeviceName(ctx context.Context, id string) (string, error)
	UserName(ctx context.Context, id string) (string, error)
}

// JournalRow is the storage representation of one committed change.
type JournalRow struct {
	Revision       int64
	ChangeType     string
	NodeID         string
	PayloadJSON    string
	OriginType     string
	OriginUserID   string
	OriginDeviceID string
	CreatedAt      string
}

// Writer is the write-side contract: a canonical transaction factory.
type Writer interface {
	BeginTx(ctx context.Context) (canonical.Tx, error)
}

// Limits.
const (
	// MaxTitleLength is the V1 title bound shared with the sync protocol.
	MaxTitleLength = 255
	// MaxURLLength guards against abuse from web-originated writes.
	MaxURLLength = 2048
	// DefaultActivityLimit caps the activity feed response.
	DefaultActivityLimit = 100
)

// Service implements web-originated tree access.
type Service struct {
	store    Store
	writer   Writer
	executor *canonical.Executor
}

// NewService returns a library service.
func NewService(store Store, writer Writer) *Service {
	return &Service{store: store, writer: writer, executor: canonical.NewExecutor()}
}

// Node and root-slot reads.

// Space loads one space or canonical.ErrSpaceNotFound.
func (s *Service) Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	return s.store.GetSpace(ctx, id)
}

// Nodes returns the space's full node list; the client builds the tree.
func (s *Service) Nodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	if _, err := s.store.GetSpace(ctx, space); err != nil {
		return nil, err
	}
	return s.store.ListNodes(ctx, space)
}

// RootSlots returns the space's root slots.
func (s *Service) RootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error) {
	if _, err := s.store.GetSpace(ctx, space); err != nil {
		return nil, err
	}
	return s.store.ListRootSlots(ctx, space)
}

// CreateParams carries a web-originated node creation.
type CreateParams struct {
	Type     canonical.NodeType
	Title    string
	URL      string
	Parent   canonical.ParentRef
	BeforeID *canonical.NodeID
}

// CreateNode validates and applies a user's node creation.
func (s *Service) CreateNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, p CreateParams) (canonical.Node, error) {
	if p.Title == "" {
		return canonical.Node{}, canonical.ErrTitleRequired
	}
	if len(p.Title) > MaxTitleLength {
		return canonical.Node{}, ErrTitleTooLong
	}
	if len(p.URL) > MaxURLLength {
		return canonical.Node{}, ErrURLTooLong
	}

	id, err := uuid.NewV7()
	if err != nil {
		return canonical.Node{}, err
	}
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}

	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	cmd := canonical.CreateNode{
		SpaceID:  space,
		NodeID:   canonical.NodeID(id.String()),
		Type:     p.Type,
		Title:    p.Title,
		URL:      p.URL,
		Parent:   p.Parent,
		BeforeID: p.BeforeID,
	}
	if err := s.executor.ApplyTx(ctx, tx, origin, cmd); err != nil {
		return canonical.Node{}, err
	}
	created, err := tx.LoadNode(ctx, space, cmd.NodeID)
	if err != nil {
		return canonical.Node{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.Node{}, err
	}
	committed = true
	return created, nil
}

// UpdateParams carries an optional title/url change; nil fields are no-ops.
type UpdateParams struct {
	Title *string
	URL   *string
}

// UpdateNode applies title and/or URL changes to one node.
func (s *Service) UpdateNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID, p UpdateParams) (canonical.Node, error) {
	if p.Title != nil {
		if *p.Title == "" {
			return canonical.Node{}, canonical.ErrTitleRequired
		}
		if len(*p.Title) > MaxTitleLength {
			return canonical.Node{}, ErrTitleTooLong
		}
	}
	if p.URL != nil && len(*p.URL) > MaxURLLength {
		return canonical.Node{}, ErrURLTooLong
	}

	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}

	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	var cmds []canonical.Command
	if p.Title != nil {
		cmds = append(cmds, canonical.UpdateNodeTitle{SpaceID: space, NodeID: node, Title: *p.Title})
	}
	if p.URL != nil {
		cmds = append(cmds, canonical.UpdateNodeURL{SpaceID: space, NodeID: node, URL: *p.URL})
	}
	if len(cmds) > 0 {
		if err := s.executor.ApplyTx(ctx, tx, origin, cmds...); err != nil {
			return canonical.Node{}, err
		}
	}
	updated, err := tx.LoadNode(ctx, space, node)
	if err != nil {
		return canonical.Node{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.Node{}, err
	}
	committed = true
	return updated, nil
}

// MoveParams carries a reparent/reorder request.
type MoveParams struct {
	Parent   canonical.ParentRef
	BeforeID *canonical.NodeID
}

// MoveNode applies a user's move command.
func (s *Service) MoveNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID, p MoveParams) (canonical.Node, error) {
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}

	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	cmd := canonical.MoveNode{SpaceID: space, NodeID: node, Parent: p.Parent, BeforeID: p.BeforeID}
	if err := s.executor.ApplyTx(ctx, tx, origin, cmd); err != nil {
		return canonical.Node{}, err
	}
	moved, err := tx.LoadNode(ctx, space, node)
	if err != nil {
		return canonical.Node{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.Node{}, err
	}
	committed = true
	return moved, nil
}

// DeleteNode removes a node and its subtree.
func (s *Service) DeleteNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID) error {
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	return s.executor.Execute(ctx, s.writer, origin, canonical.DeleteNode{SpaceID: space, NodeID: node})
}

// ActivityEntry is one human-readable item of the space's recent history.
type ActivityEntry struct {
	Revision  int64
	Timestamp string
	Actor     string
	Action    string // create | update | move | delete
	Summary   string
}

// Activity derives a compact recent-history feed from the journal. The V1
// web UI renders server-side summaries in the instance default language.
func (s *Service) Activity(ctx context.Context, space canonical.SpaceID, limit int) ([]ActivityEntry, error) {
	sp, err := s.store.GetSpace(ctx, space)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > DefaultActivityLimit {
		limit = DefaultActivityLimit
	}
	rows, err := s.store.ListJournal(ctx, space, sp.Epoch, limit)
	if err != nil {
		return nil, err
	}

	// Title resolution for change rows: prefer the current node title;
	// fall back to a generic object noun after deletion.
	titles := make(map[canonical.NodeID]string)
	nodes, _ := s.store.ListNodes(ctx, space)
	for _, n := range nodes {
		titles[n.ID] = n.Title
	}

	out := make([]ActivityEntry, 0, len(rows))
	for _, row := range rows {
		actor, err := s.actor(ctx, row)
		if err != nil {
			return nil, err
		}
		entry := ActivityEntry{
			Revision:  row.Revision,
			Timestamp: row.CreatedAt,
			Actor:     actor,
			Action:    mapAction(row.ChangeType),
		}
		title := titles[canonical.NodeID(row.NodeID)]
		if title == "" {
			title = "条目"
		}
		switch row.ChangeType {
		case "create":
			entry.Summary = fmt.Sprintf("新建了「%s」", title)
		case "update_title":
			entry.Summary = fmt.Sprintf("修改了「%s」的标题", title)
		case "update_url":
			entry.Summary = fmt.Sprintf("修改了「%s」的链接", title)
		case "move":
			entry.Summary = fmt.Sprintf("移动了「%s」", title)
		case "delete":
			count := deleteCount(row.PayloadJSON)
			entry.Summary = fmt.Sprintf("删除了 %d 个条目", count)
		default:
			entry.Summary = row.ChangeType
		}
		out = append(out, entry)
	}
	return out, nil
}

func (s *Service) actor(ctx context.Context, row JournalRow) (string, error) {
	switch canonical.OriginType(row.OriginType) {
	case canonical.OriginDevice:
		name, err := s.store.DeviceName(ctx, row.OriginDeviceID)
		if err != nil || name == "" {
			return "浏览器设备", err
		}
		return name, nil
	case canonical.OriginUser:
		name, err := s.store.UserName(ctx, row.OriginUserID)
		if err != nil || name == "" {
			return "网页", err
		}
		return name + " (网页)", nil
	case canonical.OriginImport:
		return "导入", nil
	case canonical.OriginSystem, canonical.OriginRecovery:
		return "系统", nil
	default:
		return "未知", nil
	}
}

func mapAction(changeType string) string {
	switch changeType {
	case "create":
		return "create"
	case "update_title", "update_url":
		return "update"
	case "move":
		return "move"
	case "delete":
		return "delete"
	default:
		return "update"
	}
}

// deleteCount extracts {"count":N} from a delete payload; 1 on doubt.
func deleteCount(payloadJSON string) int64 {
	var p struct {
		Count int64 `json:"count"`
	}
	if err := json.Unmarshal([]byte(payloadJSON), &p); err != nil || p.Count <= 0 {
		return 1
	}
	return p.Count
}

// Service-level errors carrying HTTP semantics.
var (
	ErrTitleTooLong = errors.New("library: title too long")
	ErrURLTooLong   = errors.New("library: url too long")
)

// ListNodes exposes the raw node list for detector-style consumers
// (organizer, backup capture).
func (s *Service) ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	return s.store.ListNodes(ctx, space)
}
