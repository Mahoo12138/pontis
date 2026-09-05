package sync

import (
	"context"
	"errors"
	"testing"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/device"
)

// fakeSyncStore implements the sync Store contract. The /sync validation
// paths under test all fail before BeginTx, so the transactional methods
// only guard against unexpected use.
type fakeSyncStore struct {
	binding device.Binding
	bindErr error
	space   canonical.SyncSpace
	spaceErr error
}

func (f *fakeSyncStore) BeginTx(context.Context) (Tx, error) {
	return nil, errors.New("fakeSyncStore: BeginTx must not be reached in validation tests")
}

func (f *fakeSyncStore) LoadBinding(context.Context, canonical.DeviceID, canonical.SpaceID) (device.Binding, error) {
	return f.binding, f.bindErr
}

func (f *fakeSyncStore) LoadSpace(context.Context, canonical.SpaceID) (canonical.SyncSpace, error) {
	return f.space, f.spaceErr
}

func (f *fakeSyncStore) LoadJournalChanges(context.Context, canonical.SpaceID, int64, int64, int) ([]JournalChange, error) {
	return nil, errors.New("fakeSyncStore: LoadJournalChanges must not be reached")
}

func (f *fakeSyncStore) LoadSnapshotNodes(context.Context, canonical.SpaceID) ([]canonical.Node, error) {
	return nil, errors.New("fakeSyncStore: LoadSnapshotNodes must not be reached")
}

func (f *fakeSyncStore) UpdateBindingSync(context.Context, string, int64, int64, int64, time.Time) error {
	return errors.New("fakeSyncStore: UpdateBindingSync must not be reached")
}

func baseSpace() canonical.SyncSpace {
	return canonical.SyncSpace{
		ID: "space-1", OwnerUserID: "u1", Name: "Main",
		Epoch: 3, CurrentRevision: 100, JournalFloorRevision: 10,
	}
}

func baseBinding() device.Binding {
	return device.Binding{
		ID: "bind-1", DeviceID: "dev-1", SpaceID: "space-1",
		State: device.StateActive, Epoch: 3,
	}
}

func baseRequest() SyncRequest {
	return SyncRequest{
		ProtocolVersion:  ProtocolVersion,
		DeviceID:         "dev-1",
		SpaceID:          "space-1",
		Epoch:            3,
		AppliedRevision:  10,
		ReceivedRevision: 20,
	}
}

// wantCode runs Sync and asserts the round aborts with the given
// protocol error code.
func wantCode(t *testing.T, s *Service, req SyncRequest, want string) {
	t.Helper()
	_, err := s.Sync(context.Background(), req)
	if err == nil {
		t.Fatalf("Sync succeeded, want protocol error %s", want)
	}
	var pe *ProtocolError
	if !errors.As(err, &pe) {
		t.Fatalf("Sync err = %T (%v), want *ProtocolError", err, err)
	}
	if pe.Code != want {
		t.Errorf("Sync code = %s, want %s", pe.Code, want)
	}
}

func TestSyncRejectsUnsupportedProtocolVersion(t *testing.T) {
	s := NewService(&fakeSyncStore{binding: baseBinding(), space: baseSpace()}, nil)
	req := baseRequest()
	req.ProtocolVersion = ProtocolVersion + 1
	wantCode(t, s, req, CodeSyncProtocolUnsupported)
}

func TestSyncRejectsInvalidWatermarks(t *testing.T) {
	s := NewService(&fakeSyncStore{binding: baseBinding(), space: baseSpace()}, nil)

	negative := baseRequest()
	negative.AppliedRevision = -1
	wantCode(t, s, negative, CodeInvalidWatermark)

	inverted := baseRequest()
	inverted.AppliedRevision = 30
	inverted.ReceivedRevision = 20
	wantCode(t, s, inverted, CodeInvalidWatermark)

	ahead := baseRequest()
	ahead.ReceivedRevision = 101 // space.CurrentRevision + 1
	wantCode(t, s, ahead, CodeInvalidWatermark)
}

func TestSyncRejectsInactiveBinding(t *testing.T) {
	suspended := baseBinding()
	suspended.State = device.StateSuspended
	s := NewService(&fakeSyncStore{binding: suspended, space: baseSpace()}, nil)
	wantCode(t, s, baseRequest(), CodeBindingNotActive)

	s = NewService(&fakeSyncStore{binding: baseBinding(), bindErr: errors.New("db down"), space: baseSpace()}, nil)
	wantCode(t, s, baseRequest(), CodeBindingNotActive)
}

func TestSyncRejectsMissingSpace(t *testing.T) {
	s := NewService(&fakeSyncStore{binding: baseBinding(), spaceErr: canonical.ErrSpaceNotFound}, nil)
	wantCode(t, s, baseRequest(), CodeBindingNotActive)
}

func TestSyncRejectsEpochMismatch(t *testing.T) {
	// Request epoch disagrees with the space.
	space := baseSpace()
	space.Epoch = 4
	s := NewService(&fakeSyncStore{binding: baseBinding(), space: space}, nil)
	wantCode(t, s, baseRequest(), CodeEpochMismatch)

	// Binding epoch disagrees with the space (device missed a resync).
	binding := baseBinding()
	binding.Epoch = 2
	s = NewService(&fakeSyncStore{binding: binding, space: baseSpace()}, nil)
	wantCode(t, s, baseRequest(), CodeEpochMismatch)
}

func TestSyncRejectsExpiredHistory(t *testing.T) {
	s := NewService(&fakeSyncStore{binding: baseBinding(), space: baseSpace()}, nil)
	req := baseRequest()
	req.AppliedRevision = 5
	req.ReceivedRevision = 9 // below JournalFloorRevision = 10, but >= applied
	wantCode(t, s, req, CodeHistoryExpired)
}

func TestSyncBoundaryWatermarksAcceptedByValidation(t *testing.T) {
	// received == applied and received == current revision and
	// received == journal floor are all legal; the round proceeds past
	// validation (the fake store then fails on LoadJournalChanges,
	// proving the request reached the change-stream stage).
	store := &fakeSyncStore{binding: baseBinding(), space: baseSpace()}
	s := NewService(store, nil)
	req := baseRequest()
	req.AppliedRevision = 10
	req.ReceivedRevision = 100 // == CurrentRevision, >= JournalFloor
	_, err := s.Sync(context.Background(), req)
	if err == nil || err.Error() != "fakeSyncStore: LoadJournalChanges must not be reached" {
		t.Fatalf("Sync err = %v, want the LoadJournalChanges guard of the fake store", err)
	}
}

func TestProtocolErrorFormat(t *testing.T) {
	err := protocolErr(CodeEpochMismatch, "canonical epoch changed")
	if err.Error() != "EPOCH_MISMATCH: canonical epoch changed" {
		t.Errorf("ProtocolError.Error() = %q", err.Error())
	}
}
