// Sync Coordinator (doc 05 §6/§15): one /sync round per binding —
//   drain inbox → push QUEUED ops + pull changes → persist response +
//   inbox atomically, advance received_revision → apply inbox serially
//   → settle pending ops. Loops while has_more. Never trusts HTTP success
//   alone; pending cleanup follows settle_after_revision (doc 04 §7).

import { ApiError, type SyncTransport } from '../transport/client';
import { logDiagnostic, type PontisDB, type PendingOpRecord } from '../store/db';
import {
  MAX_CHANGES_PER_ROUND,
  SYNC_PROTOCOL_VERSION,
  type OperationResultWire,
  type OperationWire,
  type SyncRequestWire,
  type SyncResponseWire,
} from '../protocol/types';
import type { RemoteChangeApplier } from './remoteChangeApplier';

export type SyncOutcome = 'synced' | 'needs-recovery' | 'inactive' | 'error';

/** Safety valve so a stuck has_more loop can't spin forever. */
const MAX_ROUNDS_PER_SYNC = 20;

export class SyncCoordinator {
  constructor(
    private db: PontisDB,
    private applier: RemoteChangeApplier,
    private transport: SyncTransport,
  ) {}

  async syncBinding(bindingId: string): Promise<SyncOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || binding.state !== 'active') return 'inactive';

    // Finish apply work interrupted by a previous crash (doc 05 §10).
    await this.applier.recover(bindingId);

    for (let round = 0; round < MAX_ROUNDS_PER_SYNC; round++) {
      const b = await this.db.bindings.get(bindingId);
      if (!b || b.state !== 'active') return 'inactive';

      const req = await this.buildRequest(b.id);
      let resp: SyncResponseWire;
      try {
        resp = await this.transport.sync(b.id, req);
      } catch (err) {
        if (err instanceof ApiError && err.isProtocolError) {
          // Binding continuity broken (doc 04 §12/§14): pause and surface.
          await this.db.bindings.update(b.id, {
            state: 'needs_recovery',
            recovery: { code: err.code, message: err.message },
          });
          await logDiagnostic(this.db, 'error', 'coordinator', 'protocol failure, binding needs recovery', {
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

      // Apply the inbox strictly serially (doc 05 §7).
      const inbox = await this.db.remoteChanges
        .where('[bindingId+revision]')
        .between([b.id, b.appliedRevision + 1], [b.id, Number.MAX_SAFE_INTEGER], true, true)
        .sortBy('revision');
      for (const rec of inbox) {
        await this.applier.applyChange(b.id, {
          revision: rec.revision,
          type: rec.type,
          node_id: rec.nodeId,
          payload: rec.payload as SyncResponseWire['changes'][number]['payload'],
        });
      }

      // HTTP success ≠ pending deletable: settle only what the server
      // says is safe (doc 04 §7, doc 22 B.7).
      await this.settlePending(b.id);

      if (!resp.has_more) break;
    }

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

  private async buildRequest(bindingId: string): Promise<SyncRequestWire> {
    const b = (await this.db.bindings.get(bindingId))!;
    const queued = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .sortBy('clientSeq');
    return {
      protocol_version: SYNC_PROTOCOL_VERSION,
      epoch: b.epoch,
      applied_revision: b.appliedRevision,
      received_revision: b.receivedRevision,
      operations: queued.map(toWire),
      max_changes: MAX_CHANGES_PER_ROUND,
    };
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
      if (settle <= b.appliedRevision) {
        await this.db.pendingOps.delete(p.opId);
      }
    }
  }
}

function toWire(p: PendingOpRecord): OperationWire {
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
