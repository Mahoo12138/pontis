import { Operation } from '@pontis/protocol';

import {
  BindingRow,
  ExpectedMutationRow,
  MirrorNode,
  PendingOpRow,
  ReplicaDB,
  RemoteChangeRow,
} from './db';

/**
 * Replica store operations (doc 05 §3-6). The crash-consistency rules
 * live here: capture and response ingestion are single IndexedDB
 * transactions, and received_revision only advances after the response
 * data is durable.
 */
export class ReplicaStore {
  readonly db: ReplicaDB;

  constructor(db: ReplicaDB) {
    this.db = db;
  }

  // --- bindings ---

  async ensureBinding(config: Omit<BindingRow, 'appliedRevision' | 'receivedRevision' | 'maxClientSeq' | 'epoch' | 'rootMap'> & Partial<BindingRow>): Promise<void> {
    const existing = await this.db.bindings.get(config.bindingId);
    if (existing) {
      await this.db.bindings.put({ ...existing, ...config } as BindingRow);
      return;
    }
    await this.db.bindings.put({
      bindingId: config.bindingId,
      spaceId: config.spaceId,
      deviceId: config.deviceId,
      deviceName: config.deviceName,
      epoch: config.epoch ?? 1,
      appliedRevision: config.appliedRevision ?? 0,
      receivedRevision: config.receivedRevision ?? 0,
      maxClientSeq: config.maxClientSeq ?? 0,
      rootMap: config.rootMap ?? {},
    });
  }

  async getBinding(bindingId: string): Promise<BindingRow | undefined> {
    return this.db.bindings.get(bindingId);
  }

  async setRootMap(bindingId: string, rootMap: Record<string, string>): Promise<void> {
    await this.db.bindings.update(bindingId, { rootMap });
  }

  // --- mirror / mapping (doc 05 §4) ---

  async getMirrorByCanonical(bindingId: string, canonicalId: string): Promise<MirrorNode | undefined> {
    return this.db.localNodes.get([bindingId, canonicalId]);
  }

  async getMirrorByBrowser(bindingId: string, browserId: string): Promise<MirrorNode | undefined> {
    return this.db.localNodes.where('[bindingId+browserId]').equals([bindingId, browserId]).first();
  }

  async putMirror(node: MirrorNode): Promise<void> {
    await this.db.localNodes.put(node);
  }

  async putMirrorMany(nodes: MirrorNode[]): Promise<void> {
    await this.db.localNodes.bulkPut(nodes);
  }

  async deleteMirrorMany(bindingId: string, canonicalIds: string[]): Promise<void> {
    await this.db.localNodes.bulkDelete(canonicalIds.map((cid) => [bindingId, cid]));
  }

  /** Mirror rows whose parent is the given canonical folder. */
  async listMirrorChildrenOfNode(bindingId: string, parentCanonicalId: string): Promise<MirrorNode[]> {
    return this.db.localNodes.where('[bindingId+parentCanonicalId]').equals([bindingId, parentCanonicalId]).toArray();
  }

  /** Mirror rows whose parent is the given root slot. */
  async listMirrorChildrenOfRoot(bindingId: string, rootKey: string): Promise<MirrorNode[]> {
    return this.db.localNodes.where('[bindingId+parentRootKey]').equals([bindingId, rootKey]).toArray();
  }

  async listMirrorAll(bindingId: string): Promise<MirrorNode[]> {
    return this.db.localNodes.where('bindingId').equals(bindingId).toArray();
  }

  async listMirrorByBrowserIds(bindingId: string, browserIds: string[]): Promise<Map<string, MirrorNode>> {
    const out = new Map<string, MirrorNode>();
    for (const browserId of browserIds) {
      const node = await this.getMirrorByBrowser(bindingId, browserId);
      if (node) {
        out.set(browserId, node);
      }
    }
    return out;
  }

  // --- local event capture (doc 05 §5, crash rule 1) ---
  // Mirror updates and the pending operation commit in ONE transaction.

  async captureLocalMutation(bindingId: string, opts: {
    upserts: MirrorNode[];
    deletes: string[];
    ops: Operation[];
  }): Promise<void> {
    if (opts.ops.length === 0) {
      throw new Error('replica: capture without operations');
    }
    await this.db.transaction('rw', this.db.localNodes, this.db.pendingOperations, this.db.bindings, async () => {
      await this.putMirrorMany(opts.upserts);
      await this.deleteMirrorMany(bindingId, opts.deletes);
      const binding = await this.getBinding(bindingId);
      if (!binding) {
        throw new Error(`replica: unknown binding ${bindingId}`);
      }
      let clientSeq = binding.maxClientSeq;
      for (const op of opts.ops) {
        clientSeq += 1;
        await this.db.pendingOperations.add({
          bindingId,
          opId: op.op_id,
          clientSeq,
          baseRevision: op.base_revision,
          op: { ...op, client_seq: clientSeq },
          state: 'QUEUED',
          settleAfter: 0,
        });
      }
      await this.db.bindings.update(bindingId, { maxClientSeq: clientSeq });
    });
  }

  // --- outbox / response ingestion (doc 05 §6, crash rule 3) ---

  async listQueuedOps(bindingId: string): Promise<PendingOpRow[]> {
    return this.db.pendingOperations.where('[bindingId+state]').equals([bindingId, 'QUEUED']).toArray();
  }

  /**
   * Persists operation results and remote changes and advances the
   * received watermark inside one transaction. Duplicate deliveries
   * (replayed requests, retried responses) are idempotent.
   */
  async ingestResponse(bindingId: string, resp: {
    epoch: number;
    through_revision: number;
    operation_results: { op_id: string; status: string; reason: string; result_revision: number; settle_after_revision: number }[];
    changes: { revision: number; type: string; node_id: string; payload: unknown }[];
  }): Promise<void> {
    await this.db.transaction('rw', this.db.pendingOperations, this.db.remoteChanges, this.db.bindings, async () => {
      const binding = await this.getBinding(bindingId);
      if (!binding) {
        throw new Error(`replica: unknown binding ${bindingId}`);
      }
      for (const result of resp.operation_results) {
        const row = await this.db.pendingOperations.where('[bindingId+opId]').equals([bindingId, result.op_id]).first();
        if (!row || row.state !== 'QUEUED') {
          continue; // settled by an earlier replay
        }
        const settleAfter = result.settle_after_revision;
        await this.db.pendingOperations.update(row.rowId!, {
          state: settleAfter > binding.appliedRevision ? 'RESOLVED' : 'SETTLED',
          result: {
            status: result.status,
            reason: result.reason,
            resultRevision: result.result_revision,
            settleAfterRevision: result.settle_after_revision,
          },
          settleAfter,
        });
      }
      for (const change of resp.changes) {
        if (change.revision <= binding.receivedRevision) {
          continue; // duplicate delivery
        }
        await this.db.remoteChanges.put({
          bindingId,
          revision: change.revision,
          type: change.type,
          nodeId: change.node_id,
          payload: change.payload,
          applied: 0,
        });
      }
      const received = Math.max(binding.receivedRevision, resp.through_revision);
      await this.db.bindings.update(bindingId, { receivedRevision: received, epoch: resp.epoch });
    });
  }

  /** Marks one inbox change applied and advances the applied watermark. */
  async confirmApplied(bindingId: string, revision: number): Promise<void> {
    await this.db.transaction('rw', this.db.remoteChanges, this.db.bindings, async () => {
      await this.db.remoteChanges.update([bindingId, revision], { applied: 1 });
      const binding = await this.getBinding(bindingId);
      if (!binding) {
        return;
      }
      if (revision > binding.appliedRevision) {
        await this.db.bindings.update(bindingId, { appliedRevision: revision });
      }
    });
  }

  /** Marks settled every resolved op whose winning state has been applied. */
  async settlePass(bindingId: string): Promise<number> {
    const binding = await this.getBinding(bindingId);
    if (!binding) {
      return 0;
    }
    const pending = await this.db.pendingOperations.where('[bindingId+state]').equals([bindingId, 'RESOLVED']).toArray();
    let settled = 0;
    for (const row of pending) {
      if (row.settleAfter > 0 && binding.appliedRevision >= row.settleAfter) {
        await this.db.pendingOperations.update(row.rowId!, { state: 'SETTLED' });
        settled++;
      }
    }
    return settled;
  }

  /** Operations still blocking (queued or awaiting settle). */
  async pendingCount(bindingId: string): Promise<number> {
    const queued = await this.listQueuedOps(bindingId);
    const resolved = await this.db.pendingOperations.where('[bindingId+state]').equals([bindingId, 'RESOLVED']).toArray();
    return queued.length + resolved.length;
  }

  /**
   * Drops every pending/resolved operation of the binding. Used when an
   * initial reconciliation completes: the deferred local intents (doc 06
   * §4, §13) are already part of the imported browser snapshot, so
   * replaying them would duplicate the data.
   */
  async clearPendingOperations(bindingId: string): Promise<void> {
    await this.db.pendingOperations.where('bindingId').equals(bindingId).delete();
  }

  /** All settled rows (for assertions and diagnostics). */
  async settledOps(bindingId: string): Promise<PendingOpRow[]> {
    return this.db.pendingOperations.where('[bindingId+state]').equals([bindingId, 'SETTLED']).toArray();
  }

  // --- inbox ---

  async nextInboxChange(bindingId: string): Promise<RemoteChangeRow | undefined> {
    const rows = await this.db.remoteChanges.where('[bindingId+applied]').equals([bindingId, 0]).toArray();
    rows.sort((a, b) => a.revision - b.revision);
    return rows[0];
  }

  async unappliedCount(bindingId: string): Promise<number> {
    return this.db.remoteChanges.where('[bindingId+applied]').equals([bindingId, 0]).count();
  }

  // --- expected remote mutations (doc 05 §8) ---

  async putExpectation(e: Omit<ExpectedMutationRow, 'id' | 'createdAt'>): Promise<void> {
    await this.db.expectedMutations.add({ ...e, createdAt: Date.now() });
  }

  /** Consumes (at most one) matching expectation. */
  async takeExpectation(match: (e: ExpectedMutationRow) => boolean): Promise<ExpectedMutationRow | undefined> {
    const rows = await this.db.expectedMutations.toArray();
    for (const row of rows) {
      if (match(row)) {
        await this.db.expectedMutations.delete(row.id!);
        return row;
      }
    }
    return undefined;
  }

  async countExpectations(bindingId: string): Promise<number> {
    return this.db.expectedMutations.filter((e) => e.bindingId === bindingId).count();
  }
}
