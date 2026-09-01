// Remote Change Applier (doc 05 §7-§11): applies canonical changes to the
// browser strictly serially, with ensure-state idempotency:
//   1. skip if the target state is already satisfied;
//   2. persist the expected mutation BEFORE calling the browser API;
//   3. apply via the Browser Adapter;
//   4. commit mirror updates + applied_revision advance in one transaction.
// A crash anywhere leaves either a resolvable expectation or a satisfied
// ensure-state check, never a duplicated mutation.

import type { BrowserAdapter, BrowserNode } from '../browser/types';
import {
  collectSubtree,
  findMirrorByCanonical,
  logDiagnostic,
  type BindingRecord,
  type ExpectedMutationRecord,
  type LocalNodeRecord,
  type PontisDB,
} from '../store/db';
import {
  asCreatePayload,
  asDeletePayload,
  asMovePayload,
  asUpdateTitlePayload,
  asUpdateURLPayload,
  type ChangeWire,
  type ParentRefWire,
} from '../protocol/types';

export class RemoteChangeApplier {
  constructor(
    private db: PontisDB,
    private adapter: BrowserAdapter,
  ) {}

  /** Apply one canonical change. Caller guarantees revision order. */
  async applyChange(bindingId: string, change: ChangeWire): Promise<void> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding) throw new Error(`applyChange: unknown binding ${bindingId}`);
    if (change.revision !== binding.appliedRevision + 1) {
      throw new Error(
        `applyChange: non-contiguous revision ${change.revision} (applied ${binding.appliedRevision})`,
      );
    }

    switch (change.type) {
      case 'create': {
        const p = asCreatePayload(change.payload);
        if (!p) throw new Error(`applyChange: bad create payload at revision ${change.revision}`);
        await this.applyCreate(binding, change, p);
        return;
      }
      case 'update_title': {
        const p = asUpdateTitlePayload(change.payload);
        if (!p) throw new Error(`applyChange: bad update_title payload at revision ${change.revision}`);
        await this.applyUpdateField(binding, change, { title: p.title });
        return;
      }
      case 'update_url': {
        const p = asUpdateURLPayload(change.payload);
        if (!p) throw new Error(`applyChange: bad update_url payload at revision ${change.revision}`);
        await this.applyUpdateField(binding, change, { url: p.url });
        return;
      }
      case 'move': {
        const p = asMovePayload(change.payload);
        if (!p) throw new Error(`applyChange: bad move payload at revision ${change.revision}`);
        await this.applyMove(binding, change, p);
        return;
      }
      case 'delete': {
        const p = asDeletePayload(change.payload);
        if (!p) throw new Error(`applyChange: bad delete payload at revision ${change.revision}`);
        await this.applyDelete(binding, change);
        return;
      }
    }
  }

  /**
   * Recovery after a crash between "browser API succeeded" and "mirror
   * transaction committed" (doc 05 §10): probe the browser, resolve
   * provisional expectations, repair mirrors, advance watermarks.
   */
  async recover(bindingId: string): Promise<void> {
    const expectations = await this.db.expectedMutations.where('bindingId').equals(bindingId).toArray();
    for (const exp of expectations) {
      const binding = await this.db.bindings.get(bindingId);
      if (!binding) return;
      if (exp.kind === 'create') {
        if (exp.browserId) {
          await this.commitResolved(binding, exp);
          continue;
        }
        // Provisional: look for an unmapped browser node matching the
        // expected parent + title + url. Exactly one → adopt.
        const children = exp.parentBrowserId ? await this.adapter.getChildren(exp.parentBrowserId) : [];
        const candidates: BrowserNode[] = [];
        for (const c of children) {
          const mapped = await this.db.localNodes.get([bindingId, c.id]);
          if (!mapped && c.title === exp.title && (c.url ?? null) === (exp.url ?? null)) {
            candidates.push(c);
          }
        }
        if (candidates.length === 1) {
          await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.expectedMutations], async () => {
            const b = await this.db.bindings.get(bindingId);
            if (!b) return;
            await this.db.expectedMutations.delete(exp.id!);
            await this.db.localNodes.put({
              bindingId,
              browserId: candidates[0]!.id,
              canonicalId: exp.canonicalId,
              type: candidates[0]!.type,
              title: candidates[0]!.title,
              url: candidates[0]!.url,
              parentBrowserId: candidates[0]!.parentId,
              position: exp.position ?? null,
            });
            await this.advanceApplied(b, exp.revision);
          });
        } else {
          await logDiagnostic(this.db, 'warn', 'applier', 'unresolved create expectation needs reconciliation', {
            bindingId,
            exp,
          });
        }
        continue;
      }

      const mirror = await findMirrorByCanonical(this.db, bindingId, exp.canonicalId);
      if (!mirror?.browserId) {
        // Nothing to verify against; drop the stale expectation.
        await this.db.expectedMutations.delete(exp.id!);
        await this.advanceTo(bindingId, exp.revision);
        continue;
      }
      const node = await this.adapter.getNode(mirror.browserId);
      let satisfied = false;
      if (exp.kind === 'delete') {
        satisfied = node == null;
      } else if (node) {
        if (exp.kind === 'move') {
          satisfied = node.parentId === exp.parentBrowserId;
        } else if (exp.kind === 'update_title') {
          satisfied = node.title === exp.title;
        } else if (exp.kind === 'update_url') {
          satisfied = node.url === (exp.url ?? null);
        }
      }
      if (satisfied) {
        await this.commitResolved(binding, exp, node ?? undefined);
      } else {
        // Not satisfied: leave the expectation; the next incremental round
        // re-applies through the normal ensure-state path.
        await logDiagnostic(this.db, 'info', 'applier', 'recovery: expectation not satisfied, will re-apply', {
          bindingId,
          exp,
        });
      }
    }
  }

  // --- create ---

  private async applyCreate(
    binding: BindingRecord,
    change: ChangeWire,
    payload: { type: 'folder' | 'bookmark'; title: string; url: string; parent: ParentRefWire; position: number },
  ): Promise<void> {
    const parentBrowserId = await this.resolveParentBrowser(binding, payload.parent);
    if (!parentBrowserId) {
      // Parent not mapped: mapping loss. Do not silently CREATE elsewhere;
      // advance past the change and record for reconciliation.
      await logDiagnostic(this.db, 'warn', 'applier', 'create with unmapped parent skipped', {
        bindingId: binding.id,
        change,
      });
      await this.advanceTo(binding.id, change.revision);
      return;
    }

    // Ensure-state: already satisfied?
    const existing = await findMirrorByCanonical(this.db, binding.id, change.node_id);
    if (existing && existing.parentBrowserId === parentBrowserId && existing.title === payload.title) {
      await this.advanceTo(binding.id, change.revision);
      return;
    }

    // Rule 2 (doc 05 §16): expectation BEFORE the browser API. Create is
    // provisional — the browser id is unknown until the event arrives.
    const exp: ExpectedMutationRecord = {
      bindingId: binding.id,
      revision: change.revision,
      kind: 'create',
      canonicalId: change.node_id,
      browserId: null,
      parentBrowserId,
      position: payload.position,
      title: payload.title,
      url: payload.url,
      createdAt: Date.now(),
    };
    await this.db.expectedMutations.add(exp);
    const created = await this.adapter.create(parentBrowserId, {
      title: payload.title,
      url: payload.url || undefined,
    });
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.expectedMutations], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      await this.db.expectedMutations.delete(exp.id!);
      await this.db.localNodes.put({
        bindingId: b.id,
        browserId: created.id,
        canonicalId: change.node_id,
        type: created.type,
        title: created.title,
        url: created.url,
        parentBrowserId: created.parentId,
        position: payload.position,
      });
      await this.advanceApplied(b, change.revision);
    });
  }

  // --- update title/url ---

  private async applyUpdateField(
    binding: BindingRecord,
    change: ChangeWire,
    target: { title?: string; url?: string },
  ): Promise<void> {
    const mirror = await findMirrorByCanonical(this.db, binding.id, change.node_id);
    if (!mirror?.browserId) {
      await logDiagnostic(this.db, 'warn', 'applier', 'update for unmapped node skipped', {
        bindingId: binding.id,
        change,
      });
      await this.advanceTo(binding.id, change.revision);
      return;
    }
    // Ensure-state: mirror already at the target value.
    if (target.title !== undefined && mirror.title === target.title) {
      await this.advanceTo(binding.id, change.revision);
      return;
    }
    if (target.url !== undefined && mirror.url === target.url) {
      await this.advanceTo(binding.id, change.revision);
      return;
    }

    const exp: ExpectedMutationRecord = {
      bindingId: binding.id,
      revision: change.revision,
      kind: target.title !== undefined ? 'update_title' : 'update_url',
      canonicalId: change.node_id,
      browserId: mirror.browserId,
      title: target.title,
      url: target.url,
      createdAt: Date.now(),
    };
    await this.db.expectedMutations.add(exp);
    await this.adapter.update(mirror.browserId, target);
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.expectedMutations], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      await this.db.expectedMutations.delete(exp.id!);
      await this.db.localNodes.put({
        ...mirror,
        title: target.title ?? mirror.title,
        url: target.url !== undefined ? target.url : mirror.url,
      });
      await this.advanceApplied(b, change.revision);
    });
  }

  // --- move ---

  private async applyMove(
    binding: BindingRecord,
    change: ChangeWire,
    payload: { parent: ParentRefWire; position: number },
  ): Promise<void> {
    const mirror = await findMirrorByCanonical(this.db, binding.id, change.node_id);
    if (!mirror?.browserId) {
      await logDiagnostic(this.db, 'warn', 'applier', 'move for unmapped node skipped', {
        bindingId: binding.id,
        change,
      });
      await this.advanceTo(binding.id, change.revision);
      return;
    }
    const parentBrowserId = await this.resolveParentBrowser(binding, payload.parent);
    if (!parentBrowserId) {
      await logDiagnostic(this.db, 'warn', 'applier', 'move with unmapped parent skipped', {
        bindingId: binding.id,
        change,
      });
      await this.advanceTo(binding.id, change.revision);
      return;
    }

    // Ensure-state: same parent and canonical position already matches.
    if (mirror.parentBrowserId === parentBrowserId && mirror.position === payload.position) {
      await this.advanceTo(binding.id, change.revision);
      return;
    }

    const index = await this.browserIndexForPosition(binding.id, parentBrowserId, payload.position, change.node_id);
    const exp: ExpectedMutationRecord = {
      bindingId: binding.id,
      revision: change.revision,
      kind: 'move',
      canonicalId: change.node_id,
      browserId: mirror.browserId,
      parentBrowserId,
      position: payload.position,
      createdAt: Date.now(),
    };
    await this.db.expectedMutations.add(exp);
    await this.adapter.move(mirror.browserId, parentBrowserId, index);
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.expectedMutations], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      await this.db.expectedMutations.delete(exp.id!);
      await this.db.localNodes.put({ ...mirror, parentBrowserId, position: payload.position });
      await this.advanceApplied(b, change.revision);
    });
  }

  // --- delete ---

  private async applyDelete(binding: BindingRecord, change: ChangeWire): Promise<void> {
    const mirror = await findMirrorByCanonical(this.db, binding.id, change.node_id);
    if (!mirror?.browserId) {
      // Nothing mapped (never applied here / already gone): NOOP advance.
      await this.advanceTo(binding.id, change.revision);
      return;
    }
    const exp: ExpectedMutationRecord = {
      bindingId: binding.id,
      revision: change.revision,
      kind: 'delete',
      canonicalId: change.node_id,
      browserId: mirror.browserId,
      createdAt: Date.now(),
    };
    await this.db.expectedMutations.add(exp);
    await this.adapter.remove(mirror.browserId);
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.expectedMutations], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      await this.db.expectedMutations.delete(exp.id!);
      const subtree = await collectSubtree(this.db, binding.id, mirror.browserId);
      await this.db.localNodes.bulkDelete(subtree.map((r) => [binding.id, r.browserId] as [string, string]));
      await this.advanceApplied(b, change.revision);
    });
  }

  // --- helpers ---

  private async resolveParentBrowser(binding: BindingRecord, parent: ParentRefWire): Promise<string | null> {
    if (parent.type === 'root') {
      const mount = binding.mount;
      if (mount.mode === 'partial' && parent.key === mount.rootKey) return mount.folderBrowserId ?? null;
      if (mount.mode === 'full' && mount.roots && parent.key != null) return mount.roots[parent.key] ?? null;
      return null;
    }
    const row = await findMirrorByCanonical(this.db, binding.id, parent.id ?? '');
    return row?.browserId ?? null;
  }

  /**
   * Translate a canonical sibling position into a browser child index:
   * insert before the first mapped sibling whose canonical position is
   * greater; append when none. Separators etc. stay local-only (doc 05 §12).
   */
  private async browserIndexForPosition(
    bindingId: string,
    parentBrowserId: string,
    position: number,
    movedCanonicalId: string,
  ): Promise<number> {
    const children = await this.adapter.getChildren(parentBrowserId);
    for (const child of children) {
      if (child.id === movedCanonicalId) continue;
      const m: LocalNodeRecord | undefined = await this.db.localNodes.get([bindingId, child.id]);
      if (m?.canonicalId && m.position != null && m.position > position) {
        return child.index;
      }
    }
    return null as unknown as number; // append → adapter passes undefined index
  }

  /** Commit a resolved expectation: repair the mirror and advance. */
  private async commitResolved(
    binding: BindingRecord,
    exp: ExpectedMutationRecord,
    node?: { id: string; parentId: string | null; title: string; url: string | null; type: 'folder' | 'bookmark' },
  ): Promise<void> {
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.expectedMutations], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      await this.db.expectedMutations.delete(exp.id!);
      const mirror = await findMirrorByCanonical(this.db, b.id, exp.canonicalId);
      if (mirror) {
        await this.db.localNodes.put({
          ...mirror,
          parentBrowserId: node?.parentId ?? mirror.parentBrowserId,
          title: node?.title ?? exp.title ?? mirror.title,
          url: node?.url ?? exp.url ?? mirror.url,
          position: exp.position ?? mirror.position,
        });
      }
      await this.advanceApplied(b, exp.revision);
    });
  }

  private async advanceTo(bindingId: string, revision: number): Promise<void> {
    const b = await this.db.bindings.get(bindingId);
    if (!b || b.appliedRevision >= revision) return;
    await this.db.bindings.update(bindingId, { appliedRevision: revision });
  }

  /** Rule 4: applied_revision advances only inside the confirm transaction. */
  private async advanceApplied(binding: BindingRecord, revision: number): Promise<void> {
    if (revision > binding.appliedRevision) {
      binding.appliedRevision = revision;
      await this.db.bindings.put(binding);
    }
  }
}
