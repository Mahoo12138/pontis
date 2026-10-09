package sync

import (
	"context"
	"errors"
	"sort"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
	"pontis/internal/device"
)

// Store is the persistence contract required by the sync engine,
// defined on the consumer side.
type Store interface {
	// BeginTx starts a sync round transaction: canonical tree operations,
	// journal, tombstone reads and receipt writes share one atomic unit.
	BeginTx(ctx context.Context) (Tx, error)

	// BeginReadTx starts one consistent read snapshot. Everything a response
	// labels with a revision — the space head, the change page, the whole
	// tree of a snapshot — is read inside it, because separate statements on
	// the same connection can still straddle another request's commit and
	// then describe a world that never existed (doc 04 §15, doc 06 §8).
	BeginReadTx(ctx context.Context) (ReadTx, error)

	LoadBinding(ctx context.Context, deviceID canonical.DeviceID, space canonical.SpaceID) (device.Binding, error)
	LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)

	// UpdateBindingSync persists the watermarks the client reported for the
	// given epoch. A binding that has been deactivated or whose epoch moved
	// on in the meantime keeps its old watermarks: they describe a dead
	// world.
	UpdateBindingSync(ctx context.Context, bindingID string, epoch, appliedRevision, receivedRevision int64, lastSyncAt time.Time) error
}

// ReadTx is one consistent read snapshot of the server state.
type ReadTx interface {
	LoadBinding(ctx context.Context, deviceID canonical.DeviceID, space canonical.SpaceID) (device.Binding, error)
	LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	// LoadJournalChanges returns journal rows of one epoch ordered by
	// revision, starting at fromRevision (inclusive), at most limit rows.
	LoadJournalChanges(ctx context.Context, space canonical.SpaceID, epoch, fromRevision int64, limit int) ([]JournalChange, error)
	// LoadSnapshotNodes returns every canonical node of the space for a
	// snapshot rebuild, ordered deterministically (root key, position, id).
	LoadSnapshotNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)

	Rollback(ctx context.Context) error
}

// Tx is a sync round transaction. It extends the canonical transaction
// with the sync-specific reads and writes.
type Tx interface {
	canonical.Tx

	LoadBinding(ctx context.Context, deviceID canonical.DeviceID, space canonical.SpaceID) (device.Binding, error)
	LoadTombstone(ctx context.Context, space canonical.SpaceID, node canonical.NodeID) (Tombstone, bool, error)
	LoadReceipt(ctx context.Context, bindingID, opID string) (Receipt, bool, error)
	InsertReceipt(ctx context.Context, r Receipt) error
	// AdvanceClientSeq raises the binding's sequence watermark as part of
	// the same transaction that records the receipt, so a receipt can never
	// exist without the sequence it consumed being spent.
	AdvanceClientSeq(ctx context.Context, bindingID string, clientSeq int64) error

	// LoadJournalOrigin returns the origin binding and client seq of the
	// journal entry at (epoch, revision); used for same-binding
	// causality decisions.
	LoadJournalOrigin(ctx context.Context, space canonical.SpaceID, epoch, revision int64) (bindingID string, clientSeq *int64, found bool, err error)
}

// Service implements the /sync protocol core.
type Service struct {
	store      Store
	changesets *changeset.Service
}

// NewService returns a sync service backed by store. Every applied device
// operation is recorded as an undoable ChangeSet (doc 15).
func NewService(store Store, changesets *changeset.Service) *Service {
	return &Service{store: store, changesets: changesets}
}

// Sync executes one /sync round: validate binding continuity, process
// operations in client_seq order with idempotent receipts, then return a
// page of the canonical change stream starting after the client's
// received revision.
//
// The reads that decide whether a request may be served at all happen again
// inside each operation's transaction. What is checked outside a transaction
// is only an early exit: a Restore, a journal GC or another device's write can
// commit between the check and the write, and a decision made against the
// numbers read before it would let an operation of a dead epoch into the live
// journal.
func (s *Service) Sync(ctx context.Context, req SyncRequest) (SyncResponse, error) {
	if req.ProtocolVersion != ProtocolVersion {
		return SyncResponse{}, protocolErr(CodeSyncProtocolUnsupported, "unsupported protocol version")
	}
	if req.AppliedRevision < 0 || req.ReceivedRevision < req.AppliedRevision {
		return SyncResponse{}, protocolErr(CodeInvalidWatermark, "applied_revision must not exceed received_revision")
	}

	binding, _, err := s.advisoryCheck(ctx, req)
	if err != nil {
		return SyncResponse{}, err
	}

	// Operations are processed in client_seq ASC order.
	ops := make([]Operation, len(req.Operations))
	copy(ops, req.Operations)
	sort.SliceStable(ops, func(i, j int) bool { return ops[i].ClientSeq < ops[j].ClientSeq })

	results := make([]OperationResult, 0, len(ops))
	for _, op := range ops {
		res, err := s.processOperation(ctx, req, op)
		if err != nil {
			return SyncResponse{}, err
		}
		results = append(results, res)
	}

	// The page and its labels come from one read snapshot: a response whose
	// server_revision was read before its changes cannot describe either.
	limit := req.MaxChanges
	if limit <= 0 {
		limit = DefaultMaxChanges
	}
	space, changes, hasMore, err := s.changePage(ctx, req, limit)
	if err != nil {
		return SyncResponse{}, err
	}

	through := req.ReceivedRevision
	if len(changes) > 0 {
		through = changes[len(changes)-1].Revision
	}

	// Watermarks are written for the epoch this round was served under; a
	// binding that went inactive or changed epoch keeps the numbers of the
	// world it still describes.
	if err := s.store.UpdateBindingSync(ctx, binding.ID, space.Epoch,
		req.AppliedRevision, req.ReceivedRevision, time.Now().UTC()); err != nil {
		return SyncResponse{}, err
	}

	return SyncResponse{
		ProtocolVersion:      ProtocolVersion,
		Epoch:                space.Epoch,
		JournalFloorRevision: space.JournalFloorRevision,
		FromRevision:         req.ReceivedRevision + 1,
		ThroughRevision:      through,
		ServerRevision:       space.CurrentRevision,
		HasMore:              hasMore,
		OperationResults:     results,
		Changes:              changes,
	}, nil
}

// changePage reads the space head and the page of the change stream above the
// client's watermark as one snapshot, then releases it before the round's
// binding write: a response may only label rows it read together, and it must
// not hold the connection the write needs.
func (s *Service) changePage(ctx context.Context, req SyncRequest, limit int) (canonical.SyncSpace, []JournalChange, bool, error) {
	read, err := s.store.BeginReadTx(ctx)
	if err != nil {
		return canonical.SyncSpace{}, nil, false, err
	}
	defer func() { _ = read.Rollback(ctx) }()

	space, err := read.LoadSpace(ctx, req.SpaceID)
	if err != nil {
		return canonical.SyncSpace{}, nil, false, protocolErr(CodeBindingNotActive, "sync space unavailable")
	}
	if space.Epoch != req.Epoch {
		return canonical.SyncSpace{}, nil, false, protocolErr(CodeEpochMismatch, "canonical epoch changed")
	}
	// The floor is read with the rows. History can be garbage collected while
	// a request is in flight, and a page that quietly starts above the
	// revision it was asked for would leave a hole in the replica.
	if req.ReceivedRevision < space.JournalFloorRevision {
		return canonical.SyncSpace{}, nil, false, protocolErr(CodeHistoryExpired, "incremental history has been garbage collected")
	}
	changes, hasMore, err := loadChanges(ctx, read, space, req.ReceivedRevision+1, limit)
	if err != nil {
		return canonical.SyncSpace{}, nil, false, err
	}
	return space, changes, hasMore, nil
}

// advisoryCheck reads the binding and the space the way the protocol
// rejects a request that is already wrong. Its numbers are not used to
// decide anything that gets written.
func (s *Service) advisoryCheck(ctx context.Context, req SyncRequest) (device.Binding, canonical.SyncSpace, error) {
	binding, err := s.store.LoadBinding(ctx, req.DeviceID, req.SpaceID)
	if err != nil || binding.State != device.StateActive {
		return device.Binding{}, canonical.SyncSpace{}, protocolErr(CodeBindingNotActive, "binding is not active")
	}
	space, err := s.store.LoadSpace(ctx, req.SpaceID)
	if err != nil {
		return device.Binding{}, canonical.SyncSpace{}, protocolErr(CodeBindingNotActive, "sync space unavailable")
	}
	if req.Epoch != space.Epoch || binding.Epoch != space.Epoch {
		return device.Binding{}, canonical.SyncSpace{}, protocolErr(CodeEpochMismatch, "canonical epoch changed")
	}
	if req.ReceivedRevision > space.CurrentRevision {
		return device.Binding{}, canonical.SyncSpace{}, protocolErr(CodeInvalidWatermark, "received_revision is ahead of the server")
	}
	if req.ReceivedRevision < space.JournalFloorRevision {
		return device.Binding{}, canonical.SyncSpace{}, protocolErr(CodeHistoryExpired, "incremental history has been garbage collected")
	}
	return binding, space, nil
}

func loadChanges(ctx context.Context, read ReadTx, space canonical.SyncSpace, from int64, limit int) ([]JournalChange, bool, error) {
	rows, err := read.LoadJournalChanges(ctx, space.ID, space.Epoch, from, limit+1)
	if err != nil {
		return nil, false, err
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	if rows == nil {
		rows = []JournalChange{}
	}
	return rows, hasMore, nil
}

// processOperation runs one operation inside its own transaction:
// idempotent replay via receipt, conflict decision, canonical apply, receipt
// write and sequence watermark commit atomically.
//
// The transaction starts by re-reading the binding and the space head, and
// every decision below is made against those reads. A round that was validated
// against an older world may therefore still be rejected here — that is the
// point: the alternative is applying an intent whose base it never saw.
func (s *Service) processOperation(ctx context.Context, req SyncRequest, op Operation) (OperationResult, error) {
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return OperationResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	space, err := tx.LoadSpace(ctx, req.SpaceID)
	if errors.Is(err, canonical.ErrSpaceNotFound) {
		return OperationResult{}, protocolErr(CodeBindingNotActive, "sync space unavailable")
	}
	if err != nil {
		return OperationResult{}, err
	}
	binding, err := tx.LoadBinding(ctx, req.DeviceID, req.SpaceID)
	if err != nil || binding.State != device.StateActive {
		return OperationResult{}, protocolErr(CodeBindingNotActive, "binding is not active")
	}
	if req.Epoch != space.Epoch || binding.Epoch != space.Epoch {
		return OperationResult{}, protocolErr(CodeEpochMismatch, "canonical epoch changed")
	}

	// Idempotent replay: the same op_id with the same content returns the
	// original result without consuming a revision.
	if r, found, err := tx.LoadReceipt(ctx, binding.ID, op.OpID); err != nil {
		return OperationResult{}, err
	} else if found {
		if r.RequestHash != operationHash(op) {
			return OperationResult{}, protocolErr(CodeOpIDReused, "op_id reused with different payload")
		}
		return receiptResult(r), nil
	}

	// Envelope sanity. Invalid envelopes get no receipt (nothing was
	// durably decided about a well-formed op id).
	if op.OpID == "" || op.ClientSeq < 1 {
		return OperationResult{OpID: op.OpID, ClientSeq: op.ClientSeq, Status: StatusRejected, Reason: ReasonInvalidPayload}, nil
	}
	if op.ClientSeq <= binding.MaxClientSeq {
		return OperationResult{}, protocolErr(CodeClientSeqRegressed, "new operation's client_seq must not regress")
	}
	if op.BaseRevision < space.JournalFloorRevision {
		return OperationResult{}, protocolErr(CodeOperationHistoryExpired, "operation base predates journal floor")
	}

	// The sequence is spent as soon as the operation is well-formed enough
	// to be decided, in the same transaction as its receipt. Advancing it
	// any later would leave a window where a committed receipt could still
	// be replayed over; advancing it any earlier would let a request that
	// was rejected outright burn a number the client never used.
	if err := tx.AdvanceClientSeq(ctx, binding.ID, op.ClientSeq); err != nil {
		return OperationResult{}, err
	}

	origin := canonical.Origin{
		Type:      canonical.OriginDevice,
		DeviceID:  canonical.DeviceID(binding.DeviceID),
		BindingID: canonical.BindingID(binding.ID),
		ClientSeq: &op.ClientSeq,
		OpID:      op.OpID,
	}

	var res OperationResult
	switch op.Type {
	case OpCreate:
		res, err = s.decideCreate(ctx, tx, space, binding, op, req.DeviceName, origin)
	case OpUpdateTitle:
		res, err = s.decideUpdate(ctx, tx, space, binding, op, origin, false)
	case OpUpdateURL:
		res, err = s.decideUpdate(ctx, tx, space, binding, op, origin, true)
	case OpMove:
		res, err = s.decideMove(ctx, tx, space, binding, op, origin)
	case OpDelete:
		res, err = s.decideDelete(ctx, tx, space, binding, op, origin)
	default:
		res = rejectedResult(op, ReasonInvalidPayload)
	}
	if err != nil {
		return OperationResult{}, err
	}

	head, err := tx.LoadSpace(ctx, space.ID)
	if err != nil {
		return OperationResult{}, err
	}
	if err := tx.InsertReceipt(ctx, Receipt{
		BindingID:           binding.ID,
		OpID:                op.OpID,
		ClientSeq:           op.ClientSeq,
		RequestEpoch:        space.Epoch,
		BaseRevision:        op.BaseRevision,
		RequestHash:         operationHash(op),
		Status:              res.Status,
		Reason:              res.Reason,
		ResultRevision:      res.ResultRevision,
		SettleAfterRevision: res.SettleAfterRevision,
		ProcessedAtRevision: head.CurrentRevision,
		CreatedAt:           time.Now().UTC().Format(time.RFC3339Nano),
	}); err != nil {
		return OperationResult{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return OperationResult{}, err
	}
	committed = true
	return res, nil
}

func receiptResult(r Receipt) OperationResult {
	return OperationResult{
		OpID:                r.OpID,
		ClientSeq:           r.ClientSeq,
		Status:              r.Status,
		Reason:              r.Reason,
		ResultRevision:      r.ResultRevision,
		SettleAfterRevision: r.SettleAfterRevision,
	}
}

func rejectedResult(op Operation, reason string) OperationResult {
	return OperationResult{OpID: op.OpID, ClientSeq: op.ClientSeq, Status: StatusRejected, Reason: reason}
}

func rejectedWithSettle(op Operation, reason string, settle int64) OperationResult {
	res := rejectedResult(op, reason)
	res.SettleAfterRevision = settle
	return res
}

func noopResult(op Operation, reason string, settle int64) OperationResult {
	return OperationResult{OpID: op.OpID, ClientSeq: op.ClientSeq, Status: StatusNoop, Reason: reason, SettleAfterRevision: settle}
}

func conflictResult(op Operation, reason string, settle int64) OperationResult {
	return OperationResult{OpID: op.OpID, ClientSeq: op.ClientSeq, Status: StatusConflict, Reason: reason, SettleAfterRevision: settle}
}
