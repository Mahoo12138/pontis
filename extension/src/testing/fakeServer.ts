// Stateful fake /sync server for engine tests: applies operations to an
// in-memory journal (mirroring server semantics closely enough for the
// client pipeline: APPLIED results, journal回流, paging), and exposes
// helpers to seed a canonical history deterministically.

import { ApiError, type SyncTransport, type SnapshotTransport } from '../core/transport/client';
import {
  type ChangeWire,
  type OperationWire,
  type ParentRefWire,
  type SnapshotNodeWire,
  type SnapshotWire,
  type SyncRequestWire,
  type SyncResponseWire,
} from '../core/protocol/types';
import { parentKey, replayChanges } from '../core/sync/canonicalTree';

export class FakeServerTransport implements SyncTransport, SnapshotTransport {
  epoch = 1;
  floor = 0;
  revision = 0;
  journal: ChangeWire[] = [];
  /** When set, the next sync call throws this protocol error. */
  protocolError: ApiError | null = null;

  private maxPosition = new Map<string, number>();

  async sync(_bindingId: string, req: SyncRequestWire): Promise<SyncResponseWire> {
    if (this.protocolError) {
      const err = this.protocolError;
      this.protocolError = null;
      throw err;
    }
    if (req.epoch !== this.epoch) {
      throw new ApiError(409, 'EPOCH_MISMATCH', 'canonical epoch changed');
    }
    if (req.received_revision < this.floor) {
      throw new ApiError(409, 'HISTORY_EXPIRED', 'incremental history has been garbage collected');
    }

    const results = [];
    for (const op of req.operations) {
      this.revision += 1;
      results.push({
        op_id: op.op_id,
        client_seq: op.client_seq,
        status: 'APPLIED' as const,
        reason: '',
        result_revision: this.revision,
        settle_after_revision: this.revision,
      });
      this.journal.push(this.opToChange(op, this.revision));
    }

    const page = this.journal
      .filter((c) => c.revision > req.received_revision)
      .slice(0, Math.max(1, req.max_changes));
    const through = page.length > 0 ? page[page.length - 1]!.revision : req.received_revision;
    const has_more = this.journal.some((c) => c.revision > through);
    return {
      protocol_version: 1,
      epoch: this.epoch,
      journal_floor_revision: this.floor,
      from_revision: req.received_revision + 1,
      through_revision: through,
      server_revision: this.revision,
      has_more,
      operation_results: results,
      changes: page,
    };
  }

  /** Read-only snapshot of the current canonical tree (doc 06 §8). */
  async fetchSnapshot(_bindingId: string): Promise<SnapshotWire> {
    const tree = replayChanges(this.journal);
    const nodes: SnapshotNodeWire[] = [...tree.nodes.values()].map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      url: n.url || undefined,
      parent: n.parent,
      position: n.position,
    }));
    return {
      protocol_version: 1,
      epoch: this.epoch,
      snapshot_revision: this.revision,
      journal_floor_revision: this.floor,
      nodes,
    };
  }

  /** Seed a canonical change directly into the journal. */
  seed(change: Omit<ChangeWire, 'revision'>): ChangeWire {
    this.revision += 1;
    if (change.type === 'create') {
      const p = change.payload as { parent: ParentRefWire; position: number };
      this.bumpPosition(p.parent, p.position);
    }
    const full: ChangeWire = { ...change, revision: this.revision };
    this.journal.push(full);
    return full;
  }

  private opToChange(op: OperationWire, revision: number): ChangeWire {
    switch (op.type) {
      case 'create': {
        const parent = op.parent ?? { type: 'root' as const, key: 'main' };
        const position = this.nextPosition(parent);
        return {
          revision,
          type: 'create',
          node_id: `srv-${revision}`,
          payload: { type: op.node_type ?? 'bookmark', title: op.title ?? '', url: op.url ?? '', parent, position },
        };
      }
      case 'move':
        return {
          revision,
          type: 'move',
          node_id: op.node_id,
          payload: { parent: op.parent ?? { type: 'root', key: 'main' }, position: 0 },
        };
      case 'update_title':
        return { revision, type: 'update_title', node_id: op.node_id, payload: { title: op.title ?? '' } };
      case 'update_url':
        return { revision, type: 'update_url', node_id: op.node_id, payload: { url: op.url ?? '' } };
      case 'delete':
        return { revision, type: 'delete', node_id: op.node_id, payload: { count: 1 } };
    }
  }

  private nextPosition(parent: ParentRefWire): number {
    const key = parentKey(parent);
    const next = (this.maxPosition.get(key) ?? -1) + 1;
    this.maxPosition.set(key, next);
    return next;
  }

  private bumpPosition(parent: ParentRefWire, position: number): void {
    const key = parentKey(parent);
    this.maxPosition.set(key, Math.max(this.maxPosition.get(key) ?? -1, position));
  }
}
