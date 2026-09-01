// Event Processor (doc 05 §5/§8/§9): turns captured browser events into
// either an expected-mutation match (remote origin → mirror only, no local
// op) or a local user operation (mirror + pending op in ONE transaction).
// Event capture never pauses (doc 05 §13 / doc 22 B.12).

import type { BrowserAdapter, BrowserEvent, BrowserNode } from '../browser/types';
import { collectSubtree, logDiagnostic, type BindingRecord, type LocalNodeRecord, type PontisDB, type PendingOpRecord } from '../store/db';
import type { ParentRefWire } from '../protocol/types';
import { uuidv7 } from '../util/ids';

export type EventDisposition = 'expected' | 'local-op' | 'ignored';

export class EventProcessor {
  constructor(
    private db: PontisDB,
    private adapter: BrowserAdapter,
  ) {}

  async handleEvent(bindingId: string, event: BrowserEvent): Promise<EventDisposition> {
    const binding = await this.db.bindings.get(bindingId);
    // Event capture never pauses (doc 05 §13): 'initializing' keeps
    // processing so reconciliation-time user intent is not dropped.
    if (!binding || (binding.state !== 'active' && binding.state !== 'initializing')) {
      return 'ignored';
    }
    switch (event.kind) {
      case 'created':
        return this.handleCreated(binding, event.node);
      case 'changed':
        return this.handleChanged(binding, event.node);
      case 'moved':
        return this.handleMoved(binding, event.node);
      case 'removed':
        return this.handleRemoved(binding, event.node);
    }
  }

  // --- created ---

  private async handleCreated(binding: BindingRecord, node: BrowserNode): Promise<EventDisposition> {
    if (node.parentId == null || !(await this.isManagedScope(binding, node.parentId))) {
      return 'ignored';
    }

    // Expected remote mutation? Provisional create expectations are
    // resolved by the browser event carrying the new browser id.
    const provisional = await this.db.expectedMutations
      .where('[bindingId+kind]')
      .equals([binding.id, 'create'])
      .filter(
        (e) =>
          e.browserId == null &&
          e.parentBrowserId === node.parentId &&
          e.title === node.title &&
          (e.url ?? null) === node.url,
      )
      .toArray();
    if (provisional.length === 1) {
      const exp = provisional[0]!;
      await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
        await this.db.expectedMutations.delete(exp.id!);
        await this.db.localNodes.put({
          bindingId: binding.id,
          browserId: node.id,
          canonicalId: exp.canonicalId,
          type: node.type,
          title: node.title,
          url: node.url,
          parentBrowserId: node.parentId,
          position: exp.position ?? null,
        });
      });
      return 'expected';
    }
    if (provisional.length > 1) {
      // Ambiguity: never guess (doc 05 §9) — leave it to reconciliation.
      await logDiagnostic(this.db, 'warn', 'event-processor', 'ambiguous create expectation, skipped', {
        bindingId: binding.id,
        node,
      });
      return 'ignored';
    }

    const parentRef = await this.canonicalParentRef(binding, node.parentId);
    if (!parentRef) {
      await logDiagnostic(this.db, 'warn', 'event-processor', 'local create under unmapped parent, skipped', {
        bindingId: binding.id,
        node,
      });
      return 'ignored';
    }
    const beforeId = await this.nextSiblingCanonicalId(binding, node.parentId, node.index);

    // Rule 1 (doc 05 §16): mirror + pending op share one IDB transaction.
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      const clientSeq = b.clientSeq + 1;
      await this.db.localNodes.put({
        bindingId: b.id,
        browserId: node.id,
        canonicalId: null,
        type: node.type,
        title: node.title,
        url: node.url,
        parentBrowserId: node.parentId,
        position: null,
      });
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId: b.id,
        clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'create',
        nodeId: '',
        nodeType: node.type,
        title: node.title,
        url: node.url ?? undefined,
        parent: parentRef,
        beforeId,
        browserId: node.id,
        createdAt: Date.now(),
      });
      b.clientSeq = clientSeq;
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  // --- changed ---

  private async handleChanged(binding: BindingRecord, node: BrowserNode): Promise<EventDisposition> {
    if (!(await this.isManagedScope(binding, node.id))) return 'ignored';
    const mirror = await this.db.localNodes.get([binding.id, node.id]);

    // Expected title/url mutation match (doc 05 §8).
    if (mirror?.canonicalId) {
      const expectations = await this.db.expectedMutations.where('bindingId').equals(binding.id).toArray();
      const matches = expectations.filter(
        (e) =>
          e.browserId === node.id &&
          e.canonicalId === mirror.canonicalId &&
          ((e.kind === 'update_title' && e.title === node.title) ||
            (e.kind === 'update_url' && (e.url ?? null) === node.url)),
      );
      if (matches.length > 0) {
        await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
          await this.db.expectedMutations.bulkDelete(matches.map((e) => e.id!));
          await this.db.localNodes.put({ ...mirror, title: node.title, url: node.url });
        });
        return 'expected';
      }
    }

    if (!mirror) return 'ignored';

    // Create not acked yet: edit the still-QUEUED create op in place.
    if (mirror.canonicalId == null) {
      const queuedCreate = await this.db.pendingOps
        .where('[bindingId+status]')
        .equals([binding.id, 'QUEUED'])
        .filter((o) => o.browserId === node.id && o.type === 'create')
        .first();
      await this.db.transaction('rw', [this.db.localNodes, this.db.pendingOps], async () => {
        if (queuedCreate) {
          queuedCreate.title = node.title;
          queuedCreate.url = node.url ?? undefined;
          await this.db.pendingOps.put(queuedCreate);
        }
        await this.db.localNodes.put({ ...mirror, title: node.title, url: node.url });
      });
      if (!queuedCreate) {
        await logDiagnostic(this.db, 'warn', 'event-processor', 'change on unmapped local node dropped', {
          bindingId: binding.id,
          node,
        });
        return 'ignored';
      }
      return 'local-op';
    }

    // One field per operation (doc 22 A). Diff against the mirror so we
    // never re-send a value the server already has.
    const updates: Array<{ type: 'update_title' | 'update_url'; title?: string; url?: string }> = [];
    if (node.title !== mirror.title) updates.push({ type: 'update_title', title: node.title });
    if ((node.url ?? null) !== mirror.url) updates.push({ type: 'update_url', url: node.url ?? '' });
    if (updates.length === 0) return 'ignored';

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      for (const u of updates) {
        b.clientSeq += 1;
        await this.db.pendingOps.add({
          opId: uuidv7(),
          bindingId: b.id,
          clientSeq: b.clientSeq,
          baseRevision: b.appliedRevision,
          status: 'QUEUED',
          type: u.type,
          nodeId: mirror.canonicalId!,
          title: u.title,
          url: u.url,
          createdAt: Date.now(),
        });
      }
      await this.db.localNodes.put({ ...mirror, title: node.title, url: node.url });
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  // --- moved ---

  private async handleMoved(binding: BindingRecord, node: BrowserNode): Promise<EventDisposition> {
    if (node.parentId == null) return 'ignored';
    if (!(await this.isManagedScope(binding, node.id))) return 'ignored';
    const mirror = await this.db.localNodes.get([binding.id, node.id]);

    // Expected move (doc 05 §8): match on canonical id + target parent.
    if (mirror?.canonicalId) {
      const expectations = await this.db.expectedMutations
        .where('[bindingId+kind]')
        .equals([binding.id, 'move'])
        .filter((e) => e.canonicalId === mirror.canonicalId && e.parentBrowserId === node.parentId)
        .toArray();
      if (expectations.length === 1) {
        // Mirror update is the applier's job; only consume the expectation
        // (deleting here is idempotent with the applier's own cleanup).
        await this.db.expectedMutations.delete(expectations[0]!.id!);
        return 'expected';
      }
    }

    if (!mirror) return 'ignored';

    // Create not acked yet: retarget the queued create op in place.
    if (mirror.canonicalId == null) {
      const queuedCreate = await this.db.pendingOps
        .where('[bindingId+status]')
        .equals([binding.id, 'QUEUED'])
        .filter((o) => o.browserId === node.id && o.type === 'create')
        .first();
      if (!queuedCreate?.parent) return 'ignored';
      const parentRef = await this.canonicalParentRef(binding, node.parentId);
      if (!parentRef) return 'ignored';
      const beforeId = await this.nextSiblingCanonicalId(binding, node.parentId, node.index);
      await this.db.transaction('rw', [this.db.localNodes, this.db.pendingOps], async () => {
        queuedCreate.parent = parentRef;
        queuedCreate.beforeId = beforeId;
        await this.db.pendingOps.put(queuedCreate);
        await this.db.localNodes.put({ ...mirror, parentBrowserId: node.parentId, position: null });
      });
      return 'local-op';
    }

    const parentRef = await this.canonicalParentRef(binding, node.parentId);
    if (!parentRef) {
      await logDiagnostic(this.db, 'warn', 'event-processor', 'local move to unmapped parent, skipped', {
        bindingId: binding.id,
        node,
      });
      return 'ignored';
    }
    const beforeId = await this.nextSiblingCanonicalId(binding, node.parentId, node.index);

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      const clientSeq = b.clientSeq + 1;
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId: b.id,
        clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'move',
        nodeId: mirror.canonicalId!,
        parent: parentRef,
        beforeId,
        browserId: node.id,
        createdAt: Date.now(),
      });
      await this.db.localNodes.put({ ...mirror, parentBrowserId: node.parentId, position: null });
      b.clientSeq = clientSeq;
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  // --- removed ---

  private async handleRemoved(binding: BindingRecord, node: BrowserNode): Promise<EventDisposition> {
    // Mount root deletion is not a canonical DELETE (doc 03 §5).
    if (binding.mount.mode === 'partial' && node.id === binding.mount.folderBrowserId) {
      await this.db.bindings.update(binding.id, { state: 'mount_missing' });
      await logDiagnostic(this.db, 'warn', 'event-processor', 'mount root deleted; binding paused as mount_missing', {
        bindingId: binding.id,
      });
      return 'ignored';
    }
    if (binding.mount.mode === 'full' && binding.mount.roots) {
      if (Object.values(binding.mount.roots).includes(node.id)) {
        await this.db.bindings.update(binding.id, { state: 'mount_missing' });
        return 'ignored';
      }
    }
    if (!(await this.isManagedScope(binding, node.id))) return 'ignored';

    const mirror = await this.db.localNodes.get([binding.id, node.id]);

    // Expected delete (doc 05 §8).
    if (mirror?.canonicalId) {
      const expectations = await this.db.expectedMutations
        .where('[bindingId+kind]')
        .equals([binding.id, 'delete'])
        .filter((e) => e.browserId === node.id)
        .toArray();
      if (expectations.length === 1) {
        await this.db.transaction('rw', [this.db.localNodes, this.db.expectedMutations], async () => {
          await this.db.expectedMutations.delete(expectations[0]!.id!);
          await this.deleteMirrorSubtree(binding.id, node.id);
        });
        return 'expected';
      }
    }

    if (!mirror) return 'ignored';
    const subtree = await collectSubtree(this.db, binding.id, node.id);

    // Create not acked yet: the node never existed server-side; drop the
    // queued create and the local mirrors.
    if (mirror.canonicalId == null) {
      await this.db.transaction('rw', [this.db.localNodes, this.db.pendingOps], async () => {
        const queuedCreate = await this.db.pendingOps
          .where('[bindingId+status]')
          .equals([binding.id, 'QUEUED'])
          .filter((o) => o.browserId === node.id && o.type === 'create')
          .first();
        if (queuedCreate) await this.db.pendingOps.delete(queuedCreate.opId);
        await this.deleteMirrorSubtree(binding.id, node.id);
      });
      return 'ignored';
    }

    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      const clientSeq = b.clientSeq + 1;
      await this.db.pendingOps.add({
        opId: uuidv7(),
        bindingId: b.id,
        clientSeq,
        baseRevision: b.appliedRevision,
        status: 'QUEUED',
        type: 'delete',
        nodeId: mirror.canonicalId!,
        browserId: node.id,
        createdAt: Date.now(),
      });
      await this.deleteMirrorSubtree(binding.id, node.id);
      b.clientSeq = clientSeq;
      await this.db.bindings.put(b);
    });
    return 'local-op';
  }

  // --- helpers ---

  private async deleteMirrorSubtree(bindingId: string, browserId: string): Promise<void> {
    const subtree = await collectSubtree(this.db, bindingId, browserId);
    await this.db.localNodes.bulkDelete(subtree.map((r) => [bindingId, r.browserId] as [string, string]));
  }

  /**
   * Managed scope check (doc 03): full mode owns the whole profile tree;
   * partial mode owns the mount folder subtree. Walks up via the mirror.
   */
  private async isManagedScope(binding: BindingRecord, browserId: string | null): Promise<boolean> {
    if (browserId == null) return false;
    if (binding.mount.mode === 'full') return true;
    const mountId = binding.mount.folderBrowserId;
    if (!mountId) return false;
    let cur: string | null = browserId;
    for (let i = 0; i < 64 && cur != null; i++) {
      if (cur === mountId) return true;
      const row: LocalNodeRecord | undefined = await this.db.localNodes.get([binding.id, cur]);
      if (!row) return false;
      cur = row.parentBrowserId;
    }
    return false;
  }

  /** Canonical parent ref for a browser parent (root slot or mapped node). */
  private async canonicalParentRef(binding: BindingRecord, parentBrowserId: string): Promise<ParentRefWire | null> {
    const mount = binding.mount;
    if (mount.mode === 'partial' && parentBrowserId === mount.folderBrowserId) {
      return { type: 'root', key: mount.rootKey };
    }
    if (mount.mode === 'full' && mount.roots) {
      for (const [key, browserId] of Object.entries(mount.roots)) {
        if (browserId === parentBrowserId) return { type: 'root', key };
      }
    }
    const parent = await this.db.localNodes.get([binding.id, parentBrowserId]);
    if (parent?.canonicalId) return { type: 'node', id: parent.canonicalId };
    return null;
  }

  /**
   * after_id → before_id translation (doc 05 §12): find the next syncable
   * canonical sibling after the moved node's browser index; null = append.
   */
  private async nextSiblingCanonicalId(
    binding: BindingRecord,
    parentBrowserId: string,
    index: number,
  ): Promise<string | null> {
    const children = await this.adapter.getChildren(parentBrowserId);
    for (const child of children) {
      if (child.index <= index) continue;
      const m = await this.db.localNodes.get([binding.id, child.id]);
      if (m?.canonicalId) return m.canonicalId;
    }
    return null;
  }
}

export type { PendingOpRecord };
