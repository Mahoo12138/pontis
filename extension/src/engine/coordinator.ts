import { Change, Operation, PROTOCOL_VERSION, SyncRequest } from '@pontis/protocol';

import { BrowserAdapter } from '../adapter/types';
import { ReplicaStore } from '../store/replica';
import { RemoteApplier } from './applier';
import { SyncTransport } from './client';

export interface SyncRoundResult {
  progressed: boolean;
  flushedOps: number;
  appliedChanges: number;
}

/**
 * Sync coordinator (doc 05 §6-11): the /sync loop. One round applies
 * the persisted inbox first (crash resume), flushes the outbox, then
 * pulls the change stream until drained. Strictly serial application,
 * ensure-state idempotency.
 */
export class SyncCoordinator {
  /** Network gate; capture works offline (doc 04). */
  online = true;

  private applier: RemoteApplier;

  constructor(
    private store: ReplicaStore,
    adapter: BrowserAdapter,
    private client: SyncTransport,
    private bindingId: string,
    private opts: { maxChanges?: number; maxPullRounds?: number } = {},
  ) {
    this.applier = new RemoteApplier(store, adapter, bindingId);
  }

  async syncRound(): Promise<SyncRoundResult> {
    const appliedChanges = await this.applyInbox();
    let flushedOps = 0;
    let pulledMore = false;
    if (this.online) {
      flushedOps = await this.flushOutbox();
      pulledMore = await this.pull();
    }
    return {
      progressed: appliedChanges > 0 || flushedOps > 0 || pulledMore,
      flushedOps,
      appliedChanges,
    };
  }

  /** Drives rounds until nothing progresses (test/drain helper). */
  async drain(maxRounds = 200): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const round = await this.syncRound();
      if (!round.progressed) {
        return;
      }
    }
    throw new Error(`coordinator: binding ${this.bindingId} did not converge within ${maxRounds} rounds`);
  }

  private async flushOutbox(): Promise<number> {
    const queued = await this.store.listQueuedOps(this.bindingId);
    if (queued.length === 0) {
      return 0;
    }
    const binding = await this.binding();
    const resp = await this.client.sync(this.bindingId, {
      protocol_version: PROTOCOL_VERSION,
      epoch: binding.epoch,
      applied_revision: binding.appliedRevision,
      received_revision: binding.receivedRevision,
      operations: queued.map((row) => row.op as Operation),
      max_changes: this.opts.maxChanges ?? 500,
    });
    await this.store.ingestResponse(this.bindingId, resp);
    return resp.operation_results.length;
  }

  private async pull(): Promise<boolean> {
    let progressed = false;
    for (let i = 0; i < (this.opts.maxPullRounds ?? 200); i++) {
      const binding = await this.binding();
      const resp = await this.client.sync(this.bindingId, {
        protocol_version: PROTOCOL_VERSION,
        epoch: binding.epoch,
        applied_revision: binding.appliedRevision,
        received_revision: binding.receivedRevision,
        operations: [],
        max_changes: this.opts.maxChanges ?? 500,
      });
      const before = binding.receivedRevision;
      await this.store.ingestResponse(this.bindingId, resp);
      const applied = await this.applyInbox();
      progressed = progressed || applied > 0 || resp.through_revision > before;
      const after = await this.binding();
      if (after.receivedRevision >= resp.server_revision) {
        return progressed;
      }
    }
    throw new Error(`coordinator: change stream did not drain for ${this.bindingId}`);
  }

  private async applyInbox(): Promise<number> {
    let applied = 0;
    for (;;) {
      const change = await this.store.nextInboxChange(this.bindingId);
      if (!change) {
        break;
      }
      const binding = await this.binding();
      if (change.revision <= binding.appliedRevision) {
        // Applied before a crash; drop the duplicate.
        await this.store.confirmApplied(this.bindingId, change.revision);
        continue;
      }
      if (change.revision > binding.receivedRevision) {
        break; // gap: wait for the next pull
      }
      await this.applier.applyChange({ type: change.type as Change['type'], node_id: change.nodeId, payload: change.payload as Change['payload'] });
      await this.store.confirmApplied(this.bindingId, change.revision);
      applied++;
    }
    await this.store.settlePass(this.bindingId);
    return applied;
  }

  private async binding() {
    const binding = await this.store.getBinding(this.bindingId);
    if (!binding) {
      throw new Error(`coordinator: unknown binding ${this.bindingId}`);
    }
    return binding;
  }
}
