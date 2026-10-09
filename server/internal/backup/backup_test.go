package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pontis/internal/canonical"
)

// --- test doubles -------------------------------------------------------

type fakeTrees struct {
	spaces map[canonical.SpaceID]canonical.SyncSpace
	nodes  map[canonical.SpaceID][]canonical.Node
	slots  map[canonical.SpaceID][]canonical.RootSlot
}

func newFakeTrees() *fakeTrees {
	return &fakeTrees{
		spaces: map[canonical.SpaceID]canonical.SyncSpace{},
		nodes:  map[canonical.SpaceID][]canonical.Node{},
		slots:  map[canonical.SpaceID][]canonical.RootSlot{},
	}
}

func (f *fakeTrees) add(spaceID canonical.SpaceID, name, title string) {
	f.spaces[spaceID] = canonical.SyncSpace{
		ID: spaceID, Name: name, Epoch: 1,
		CreatedAt: time.Unix(0, 0).UTC(), UpdatedAt: time.Unix(0, 0).UTC(),
	}
	f.slots[spaceID] = []canonical.RootSlot{{
		SpaceID: spaceID, Key: "main", DisplayName: "Main", Position: 0,
		CreatedAt: time.Unix(0, 0).UTC(),
	}}
	f.nodes[spaceID] = []canonical.Node{{
		SpaceID: spaceID, ID: canonical.NodeID("node-" + string(spaceID)),
		Type: canonical.NodeTypeBookmark, Title: title, URL: "https://example.com",
		Parent: canonical.NewRootParent("main"), Position: 0,
		CreatedAt: time.Unix(0, 0).UTC(), UpdatedAt: time.Unix(0, 0).UTC(),
	}}
}

func (f *fakeTrees) Space(_ context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	sp, ok := f.spaces[id]
	if !ok {
		return canonical.SyncSpace{}, canonical.ErrSpaceNotFound
	}
	return sp, nil
}

func (f *fakeTrees) ListNodes(_ context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	return f.nodes[space], nil
}

func (f *fakeTrees) ListRootSlots(_ context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error) {
	return f.slots[space], nil
}

type fakeStore struct {
	rows          map[string]Backup
	insertErr     error
	replaceErr    error
	replacedSlots []SlotDTO
	replacedWith  []NodeDTO
	epoch         int64
}

func newFakeStore() *fakeStore {
	return &fakeStore{rows: map[string]Backup{}, epoch: 1}
}

func (f *fakeStore) Insert(_ context.Context, b Backup) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	f.rows[b.ID] = b
	return nil
}

func (f *fakeStore) List(_ context.Context, spaceID string) ([]Backup, error) {
	var out []Backup
	for _, b := range f.rows {
		if b.SpaceID == spaceID {
			out = append(out, b)
		}
	}
	return out, nil
}

func (f *fakeStore) Get(_ context.Context, id string) (Backup, error) {
	b, ok := f.rows[id]
	if !ok {
		return Backup{}, ErrNotFound
	}
	return b, nil
}

func (f *fakeStore) Delete(_ context.Context, id string) error {
	if _, ok := f.rows[id]; !ok {
		return ErrNotFound
	}
	delete(f.rows, id)
	return nil
}

func (f *fakeStore) SetProtected(_ context.Context, id string, protected bool) error {
	b, ok := f.rows[id]
	if !ok {
		return ErrNotFound
	}
	b.Protected = protected
	f.rows[id] = b
	return nil
}

func (f *fakeStore) ReplaceBaseline(_ context.Context, _ string, slots []SlotDTO, nodes []NodeDTO) (int64, error) {
	if f.replaceErr != nil {
		return 0, f.replaceErr
	}
	f.replacedSlots = slots
	f.replacedWith = nodes
	f.epoch++
	return f.epoch, nil
}

// failingFiles wraps the real directory store so a single operation can fail.
type failingFiles struct {
	inner     dirFiles
	removeErr error
	readCalls *[]string
}

func (f failingFiles) Publish(key string, data []byte) error { return f.inner.Publish(key, data) }

func (f failingFiles) Read(key string) ([]byte, error) {
	if f.readCalls != nil {
		*f.readCalls = append(*f.readCalls, key)
	}
	return f.inner.Read(key)
}

func (f failingFiles) Remove(key string) error {
	if f.removeErr != nil {
		return f.removeErr
	}
	return f.inner.Remove(key)
}

func newService(t *testing.T, store Store, trees TreeSource) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	svc, err := NewService(store, trees, dir)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return svc, dir
}

// --- tests --------------------------------------------------------------

// Two users both keeping a "Personal" space is the normal case, and a double
// click lands in the same second: the display name cannot be the storage key.
func TestSameNameSpacesDoNotOverwriteEachOther(t *testing.T) {
	trees := newFakeTrees()
	trees.add("space-a", "Personal", "From A")
	trees.add("space-b", "Personal", "From B")
	store := newFakeStore()
	svc, dir := newService(t, store, trees)

	a, err := svc.Create(context.Background(), "space-a", KindManual)
	if err != nil {
		t.Fatalf("create a: %v", err)
	}
	b, err := svc.Create(context.Background(), "space-b", KindManual)
	if err != nil {
		t.Fatalf("create b: %v", err)
	}
	if a.StorageKey == "" || b.StorageKey == "" {
		t.Fatalf("storage keys missing: %+v %+v", a, b)
	}
	if a.StorageKey == b.StorageKey {
		t.Fatalf("same storage key for two backups: %s", a.StorageKey)
	}

	for _, tc := range []struct {
		b     Backup
		title string
	}{{a, "From A"}, {b, "From B"}} {
		raw, err := os.ReadFile(filepath.Join(dir, tc.b.StorageKey))
		if err != nil {
			t.Fatalf("payload %s: %v", tc.b.StorageKey, err)
		}
		var payload Payload
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		if len(payload.Nodes) != 1 || payload.Nodes[0].Title != tc.title {
			t.Fatalf("payload of %s holds %+v, want %q", tc.b.ID, payload.Nodes, tc.title)
		}
	}

	// A second manual backup of the same space in the same second is a
	// separate payload too.
	c, err := svc.Create(context.Background(), "space-a", KindManual)
	if err != nil {
		t.Fatalf("create c: %v", err)
	}
	if c.StorageKey == a.StorageKey {
		t.Fatalf("repeat backup reused the storage key")
	}
	if _, err := os.Stat(filepath.Join(dir, a.StorageKey)); err != nil {
		t.Fatalf("first payload disappeared: %v", err)
	}
}

// Space names are user data. Once they only feed a display name the worst a
// traversal attempt can do is produce an odd label, never a path outside the
// backup directory.
func TestTraversalStyleSpaceNameStaysInsideDir(t *testing.T) {
	const spaceID = canonical.SpaceID("space-evil")
	trees := newFakeTrees()
	trees.add(spaceID, "../../escaped", "Payload")
	store := newFakeStore()
	svc, dir := newService(t, store, trees)

	b, err := svc.Create(context.Background(), spaceID, KindManual)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if strings.ContainsAny(b.Filename, `/\`) {
		t.Fatalf("display filename still carries separators: %q", b.Filename)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != b.StorageKey {
		t.Fatalf("backup dir contents = %v, want only %s", names(entries), b.StorageKey)
	}
	if _, err := os.Stat(filepath.Join(dir, b.StorageKey)); err != nil {
		t.Fatalf("payload not published: %v", err)
	}
}

func names(entries []os.DirEntry) []string {
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

// When the catalog rejects the row, cleanup may only remove the payload this
// call just wrote. The old code deleted by display name, which took out the
// previous backup whenever the names collided.
func TestCatalogInsertFailureKeepsEarlierPayload(t *testing.T) {
	trees := newFakeTrees()
	trees.add("space-1", "Personal", "First")
	store := newFakeStore()
	svc, dir := newService(t, store, trees)

	first, err := svc.Create(context.Background(), "space-1", KindManual)
	if err != nil {
		t.Fatalf("create first: %v", err)
	}
	firstRaw, err := os.ReadFile(filepath.Join(dir, first.StorageKey))
	if err != nil {
		t.Fatalf("read first: %v", err)
	}

	store.insertErr = errors.New("catalog down")
	if _, err := svc.Create(context.Background(), "space-1", KindManual); err == nil {
		t.Fatalf("create succeeded despite a failing catalog")
	}
	if _, err := os.Stat(filepath.Join(dir, first.StorageKey)); err != nil {
		t.Fatalf("failed create deleted the earlier backup: %v", err)
	}
	after, err := os.ReadFile(filepath.Join(dir, first.StorageKey))
	if err != nil || string(after) != string(firstRaw) {
		t.Fatalf("earlier payload changed: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

// A failed file removal must keep the catalog row so the delete can be
// retried; removing the row first would orphan the payload forever.
func TestDeleteFailureKeepsRetryableRow(t *testing.T) {
	trees := newFakeTrees()
	trees.add("space-1", "Personal", "Payload")
	store := newFakeStore()
	svc, dir := newService(t, store, trees)

	b, err := svc.Create(context.Background(), "space-1", KindManual)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	removeErr := errors.New("device busy")
	svc.files = failingFiles{inner: dirFiles{dir: dir}, removeErr: removeErr}

	if err := svc.Delete(context.Background(), b.ID); !errors.Is(err, removeErr) {
		t.Fatalf("delete err = %v, want %v", err, removeErr)
	}
	if _, ok := store.rows[b.ID]; !ok {
		t.Fatalf("catalog row dropped while the file survived")
	}

	svc.files = dirFiles{dir: dir}
	if err := svc.Delete(context.Background(), b.ID); err != nil {
		t.Fatalf("retry delete: %v", err)
	}
	if _, ok := store.rows[b.ID]; ok {
		t.Fatalf("row still present after a successful delete")
	}
	if _, err := os.Stat(filepath.Join(dir, b.StorageKey)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("payload still on disk (stat err = %v)", err)
	}
}

// Legacy catalog rows keyed only by a display name may have shared one file.
// Such a row must never be resolved by guessing.
func TestRowWithoutStorageKeyIsNeverGuessed(t *testing.T) {
	trees := newFakeTrees()
	trees.add("space-1", "Personal", "Payload")
	store := newFakeStore()
	svc, dir := newService(t, store, trees)

	// A payload two rows claim.
	shared := "Personal-20240101-101010-manual.json"
	if err := os.WriteFile(filepath.Join(dir, shared), []byte(`{"format":"pontis-backup"}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ambiguous := Backup{
		ID: "legacy-1", SpaceID: "space-1", Kind: KindManual,
		Filename: shared, StorageKey: "", CreatedAt: time.Now().UTC(),
	}
	if err := store.Insert(context.Background(), ambiguous); err != nil {
		t.Fatalf("seed row: %v", err)
	}

	if _, _, err := svc.Restore(context.Background(), "space-1", ambiguous.ID); !errors.Is(err, ErrUnlocated) {
		t.Fatalf("restore err = %v, want ErrUnlocated", err)
	}
	if store.replacedWith != nil {
		t.Fatalf("restore replaced the baseline from an ambiguous row")
	}

	if err := svc.Delete(context.Background(), ambiguous.ID); err != nil {
		t.Fatalf("delete of an unresolvable row: %v", err)
	}
	if _, ok := store.rows[ambiguous.ID]; ok {
		t.Fatalf("row survived the delete")
	}
	if _, err := os.Stat(filepath.Join(dir, shared)); err != nil {
		t.Fatalf("delete removed a file the row cannot prove it owns: %v", err)
	}
}

// The storage key is read straight out of the catalog, so it must not be able
// to name anything outside the backup directory.
func TestStorageKeyOutsideDirIsRejected(t *testing.T) {
	trees := newFakeTrees()
	trees.add("space-1", "Personal", "Payload")
	store := newFakeStore()

	root := t.TempDir()
	dir := filepath.Join(root, "backups")
	svc, err := NewService(store, trees, dir)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	outside := filepath.Join(root, "secret.json")
	if err := os.WriteFile(outside, []byte("do not read me"), 0o644); err != nil {
		t.Fatalf("seed outside file: %v", err)
	}

	// Even a name that merely looks relative is refused before touching disk.
	for _, key := range []string{"../secret.json", "/etc/passwd", "sub/dir.json", ".", ""} {
		if _, err := (dirFiles{dir: dir}).Read(key); !errors.Is(err, ErrUnlocated) {
			t.Fatalf("read %q err = %v, want ErrUnlocated", key, err)
		}
		if err := (dirFiles{dir: dir}).Publish(key, []byte("x")); !errors.Is(err, ErrUnlocated) {
			t.Fatalf("publish %q err = %v, want ErrUnlocated", key, err)
		}
		if err := (dirFiles{dir: dir}).Remove(key); !errors.Is(err, ErrUnlocated) {
			t.Fatalf("remove %q err = %v, want ErrUnlocated", key, err)
		}
	}

	if err := store.Insert(context.Background(), Backup{
		ID: "hostile", SpaceID: "space-1", Kind: KindManual,
		Filename: "x.json", StorageKey: "../secret.json", CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	if _, _, err := svc.Restore(context.Background(), "space-1", "hostile"); !errors.Is(err, ErrUnlocated) {
		t.Fatalf("restore err = %v, want ErrUnlocated", err)
	}
	if err := svc.Delete(context.Background(), "hostile"); !errors.Is(err, ErrUnlocated) {
		t.Fatalf("delete err = %v, want ErrUnlocated", err)
	}
	if _, ok := store.rows["hostile"]; !ok {
		t.Fatalf("row was dropped although its file could not be verified")
	}
	raw, err := os.ReadFile(outside)
	if err != nil || string(raw) != "do not read me" {
		t.Fatalf("file outside the backup dir was disturbed: %v", err)
	}
}

// A restore of a well-keyed backup still round-trips through the new field.
func TestRestoreReadsPayloadByStorageKey(t *testing.T) {
	trees := newFakeTrees()
	trees.add("space-1", "Personal", "Payload")
	store := newFakeStore()
	svc, _ := newService(t, store, trees)

	b, err := svc.Create(context.Background(), "space-1", KindSafety)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, _, err := svc.Restore(context.Background(), "space-1", b.ID); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if len(store.replacedWith) != 1 || store.replacedWith[0].Title != "Payload" {
		t.Fatalf("baseline replacement got %+v", store.replacedWith)
	}
}

func TestHumanFilename(t *testing.T) {
	got := humanFilename(`a/b\c:d*e?f"g<h>i|j`, "20240101-101010", KindManual)
	if strings.ContainsAny(got, `/\:*?"<>|`) {
		t.Fatalf("filename kept unsafe characters: %q", got)
	}
	if humanFilename("", "20240101-101010", KindManual) == "" {
		t.Fatalf("empty display name")
	}
	long := humanFilename(strings.Repeat("标", 200), "20240101-101010", KindScheduled)
	if r := []rune(long); len(r) > 96 {
		t.Fatalf("filename unbounded: %d runes", len(r))
	}
	if !strings.HasSuffix(long, "-scheduled.json") {
		t.Fatalf("filename lost its suffix: %q", long)
	}
}
