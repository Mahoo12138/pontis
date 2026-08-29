// Package backup implements logical space backups: capture, restore,
// protection and deletion (doc 14). A backup is one space's canonical
// tree (root slots + nodes with stable UUIDs) serialized to the data
// directory; the catalog row is authoritative for listing.
package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Kind classifies a backup's origin.
type Kind string

const (
	KindManual    Kind = "manual"
	KindScheduled Kind = "scheduled"
	KindSafety    Kind = "safety"
)

// Backup is one catalog entry.
type Backup struct {
	ID            string
	SpaceID       string
	Kind          Kind
	Filename      string
	SizeBytes     int64
	NodeCount     int64
	BookmarkCount int64
	Protected     bool
	CreatedAt     time.Time
}

// Errors.
var (
	ErrNotFound       = errors.New("backup: not found")
	ErrProtected      = errors.New("backup: protected backup must be unprotected first")
	ErrSpaceMismatch  = errors.New("backup: backup belongs to another space")
	ErrInvalidPayload = errors.New("backup: invalid backup payload")
)

// Payload is the on-disk logical backup format.
type Payload struct {
	Format    string             `json:"format"`
	Version   int                `json:"version"`
	SpaceID   string             `json:"space_id"`
	RootSlots []SlotDTO          `json:"root_slots"`
	Nodes     []NodeDTO          `json:"nodes"`
}

// SlotDTO is one root slot snapshot.
type SlotDTO struct {
	Key         string `json:"key"`
	DisplayName string `json:"display_name"`
	Position    int64  `json:"position"`
	CreatedAt   string `json:"created_at"`
}

// NodeDTO is one node snapshot with stable canonical identity.
type NodeDTO struct {
	ID        string  `json:"id"`
	Type      string  `json:"type"`
	Title     string  `json:"title"`
	URL       *string `json:"url"`
	ParentID  *string `json:"parent_id"`
	RootKey   *string `json:"root_key"`
	Position  int64   `json:"position"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

// TreeSource reads the canonical tree for capture.
type TreeSource interface {
	Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)
	ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error)
}

// Store is the catalog persistence contract.
type Store interface {
	Insert(ctx context.Context, b Backup) error
	List(ctx context.Context, spaceID string) ([]Backup, error)
	Get(ctx context.Context, id string) (Backup, error)
	Delete(ctx context.Context, id string) error
	SetProtected(ctx context.Context, id string, protected bool) error
	// ReplaceBaseline swaps the space's tree atomically: it wipes nodes
	// and journal history, rewrites root slots, inserts the snapshot with
	// the ORIGINAL node ids at baseline revision 1, bumps the epoch and
	// resets every binding to pending_initial for resync.
	ReplaceBaseline(ctx context.Context, spaceID string, newEpoch int64, slots []SlotDTO, nodes []NodeDTO) error
}

// Service implements backup operations.
type Service struct {
	store Store
	trees TreeSource
	dir   string
}

// NewService returns a backup service storing payloads under dir.
func NewService(store Store, trees TreeSource, dir string) (*Service, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("backup: create dir: %w", err)
	}
	return &Service{store: store, trees: trees, dir: dir}, nil
}

// Create captures the space's current tree.
func (s *Service) Create(ctx context.Context, spaceID canonical.SpaceID, kind Kind) (Backup, error) {
	sp, err := s.trees.Space(ctx, spaceID)
	if err != nil {
		return Backup{}, err
	}
	nodes, err := s.trees.ListNodes(ctx, spaceID)
	if err != nil {
		return Backup{}, err
	}
	slots, err := s.trees.ListRootSlots(ctx, spaceID)
	if err != nil {
		return Backup{}, err
	}

	payload := Payload{Format: "pontis-backup", Version: 1, SpaceID: string(spaceID)}
	bookmarks := int64(0)
	for _, slot := range slots {
		payload.RootSlots = append(payload.RootSlots, SlotDTO{
			Key: slot.Key, DisplayName: slot.DisplayName, Position: slot.Position,
			CreatedAt: slot.CreatedAt.Format(time.RFC3339Nano),
		})
	}
	for _, n := range nodes {
		dto := NodeDTO{
			ID:        string(n.ID),
			Type:      string(n.Type),
			Title:     n.Title,
			Position:  n.Position,
			CreatedAt: n.CreatedAt.Format(time.RFC3339Nano),
			UpdatedAt: n.UpdatedAt.Format(time.RFC3339Nano),
		}
		if n.URL != "" {
			u := n.URL
			dto.URL = &u
		}
		if n.Parent.Type == canonical.ParentTypeNode {
			p := string(n.Parent.NodeID)
			dto.ParentID = &p
		} else {
			k := n.Parent.RootKey
			dto.RootKey = &k
		}
		payload.Nodes = append(payload.Nodes, dto)
		if n.Type == canonical.NodeTypeBookmark {
			bookmarks++
		}
	}

	id, err := uuid.NewV7()
	if err != nil {
		return Backup{}, err
	}
	now := time.Now().UTC()
	stamp := now.Format("20060102-150405")
	b := Backup{
		ID:            id.String(),
		SpaceID:       string(spaceID),
		Kind:          kind,
		Filename:      fmt.Sprintf("%s-%s-%s.json", sp.Name, stamp, kind),
		NodeCount:     int64(len(nodes)),
		BookmarkCount: bookmarks,
		CreatedAt:     now,
	}

	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return Backup{}, err
	}
	b.SizeBytes = int64(len(raw))
	if err := os.WriteFile(filepath.Join(s.dir, b.Filename), raw, 0o644); err != nil {
		return Backup{}, fmt.Errorf("backup: write file: %w", err)
	}
	if err := s.store.Insert(ctx, b); err != nil {
		_ = os.Remove(filepath.Join(s.dir, b.Filename))
		return Backup{}, err
	}
	return b, nil
}

// List returns the space's backups, newest first.
func (s *Service) List(ctx context.Context, spaceID canonical.SpaceID) ([]Backup, error) {
	list, err := s.store.List(ctx, string(spaceID))
	if err != nil {
		return nil, err
	}
	sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
	return list, nil
}

// Delete removes a catalog row and its file.
func (s *Service) Delete(ctx context.Context, id string) error {
	b, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if err := s.store.Delete(ctx, id); err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(s.dir, b.Filename))
	return nil
}

// SetProtected toggles the retention exemption.
func (s *Service) SetProtected(ctx context.Context, id string, protected bool) error {
	return s.store.SetProtected(ctx, id, protected)
}

// Restore replaces the space's tree with the backup content. A pre-restore
// safety backup is created first (doc 14 §12); the epoch is bumped and all
// bindings fall back to pending_initial so devices resync.
func (s *Service) Restore(ctx context.Context, spaceID canonical.SpaceID, id string) (newEpoch int64, safetyID string, err error) {
	b, err := s.store.Get(ctx, id)
	if err != nil {
		return 0, "", err
	}
	if b.SpaceID != string(spaceID) {
		return 0, "", ErrSpaceMismatch
	}

	raw, err := os.ReadFile(filepath.Join(s.dir, b.Filename))
	if err != nil {
		return 0, "", fmt.Errorf("backup: read file: %w", err)
	}
	var payload Payload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return 0, "", ErrInvalidPayload
	}
	if payload.SpaceID != string(spaceID) || payload.Format != "pontis-backup" {
		return 0, "", ErrInvalidPayload
	}

	// Step 1: capture the current state as a safety backup.
	safety, err := s.Create(ctx, spaceID, KindSafety)
	if err != nil {
		return 0, "", err
	}

	sp, err := s.trees.Space(ctx, spaceID)
	if err != nil {
		return 0, "", err
	}
	newEpoch = sp.Epoch + 1

	// Step 2: atomic baseline replacement.
	if err := s.store.ReplaceBaseline(ctx, string(spaceID), newEpoch, payload.RootSlots, payload.Nodes); err != nil {
		return 0, "", err
	}
	return newEpoch, safety.ID, nil
}

// Get loads one catalog entry.
func (s *Service) Get(ctx context.Context, id string) (Backup, error) {
	return s.store.Get(ctx, id)
}
