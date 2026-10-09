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
	"strings"
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
	ID      string
	SpaceID string
	Kind    Kind
	// Filename is the human-readable download name built from the space
	// name. It is display data only: it never locates the payload.
	Filename string
	// StorageKey is the opaque file name the payload lives under inside the
	// backup directory (the backup's own UUID). Space names may repeat
	// across owners, so the physical name must not depend on them.
	StorageKey    string
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
	// ErrUnlocated is returned for a row whose payload cannot be resolved:
	// a legacy catalog entry that shared its display filename with another
	// backup, or a storage key that is not a single plain file name. The
	// service refuses to guess which file such a row owns.
	ErrUnlocated = errors.New("backup: payload location is ambiguous")
)

// files isolates the physical backup directory from the catalog: a row can
// only ever reach a file its own storage key names.
type files interface {
	Publish(key string, data []byte) error
	Read(key string) ([]byte, error)
	Remove(key string) error
}

// dirFiles stores payloads as single files under dir.
type dirFiles struct{ dir string }

// resolve maps a storage key to a path inside dir, rejecting anything that
// is not exactly one file name so no key can escape the directory.
func (f dirFiles) resolve(key string) (string, error) {
	if key == "" || !isPlainFileName(key) {
		return "", fmt.Errorf("%w: key %q", ErrUnlocated, key)
	}
	return filepath.Join(f.dir, key), nil
}

func isPlainFileName(key string) bool {
	if strings.ContainsRune(key, filepath.Separator) || strings.ContainsRune(key, '/') ||
		strings.ContainsRune(key, 0) {
		return false
	}
	return key == filepath.Base(key) && key != "." && key != ".."
}

// Publish writes through a temporary file in the same directory and renames
// it into place: an interrupted write leaves no truncated payload, and no
// existing backup file is ever replaced by a partial one.
func (f dirFiles) Publish(key string, data []byte) error {
	path, err := f.resolve(key)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(f.dir, key+".tmp-")
	if err != nil {
		return fmt.Errorf("backup: create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("backup: write temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("backup: close temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("backup: publish: %w", err)
	}
	return nil
}

func (f dirFiles) Read(key string) ([]byte, error) {
	path, err := f.resolve(key)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("backup: read file: %w", err)
	}
	return raw, nil
}

// Remove deletes the payload. A missing file is success: the caller is
// finishing an earlier attempt that already got that far.
func (f dirFiles) Remove(key string) error {
	path, err := f.resolve(key)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("backup: remove file: %w", err)
	}
	return nil
}

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
	files files
}

// NewService returns a backup service storing payloads under dir.
func NewService(store Store, trees TreeSource, dir string) (*Service, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("backup: create dir: %w", err)
	}
	return &Service{store: store, trees: trees, files: dirFiles{dir: dir}}, nil
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
		Filename:      humanFilename(sp.Name, stamp, kind),
		StorageKey:    id.String() + ".json",
		NodeCount:     int64(len(nodes)),
		BookmarkCount: bookmarks,
		CreatedAt:     now,
	}

	raw, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return Backup{}, err
	}
	b.SizeBytes = int64(len(raw))
	// The payload is published under this backup's own UUID, so a second
	// space with the same name (or a second click in the same second)
	// creates a new file instead of overwriting the first one.
	if err := s.files.Publish(b.StorageKey, raw); err != nil {
		return Backup{}, err
	}
	if err := s.store.Insert(ctx, b); err != nil {
		_ = s.files.Remove(b.StorageKey)
		return Backup{}, err
	}
	return b, nil
}

// filenamePunct characters never appear in a backup's display name.
var filenamePunct = strings.NewReplacer(
	"/", "_", `\`, "_", ":", "_", "*", "_", "?", "_", `"`, "_",
	"<", "_", ">", "_", "|", "_", "\n", "_", "\r", "_", "\t", "_",
)

// humanFilename builds the download name for a backup. The space name is
// user-controlled, so path-bearing characters are flattened and the result is
// bounded; the payload itself is addressed by StorageKey, not by this name.
func humanFilename(spaceName, stamp string, kind Kind) string {
	name := strings.TrimSpace(filenamePunct.Replace(spaceName))
	name = strings.Trim(name, ".")
	if r := []rune(name); len(r) > 60 {
		name = string(r[:60])
	}
	if name == "" {
		name = "space"
	}
	return fmt.Sprintf("%s-%s-%s.json", name, stamp, kind)
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
	// File first, catalog second: when the filesystem refuses (permission,
	// EBUSY), the row survives and the delete stays retryable instead of
	// leaving an orphaned payload behind an unreferenced catalog entry.
	if b.StorageKey != "" {
		if err := s.files.Remove(b.StorageKey); err != nil {
			return err
		}
	}
	return s.store.Delete(ctx, id)
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
	if b.StorageKey == "" {
		// Legacy row whose display name was shared: which physical file is
		// its payload cannot be decided, so restoring would apply another
		// backup's tree.
		return 0, "", fmt.Errorf("%w: backup %s", ErrUnlocated, b.ID)
	}

	raw, err := s.files.Read(b.StorageKey)
	if err != nil {
		return 0, "", err
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

// spaceLister is implemented by the tree source for whole-instance sweeps.
type spaceLister interface {
	ListSpaceIDs(ctx context.Context) ([]string, error)
}

// PurgeExpiredSafety deletes unprotected safety backups older than the
// retention window (default 30 days, doc 14 §8).
func (s *Service) PurgeExpiredSafety(ctx context.Context, window time.Duration) (int, error) {
	list, ok := s.trees.(spaceLister)
	if !ok {
		return 0, nil
	}
	spaceIDs, err := list.ListSpaceIDs(ctx)
	if err != nil {
		return 0, err
	}
	cutoff := time.Now().UTC().Add(-window)
	removed := 0
	for _, sid := range spaceIDs {
		backups, err := s.store.List(ctx, sid)
		if err != nil {
			return removed, err
		}
		for _, b := range backups {
			if b.Kind == KindSafety && !b.Protected && b.CreatedAt.Before(cutoff) {
				if err := s.Delete(ctx, b.ID); err != nil {
					return removed, err
				}
				removed++
			}
		}
	}
	return removed, nil
}

// ApplyScheduledRetention keeps the newest `keep` scheduled backups per
// space; protected backups are never auto-deleted (doc 14 §9).
func (s *Service) ApplyScheduledRetention(ctx context.Context, keep int) (int, error) {
	list, ok := s.trees.(spaceLister)
	if !ok {
		return 0, nil
	}
	spaceIDs, err := list.ListSpaceIDs(ctx)
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, sid := range spaceIDs {
		backups, err := s.store.List(ctx, sid)
		if err != nil {
			return removed, err
		}
		// List is newest-first already.
		seen := 0
		for _, b := range backups {
			if b.Kind != KindScheduled {
				continue
			}
			seen++
			if seen > keep && !b.Protected {
				if err := s.Delete(ctx, b.ID); err != nil {
					return removed, err
				}
				removed++
			}
		}
	}
	return removed, nil
}
