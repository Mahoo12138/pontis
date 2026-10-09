// Sync Coordinator (doc 05 §6/§15): one /sync round per binding —
//   drain inbox → push QUEUED ops + pull changes → persist response +
//   inbox atomically, advance received_revision → apply inbox serially
//   → settle pending ops. Loops while has_more. Never trusts HTTP success
//   alone; pending cleanup follows settle_after_revision (doc 04 §7).

import { ApiError, type SyncTransport, type TransferTransport } from '../transport/client';
import {
  acquireRunLock,
  activeReconSession,
  collectSubtree,
  logDiagnostic,
  releaseRunLock,
  type BindingRecord,
  type LocalNodeRecord,
  type PontisDB,
  type PendingOpRecord,
} from '../store/db';
import { uuidv7 } from '../util/ids';
import {
  MAX_CHANGES_PER_ROUND,
  SYNC_PROTOCOL_VERSION,
  type OpType,
  type OperationResultWire,
  type OperationWire,
  type SyncRequestWire,
  type SyncResponseWire,
  type TransferResponseWire,
} from '../protocol/types';
import { UnmappedProjectionError, type RemoteChangeApplier } from './remoteChangeApplier';

export type SyncOutcome = 'synced' | 'needs-recovery' | 'inactive' | 'error';

/** Safety valve so a stuck has_more loop can't spin forever. */
const MAX_ROUNDS_PER_SYNC = 20;

export class SyncCoordinator {
  constructor(
    private db: PontisDB,
    private applier: RemoteChangeApplier,
    private transport: SyncTransport,
    private transfers?: TransferTransport,
  ) {}

  async syncBinding(bindingId: string): Promise<SyncOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || !(await this.canRun(binding))) return 'inactive';
    // One holder per binding. An alarm, a manual click, a worker wake and a
    // recovery attempt otherwise interleave on the same inbox and the same
    // watermarks, and the replica ends up reporting a tree it never applied.
    const lockToken = uuidv7();
    if (!(await acquireRunLock(this.db, bindingId, lockToken))) {
      await logDiagnostic(this.db, 'info', 'coordinator', 'another round holds this binding, skipping', {
        bindingId,
      });
      return 'inactive';
    }
    try {
      return await this.rounds(bindingId);
    } finally {
      await releaseRunLock(this.db, bindingId, lockToken);
    }
  }

  private async rounds(bindingId: string): Promise<SyncOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || !(await this.canRun(binding))) return 'inactive';

    // Finish apply work interrupted by a previous crash (doc 05 §10).
    await this.applier.recover(bindingId);

    for (let round = 0; round < MAX_ROUNDS_PER_SYNC; round++) {
      const b = await this.db.bindings.get(bindingId);
      if (!b || !(await this.canRun(b))) return 'inactive';

      const req = await this.buildRequest(b.id);
      let resp: SyncResponseWire;
      try {
        resp = await this.transport.sync(b.id, req);
      } catch (err) {
        // Binding continuity broken (doc 04 §12/§14): pause and surface.
        // NOT_BINDING_OWNER is terminal rather than a sync-protocol break: a
        // replica copied into another profile can never own the binding, so
        // retrying it every round would only bury the real error.
        const terminal = err instanceof ApiError && (err.isProtocolError || err.code === 'NOT_BINDING_OWNER');
        if (terminal) {
          await this.db.bindings.update(b.id, {
            state: 'needs_recovery',
            recovery: { code: err.code, message: err.message },
          });
          await logDiagnostic(this.db, 'error', 'coordinator', 'binding cannot be synced from this replica, needs recovery', {
            bindingId: b.id,
            code: err.code,
          });
          return 'needs-recovery';
        }
        await logDiagnostic(this.db, 'warn', 'coordinator', 'sync round failed, will retry later', {
          bindingId: b.id,
          error: String(err),
        });
        return 'error';
      }

      // Rule 3 (doc 05 §16): persist results + inbox, THEN advance
      // received_revision — all in one transaction.
      await this.db.transaction('rw', [this.db.bindings, this.db.pendingOps, this.db.remoteChanges], async () => {
        const current = await this.db.bindings.get(b.id);
        if (!current) return;
        if (current.epoch !== resp.epoch) {
          // Epoch changed behind our back: needs recovery, not replay.
          current.state = 'needs_recovery';
          current.recovery = { code: 'EPOCH_MISMATCH', message: 'epoch changed mid-sync' };
          await this.db.bindings.put(current);
          return;
        }
        for (const r of resp.operation_results) {
          await this.recordResult(b.id, r);
        }
        for (const c of resp.changes) {
          await this.db.remoteChanges.put({
            id: `${b.id}:${c.revision}`,
            bindingId: b.id,
            revision: c.revision,
            type: c.type,
            nodeId: c.node_id,
            payload: c.payload,
          });
        }
        current.receivedRevision = Math.max(current.receivedRevision, resp.through_revision);
        await this.db.bindings.put(current);
      });

      const afterPersist = await this.db.bindings.get(b.id);
      if (afterPersist && afterPersist.state === 'needs_recovery') return 'needs-recovery';

      // Apply the inbox strictly serially (doc 05 §7). A change that targets
      // a lost mapping stops the run here: applied_revision keeps its last
      // genuinely reached value and the binding asks for repair.
      const inbox = await this.db.remoteChanges
        .where('[bindingId+revision]')
        .between([b.id, b.appliedRevision + 1], [b.id, Number.MAX_SAFE_INTEGER], true, true)
        .sortBy('revision');
      for (const rec of inbox) {
        try {
          await this.applier.applyChange(b.id, {
            revision: rec.revision,
            type: rec.type,
            node_id: rec.nodeId,
            payload: rec.payload as SyncResponseWire['changes'][number]['payload'],
          });
        } catch (err) {
          if (!(err instanceof UnmappedProjectionError)) throw err;
          await this.db.bindings.update(b.id, {
            state: 'needs_recovery',
            recovery: { code: err.code, message: err.message },
          });
          await logDiagnostic(this.db, 'error', 'coordinator', 'remote change targets a lost mapping', {
            bindingId: b.id,
            revision: rec.revision,
            kind: err.kind,
            target: err.target,
          });
          return 'needs-recovery';
        }
      }

      // HTTP success ≠ pending deletable: settle only what the server
      // says is safe (doc 04 §7, doc 22 B.7).
      await this.settlePending(b.id);

      if (!resp.has_more) break;
    }

    // Cross-space transfers (doc 03 §7) ride their own endpoint; they are
    // not /sync operations. Upload any QUEUED ones after the rounds.
    await this.processTransfers(bindingId);

    await this.db.bindings.update(bindingId, { lastSyncAt: Date.now() });
    return 'synced';
  }

  async syncAll(): Promise<void> {
    const bindings = await this.db.bindings.where('state').equals('active').toArray();
    for (const b of bindings) {
      try {
        await this.syncBinding(b.id);
      } catch (err) {
        await logDiagnostic(this.db, 'error', 'coordinator', 'unexpected sync failure', {
          bindingId: b.id,
          error: String(err),
        });
      }
    }
  }

  /**
   * Incremental rounds run when the binding is active, or when an active
   * reconciliation session is in its apply/verify phases (the engine
   * drives the loop then; WAITING_USER and other phases pause us).
   */
  private async canRun(binding: BindingRecord): Promise<boolean> {
    if (binding.state === 'active') return true;
    if (binding.state !== 'initializing' && binding.state !== 'resyncing') return false;
    const session = await activeReconSession(this.db, binding.id);
    return session != null && (session.phase === 'apply' || session.phase === 'verify');
  }

  private async buildRequest(bindingId: string): Promise<SyncRequestWire> {
    const b = (await this.db.bindings.get(bindingId))!;
    const queued = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .sortBy('clientSeq');
    // Transfer intents never appear as /sync operations.
    const syncOps = queued.filter((o): o is PendingOpRecord & { type: OpType } => o.type !== 'transfer');
    return {
      protocol_version: SYNC_PROTOCOL_VERSION,
      epoch: b.epoch,
      applied_revision: b.appliedRevision,
      received_revision: b.receivedRevision,
      operations: syncOps.map(toWire),
      max_changes: MAX_CHANGES_PER_ROUND,
    };
  }

  /**
   * Upload QUEUED transfer intents to /sync/transfers (doc 08 §15).
   * On ack, the source binding's subtree mirrors are dropped and the
   * target binding's mirrors rebuilt from the response mapping (browser
   * ids are reused); the pending op is deleted. The subsequent回流
   * converges naturally: source delete → NOOP advance, target create →
   * ensure-state advance (mirrors already satisfy the changes).
   */
  private async processTransfers(bindingId: string): Promise<void> {
    if (!this.transfers) return;
    const ops = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .filter((o) => o.type === 'transfer')
      .toArray();
    for (const op of ops) {
      if (op.type !== 'transfer' || !op.targetSpaceId || !op.targetParent) continue;
      const source = await this.db.bindings.get(op.bindingId);
      if (!source) continue;
      let resp: TransferResponseWire;
      try {
        resp = await this.transfers.createTransfer({
          transfer_id: op.opId,
          source_space_id: source.spaceId,
          target_space_id: op.targetSpaceId,
          node_id: op.nodeId,
          target_parent: op.targetParent,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          // Permanent rejection (e.g. TRANSFER_ID_REUSED): surface it, do
          // not retry forever.
          await this.db.pendingOps.update(op.opId, {
            status: 'RESOLVED',
            keepResolved: true,
            result: {
              status: 'CONFLICT',
              reason: err.code,
              resultRevision: 0,
              settleAfterRevision: Number.MAX_SAFE_INTEGER,
            },
          });
          await logDiagnostic(this.db, 'error', 'coordinator', 'transfer rejected by server', {
            bindingId: op.bindingId,
            opId: op.opId,
            code: err.code,
          });
          continue;
        }
        await logDiagnostic(this.db, 'warn', 'coordinator', 'transfer upload failed, will retry', {
          bindingId: op.bindingId,
          opId: op.opId,
          error: String(err),
        });
        continue;
      }
      await this.commitTransferAck(op, resp);
    }
  }

  /** Ack bookkeeping: rebuild mirrors on both sides in one transaction. */
  private async commitTransferAck(op: PendingOpRecord, resp: TransferResponseWire): Promise<void> {
    const sourceBinding = await this.db.bindings.get(op.bindingId);
    if (!sourceBinding || !op.browserId) return;
    const mapping = new Map(resp.mapping.map((m) => [m.source_node_id, m.target_node_id]));
    const targetBinding = await this.db.bindings.where('spaceId').equals(op.targetSpaceId ?? '').first();

    // The browser tree already holds the subtree at its new location, so
    // the old source mirrors carry the browser ids to re-map.
    const subtree = await collectSubtree(this.db, op.bindingId, op.browserId);
    const targetMirrors: LocalNodeRecord[] = [];
    for (const m of subtree) {
      const canonical = m.canonicalId == null ? null : (mapping.get(m.canonicalId) ?? null);
      if (canonical == null) continue;
      targetMirrors.push({
        ...m,
        bindingId: targetBinding?.id ?? m.bindingId,
        canonicalId: canonical,
        // Only the moved root changes parents; children keep theirs.
        parentBrowserId: m.browserId === op.browserId ? (op.browserParentId ?? m.parentBrowserId) : m.parentBrowserId,
        position: null,
      });
    }

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      await this.db.localNodes.bulkDelete(subtree.map((r) => [op.bindingId, r.browserId] as [string, string]));
      if (targetBinding) {
        await this.db.localNodes.bulkPut(targetMirrors);
      }
      await this.db.pendingOps.delete(op.opId);
    });
    await logDiagnostic(this.db, 'info', 'coordinator', 'cross-space transfer acked, mappings rebuilt', {
      bindingId: op.bindingId,
      opId: op.opId,
      nodes: resp.mapping.length,
    });
  }

  private async recordResult(bindingId: string, r: OperationResultWire): Promise<void> {
    const pending: PendingOpRecord | undefined = await this.db.pendingOps.get(r.op_id);
    if (!pending) return;
    pending.status = 'RESOLVED';
    pending.result = {
      status: r.status,
      reason: r.reason,
      resultRevision: r.result_revision,
      settleAfterRevision: r.settle_after_revision,
    };
    await this.db.pendingOps.put(pending);
  }

  private async settlePending(bindingId: string): Promise<void> {
    const b = await this.db.bindings.get(bindingId);
    if (!b) return;
    const resolved = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'RESOLVED'])
      .toArray();
    for (const p of resolved) {
      const settle = p.result?.settleAfterRevision ?? 0;
      if (settle <= b.appliedRevision && !p.keepResolved) {
        await this.db.pendingOps.delete(p.opId);
      }
    }
  }
}

function toWire(p: PendingOpRecord & { type: OpType }): OperationWire {
  return {
    op_id: p.opId,
    client_seq: p.clientSeq,
    base_revision: p.baseRevision,
    type: p.type,
    node_id: p.nodeId,
    node_type: p.nodeType,
    title: p.title,
    url: p.url,
    parent: p.parent,
    before_id: p.beforeId ?? null,
  };
}
