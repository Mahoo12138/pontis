package sync

import (
	"context"
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

	LoadBinding(ctx context.Context, deviceID canonical.DeviceID, space canonical.SpaceID) (device.Binding, error)
	LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)

	// LoadJournalChanges returns journal rows of one epoch ordered by
	// revision, starting at fromRevision (inclusive), at most limit rows.
	LoadJournalChanges(ctx context.Context, space canonical.SpaceID, epoch, fromRevision int64, limit int) ([]JournalChange, error)

	// LoadSnapshotNodes returns every canonical node of the space for a
	// snapshot rebuild, ordered deterministically (root key, position, id).
	LoadSnapshotNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)

	// UpdateBindingSync persists the binding watermarks reported by the
	// client after a completed round.
	UpdateBindingSync(ctx context.Context, bindingID string, appliedRevision, receivedRevision, maxClientSeq int64, lastSyncAt time.Time) error
}

// Tx is a sync round transaction. It extends the canonical transaction
// with the sync-specific reads and writes.
type Tx interface {
	canonical.Tx

	LoadTombstone(ctx context.Context, space canonical.SpaceID, node canonical.NodeID) (Tombstone, bool, error)
	LoadReceipt(ctx context.Context, bindingID, opID string) (Receipt, bool, error)
	InsertReceipt(ctx context.Context, r Receipt) error

	// EnsureRootSlot creates the root slot if it does not exist yet
	// (used for Recovered/<Device> containers).
	EnsureRootSlot(ctx context.Context, space canonical.SpaceID, key, displayName string) error

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
func (s *Service) Sync(ctx context.Context, req SyncRequest) (SyncResponse, error) {
	if req.ProtocolVersion != ProtocolVersion {
		return SyncResponse{}, protocolErr(CodeSyncProtocolUnsupported, "unsupported protocol version")
	}
	if req.AppliedRevision < 0 || req.ReceivedRevision < req.AppliedRevision {
		return SyncResponse{}, protocolErr(CodeInvalidWatermark, "applied_revision must not exceed received_revision")
	}

	binding, err := s.store.LoadBinding(ctx, req.DeviceID, req.SpaceID)
	if err != nil || binding.State != device.StateActive {
		return SyncResponse{}, protocolErr(CodeBindingNotActive, "binding is not active")
	}

	space, err := s.store.LoadSpace(ctx, req.SpaceID)
	if err != nil {
		return SyncResponse{}, protocolErr(CodeBindingNotActive, "sync space unavailable")
	}
	if req.Epoch != space.Epoch || binding.Epoch != space.Epoch {
		return SyncResponse{}, protocolErr(CodeEpochMismatch, "canonical epoch changed")
	}
	if req.ReceivedRevision > space.CurrentRevision {
		return SyncResponse{}, protocolErr(CodeInvalidWatermark, "received_revision is ahead of the server")
	}
	if req.ReceivedRevision < space.JournalFloorRevision {
		return SyncResponse{}, protocolErr(CodeHistoryExpired, "incremental history has been garbage collected")
	}

	// Operations are processed in client_seq ASC order.
	ops := make([]Operation, len(req.Operations))
	copy(ops, req.Operations)
	sort.SliceStable(ops, func(i, j int) bool { return ops[i].ClientSeq < ops[j].ClientSeq })

	results := make([]OperationResult, 0, len(ops))
	maxSeq := binding.MaxClientSeq
	for _, op := range ops {
		res, err := s.processOperation(ctx, op, space, binding, req.DeviceName, maxSeq)
		if err != nil {
			return SyncResponse{}, err
		}
		results = append(results, res)
		if op.ClientSeq > maxSeq {
			maxSeq = op.ClientSeq
		}
	}

	// Reload the space head: processed operations may have advanced it.
	space, err = s.store.LoadSpace(ctx, req.SpaceID)
	if err != nil {
		return SyncResponse{}, err
	}

	limit := req.MaxChanges
	if limit <= 0 {
		limit = DefaultMaxChanges
	}
	changes, hasMore, err := s.loadChanges(ctx, space, req.ReceivedRevision+1, limit)
	if err != nil {
		return SyncResponse{}, err
	}

	through := req.ReceivedRevision
	if len(changes) > 0 {
		through = changes[len(changes)-1].Revision
	}

	if err := s.store.UpdateBindingSync(ctx, binding.ID, req.AppliedRevision, req.ReceivedRevision, maxSeq, time.Now().UTC()); err != nil {
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

func (s *Service) loadChanges(ctx context.Context, space canonical.SyncSpace, from int64, limit int) ([]JournalChange, bool, error) {
	rows, err := s.store.LoadJournalChanges(ctx, space.ID, space.Epoch, from, limit+1)
	if err != nil {
		return nil, false, err
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	return rows, hasMore, nil
}

// processOperation runs one operation inside its own transaction:
// idempotent replay via receipt, conflict decision, canonical apply and
// receipt write commit atomically.
func (s *Service) processOperation(ctx context.Context, op Operation, space canonical.SyncSpace, binding device.Binding, deviceName string, maxSeq int64) (OperationResult, error) {
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
	if op.ClientSeq <= maxSeq {
		return OperationResult{}, protocolErr(CodeClientSeqRegressed, "new operation's client_seq must not regress")
	}
	if op.BaseRevision < space.JournalFloorRevision {
		return OperationResult{}, protocolErr(CodeOperationHistoryExpired, "operation base predates journal floor")
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
		res, err = s.decideCreate(ctx, tx, space, binding, op, deviceName, origin)
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
