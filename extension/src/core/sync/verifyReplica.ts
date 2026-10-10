// Replica verification (doc 06 §14, doc 05 §14): rescan the managed scope and
// compare the browser against the local mirror.
//
// This is the client's side of the sync contract, not a second authority over
// it. Deciding what a browser tree should become is the server's reconciliation
// engine (doc 07/08); everything here answers a narrower question — does the
// browser actually hold what this device says it holds — and repairs drift that
// event capture missed by queueing ordinary ops. Nodes only this browser has
// still go up through the outbox, one level per pass, because a nested subtree
// cannot name a canonical parent until its own create is acked.

import { type BrowserAdapter, type BrowserNode } from '../browser/types';
import { logDiagnostic, type BindingRecord, type LocalNodeRecord, type PendingOpRecord, type PontisDB } from '../store/db';
import type { ChangeWire, NodeType, ParentRefWire } from '../protocol/types';
import { uuidv7 } from '../util/ids';
import { snapshotBrowserTree, type BrowserSnapshotNode } from './browserSnapshot';
import { canonicalChildren, replayChanges, type CanonicalTree } from './canonicalTree';
import type { SyncCoordinator } from './syncCoordinator';

const MAX_QUIESCE_ROUNDS = 64;

export interface VerifyProblem {
  kind: 'missing_mirror' | 'orphan_mirror' | 'field_mismatch' | 'order_drift';
  browserId?: string;
  canonicalId?: string;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  problems: VerifyProblem[];
}

export class ReplicaVerifier {
  constructor(
    private db: PontisDB,
    private adapter: BrowserAdapter,
    private coordinator: SyncCoordinator,
  ) {}







  // --- level-by-level upload ---

  /**
   * Enqueue a create for this node when its parent is already mapped and
   * the node is neither mapped nor captured by the event pipeline.
   * Returns 1 when enqueued. Children are handled by later passes once
   * this node's create is acked and adopted.
   */
  private async uploadNode(bindingId: string, node: BrowserSnapshotNode): Promise<number> {
    if (await this.shouldSkipUpload(bindingId, node.node.id)) {
      // Already mapped: its children may be uploadable right away.
      let count = 0;
      for (const child of node.children) count += await this.uploadNode(bindingId, child);
      return count;
    }
    const parentRef = await this.canonicalParentRef(bindingId, node.node.parentId);
    if (!parentRef) return 0; // parent not mapped yet; later pass
    await this.enqueueCreate(bindingId, {
      nodeType: node.node.type,
      title: node.node.title,
      url: node.node.url ?? '',
      parent: parentRef,
      browserId: node.node.id,
    });
    return 1;
  }

  /** Nodes already mapped or already captured by the event pipeline. */
  private async shouldSkipUpload(bindingId: string, browserId: string): Promise<boolean> {
    const mirror = await this.db.localNodes.get([bindingId, browserId]);
    if (mirror?.canonicalId) return true;
    const pending = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .filter((o) => o.browserId === browserId)
      .first();
    return pending != null || mirror != null;
  }



  // --- quiesce + verify ---

  /** Drive sync rounds + upload passes until no work remains. */
  private async quiesceLoop(bindingId: string): Promise<void> {
    for (let i = 0; i < MAX_QUIESCE_ROUNDS; i++) {
      await this.coordinator.syncBinding(bindingId);
      if ((await this.uploadPassAll(bindingId)) === 0 && (await this.isQuiescent(bindingId))) return;
    }
    await logDiagnostic(this.db, 'warn', 'verify', 'quiesce budget exhausted', { bindingId });
  }

  private async uploadPassAll(bindingId: string): Promise<number> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || binding.mount.mode !== 'partial' || !binding.mount.folderBrowserId) return 0;
    const snap = await snapshotBrowserTree(this.adapter, binding.mount.folderBrowserId);
    let count = 0;
    for (const top of snap.children) count += await this.uploadNode(bindingId, top);
    return count;
  }

  private async isQuiescent(bindingId: string): Promise<boolean> {
    return isQuiescent(this.db, bindingId);
  }

  /**
   * Rescan the managed scope and compare browser ↔ mirror. Missing
   * mirrors and field drift are repaired once via targeted ops
   * (PROCESS_DEFERRED_LOCAL_CHANGES, doc 06 §13); whatever still
   * diverges fails verification.
   */
  async verifyAndRepair(bindingId: string): Promise<VerifyReport> {
    const binding = await this.mustGetBinding(bindingId);
    if (binding.mount.mode === 'partial' && binding.mount.folderBrowserId) {
      const snap = await snapshotBrowserTree(this.adapter, binding.mount.folderBrowserId);
      const mirrors = new Map(
        (await this.db.localNodes.where('bindingId').equals(bindingId).toArray()).map((m) => [m.browserId, m]),
      );
      const queue: BrowserSnapshotNode[] = [...snap.children];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        queue.push(...cur.children);
        const mirror = mirrors.get(cur.node.id);
        if (!mirror) continue; // repaired by uploadPass below
        if (mirror.canonicalId == null) continue; // upload still in flight
        if (cur.node.title !== mirror.title) {
          await this.enqueueOp(bindingId, { type: 'update_title', nodeId: mirror.canonicalId, title: cur.node.title });
        }
        if ((cur.node.url ?? null) !== mirror.url) {
          await this.enqueueOp(bindingId, { type: 'update_url', nodeId: mirror.canonicalId, url: cur.node.url ?? '' });
        }
      }
      await this.uploadPassAll(bindingId);
      await this.quiesceLoop(bindingId);
    }
    return this.verifyScan(bindingId);
  }

  /**
   * Read-only integrity scan (doc 05 §14): browser ↔ mirror drift
   * classification without side effects; also the verify half of
   * verifyAndRepair.
   */
  async verifyScan(bindingId: string): Promise<VerifyReport> {
    const binding = await this.mustGetBinding(bindingId);
    const snap = await snapshotBrowserTree(this.adapter, this.mountRootId(binding));
    const mirrors = await this.db.localNodes.where('bindingId').equals(bindingId).toArray();
    const byBrowser = new Map(mirrors.map((m) => [m.browserId, m]));
    const problems: VerifyProblem[] = [];

    const queue: BrowserSnapshotNode[] = [...snap.children];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      queue.push(...cur.children);
      const mirror = byBrowser.get(cur.node.id);
      if (!mirror) {
        problems.push({ kind: 'missing_mirror', browserId: cur.node.id });
        continue;
      }
      if (mirror.canonicalId == null) {
        problems.push({ kind: 'missing_mirror', browserId: cur.node.id, detail: 'unmapped after apply' });
        continue;
      }
      if (cur.node.title !== mirror.title || (cur.node.url ?? null) !== mirror.url) {
        problems.push({ kind: 'field_mismatch', browserId: cur.node.id, canonicalId: mirror.canonicalId });
      }
    }

    for (const m of mirrors) {
      if (!m.browserId) continue;
      const node = await this.adapter.getNode(m.browserId);
      if (!node && m.browserId !== this.mountRootId(binding)) {
        problems.push({ kind: 'orphan_mirror', browserId: m.browserId, canonicalId: m.canonicalId ?? undefined });
      }
    }

    // Order drift is advisory only: sibling reorder may be genuine local
    // intent that the next sync round propagates.
    problems.push(...(await this.orderDrift(bindingId, binding, mirrors, snap)));

    return { ok: !problems.some((p) => p.kind !== 'order_drift'), problems };
  }

  private async orderDrift(
    bindingId: string,
    binding: BindingRecord,
    mirrors: LocalNodeRecord[],
    snap: BrowserSnapshotNode,
  ): Promise<VerifyProblem[]> {
    const tree = await this.replayInbox(bindingId);
    const mapped = mirrors.filter((m) => m.canonicalId);
    const canonicalToBrowser = new Map(mapped.map((m) => [m.canonicalId!, m.browserId]));
    const browserToCanonical = new Map(mapped.map((m) => [m.browserId, m.canonicalId!]));
    const problems: VerifyProblem[] = [];

    const checkLevel = async (parent: BrowserSnapshotNode, canonicalParent: ParentRefWire): Promise<void> => {
      const canonicalOrder = canonicalChildren(tree, canonicalParent)
        .map((c) => canonicalToBrowser.get(c.id))
        .filter((id): id is string => id != null);
      const browserOrder = parent.children
        .map((c) => c.node.id)
        .filter((id) => browserToCanonical.has(id) && canonicalOrder.includes(id));
      for (let i = 0; i < Math.min(canonicalOrder.length, browserOrder.length); i++) {
        if (canonicalOrder[i] !== browserOrder[i]) {
          problems.push({
            kind: 'order_drift',
            browserId: parent.node.id,
            detail: `canonical ${canonicalOrder[i]} vs browser ${browserOrder[i]}`,
          });
          break;
        }
      }
      for (const child of parent.children) {
        if (child.node.type !== 'folder') continue;
        const canonicalId = browserToCanonical.get(child.node.id);
        if (canonicalId) {
          await checkLevel(child, { type: 'node', id: canonicalId });
        }
      }
    };
    await checkLevel(snap, { type: 'root', key: binding.mount.rootKey });
    return problems;
  }


  private async replayInbox(bindingId: string): Promise<CanonicalTree> {
    const rows = await this.db.remoteChanges.where('bindingId').equals(bindingId).sortBy('revision');
    const changes: ChangeWire[] = rows.map((r) => ({
      revision: r.revision,
      type: r.type,
      node_id: r.nodeId,
      payload: r.payload as ChangeWire['payload'],
    }));
    return replayChanges(changes);
  }




  // --- outbox helpers ---

  private async enqueueCreate(
    bindingId: string,
    create: {
      nodeType: NodeType;
      title: string;
      url: string;
      parent: ParentRefWire;
      browserId?: string;
      /** Keep the op after settle: the import queue needs its result. */
      keepResolved?: boolean;
    },
  ): Promise<string> {
    const opId = uuidv7();
    await this.db.transaction('rw', [this.db.bindings, this.db.pendingOps, this.db.localNodes], async () => {
      const b = await this.db.bindings.get(bindingId);
      if (!b) return;
      b.clientSeq += 1;
      const record: PendingOpRecord = {
        opId,
        bindingId,
        clientSeq: b.clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'create',
        // Client-assigned canonical id (doc 04): an empty one would land a
        // node no device can ever address again.
        nodeId: uuidv7(),
        nodeType: create.nodeType,
        title: create.title,
        url: create.url || undefined,
        parent: create.parent,
        beforeId: null,
        browserId: create.browserId,
        keepResolved: create.keepResolved,
        createdAt: Date.now(),
      };
      await this.db.pendingOps.add(record);
      // Mirror with null canonical id: the ack回流 adopts this node via
      // tryAdoptLocalCreate instead of creating a browser duplicate.
      if (create.browserId) {
        await this.db.localNodes.put({
          bindingId,
          browserId: create.browserId,
          canonicalId: null,
          type: create.nodeType,
          title: create.title,
          url: create.url || null,
          parentBrowserId: null,
          position: null,
        });
      }
      await this.db.bindings.put(b);
    });
    return opId;
  }

  private async enqueueOp(
    bindingId: string,
    op: { type: PendingOpRecord['type']; nodeId: string; title?: string; url?: string },
  ): Promise<void> {
    await this.db.transaction('rw', [this.db.bindings, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(bindingId);
      if (!b) return;
      b.clientSeq += 1;
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId,
        clientSeq: b.clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: op.type,
        nodeId: op.nodeId,
        title: op.title,
        url: op.url,
        createdAt: Date.now(),
      });
      await this.db.bindings.put(b);
    });
  }

  // --- misc helpers ---

  private async canonicalParentRef(bindingId: string, parentBrowserId: string | null): Promise<ParentRefWire | null> {
    if (parentBrowserId == null) return null;
    const binding = await this.mustGetBinding(bindingId);
    if (binding.mount.mode === 'partial' && parentBrowserId === binding.mount.folderBrowserId) {
      return { type: 'root', key: binding.mount.rootKey };
    }
    const parent = await this.db.localNodes.get([bindingId, parentBrowserId]);
    if (parent?.canonicalId) return { type: 'node', id: parent.canonicalId };
    return null;
  }

  private mountRootId(binding: BindingRecord): string {
    if (binding.mount.mode === 'partial') {
      if (!binding.mount.folderBrowserId) throw new Error('verify: partial binding has no mount folder');
      return binding.mount.folderBrowserId;
    }
    const first = Object.values(binding.mount.roots ?? {})[0];
    if (!first) throw new Error('verify: full binding has no roots');
    return first;
  }

  private async mustGetBinding(bindingId: string): Promise<BindingRecord> {
    const b = await this.db.bindings.get(bindingId);
    if (!b) throw new Error(`verify: binding ${bindingId} vanished`);
    return b;
  }

}

/** No queued ops, no unapplied inbox rows, watermarks level. */
export async function isQuiescent(db: PontisDB, bindingId: string): Promise<boolean> {
  const b = await db.bindings.get(bindingId);
  if (!b) return true;
  if (b.appliedRevision !== b.receivedRevision) return false;
  const queued = await db.pendingOps.where('[bindingId+status]').equals([bindingId, 'QUEUED']).count();
  if (queued > 0) return false;
  const unapplied = await db.remoteChanges
    .where('[bindingId+revision]')
    .between([bindingId, b.appliedRevision + 1], [bindingId, Number.MAX_SAFE_INTEGER], true, true)
    .count();
  return unapplied === 0;
}

export type { BrowserNode };
