// Remote Change Applier (doc 05 §7-§11): applies canonical changes to the
// browser strictly serially, with ensure-state idempotency:
//   1. skip if the target state is already satisfied;
//   2. persist the expected mutation BEFORE calling the browser API;
//   3. apply via the Browser Adapter;
//   4. commit mirror updates + applied_revision advance in one transaction.
// A crash anywhere leaves either a resolvable expectation or a satisfied
// ensure-state check, never a duplicated mutation.

import { removeByType, type BrowserAdapter, type BrowserNode } from '../browser/types';
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

/**
 * A change targets a node or parent whose mapping should exist but does not.
 * Advancing applied_revision here would turn the watermark into "messages
 * seen" instead of "state reached", and the server would never resend the
 * change — the browser would be silently missing data while reporting a synced
 * tree. Callers must move the binding to an explicit recovery state.
 *
 * A parent the mount deliberately does not project is a different answer: that
 * change carries nothing for this replica, so it is acknowledged and skipped.
 */
export class UnmappedProjectionError extends Error {
  readonly code = 'UNMAPPED_PROJECTION';

  constructor(
    readonly kind: 'node' | 'parent',
    readonly bindingId: string,
    readonly revision: number,
    readonly target: string,
  ) {
    super(`unmapped ${kind} "${target}" at revision ${revision}`);
    this.name = 'UnmappedProjectionError';
  }
}

/** Outcome of resolving a wire parent ref against the mount. */
type ParentResolution =
  | { kind: 'mapped'; browserId: string }
  /** The mount does not project this root: nothing to apply here. */
  | { kind: 'excluded' }
  /** Expected to be mapped and is not. */
  | { kind: 'missing'; ref: string };

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
        // The mapping the expectation points at is gone. Dropping the
        // expectation and advancing would mark an unapplied revision as
        // reached; keep it so the binding stays visibly unfixed.
        await logDiagnostic(this.db, 'error', 'applier', 'recovery: expectation has no mapping to verify, needs recovery', {
          bindingId,
          exp,
        });
        continue;
      }
      const node = await this.adapter.getNode(mirror.browserId);
      let satisfied = false;
      if (exp.kind === 'delete') {
        satisfied = node == null;
      } else if (node) {
        if (exp.kind === 'move') {
          // Parent equality is not enough: a same-parent reorder that
          // crashed before the API call would otherwise look satisfied and
          // strand the browser in the old order.
          const inPlace = node.parentId === exp.parentBrowserId;
          const rank = inPlace ? await this.mappedRank(bindingId, exp.parentBrowserId!, node.id) : null;
          satisfied = inPlace && (exp.position == null || rank === exp.position);
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
    const parent = await this.resolveParent(binding, payload.parent);
    if (parent.kind === 'excluded') {
      // Outside this mount's projection: the change carries nothing to do.
      await this.advanceTo(binding.id, change.revision);
      return;
    }
    if (parent.kind === 'missing') {
      await logDiagnostic(this.db, 'error', 'applier', 'create with unmapped parent, binding needs recovery', {
        bindingId: binding.id,
        change,
        ref: parent.ref,
      });
      throw new UnmappedProjectionError('parent', binding.id, change.revision, parent.ref);
    }
    const parentBrowserId = parent.browserId;

    // One canonical id owns one browser node. A mirror row for it means the
    // node is already here — creating again would split the same server node
    // across two bookmarks and the user would have to delete one by hand.
    // Only a node the user really deleted locally lets this change create.
    const existing = await findMirrorByCanonical(this.db, binding.id, change.node_id);
    if (existing && (await this.adapter.getNode(existing.browserId))) {
      await this.advanceTo(binding.id, change.revision);
      return;
    }
    if (existing) {
      // The mirror claims a node the browser no longer has: drop that stale
      // subtree first, otherwise the create below maps the same id twice.
      const stale = await collectSubtree(this.db, binding.id, existing.browserId);
      await this.db.localNodes.bulkDelete(stale.map((r) => [binding.id, r.browserId] as [string, string]));
    }

    // Two-phase CREATE (doc 05 §8): a local create that produced this
    // canonical node already has a browser node — adopt it instead of
    // duplicating. The outbox op carries the browser id pre-ack; the op
    // whose result revision matches this change is the exact producer.
    const adopted = await this.tryAdoptLocalCreate(binding, change, payload);
    if (adopted) return;

    // Rule 2 (doc 05 §16): expectation BEFORE the browser API. Create is
    // provisional — the browser id is unknown until the API answers.
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
    const index = await this.browserIndexForPosition(binding.id, parentBrowserId, payload.position, null);
    const created = await this.adapter.create(parentBrowserId, {
      title: payload.title,
      url: payload.url || undefined,
      index,
    });
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.expectedMutations], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      // The expectation is the echo's, not ours to consume: deleting it here
      // would leave the onCreated event with nothing to match, and the node we
      // just created would be queued as if the user had made it.
      await this.db.expectedMutations.put({ ...exp, id: exp.id, browserId: created.id });
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
      // The server's positions for this parent are now dense; adopt the
      // browser order so the mirrors say the same thing.
      await this.mirrorPositions(binding.id, parentBrowserId);
      await this.advanceApplied(b, change.revision);
    });
  }

  /**
   * Adopt the browser node of a local create op when the server ack
   *回流 arrives. Exact match first (result revision), then shape match
   * as the crash-recovery fallback. Returns true when adopted.
   */
  private async tryAdoptLocalCreate(
    binding: BindingRecord,
    change: ChangeWire,
    payload: { type: 'folder' | 'bookmark'; title: string; url: string; position: number },
  ): Promise<boolean> {
    const ops = await this.db.pendingOps
      .where('bindingId')
      .equals(binding.id)
      .filter((o) => o.type === 'create' && o.browserId != null)
      .toArray();
    if (ops.length === 0) return false;
    // Identity first: a create op carries the canonical id the client named for
    // its own node (doc 04), so the change for that id is the ack's own words.
    const op =
      ops.find((o) => o.nodeId === change.node_id) ??
      ops.find((o) => o.result?.resultRevision === change.revision) ??
      ops.find((o) => o.status === 'QUEUED' && o.title === payload.title && (o.url ?? '') === payload.url);
    if (!op?.browserId) return false;
    const local = await this.db.localNodes.get([binding.id, op.browserId]);
    if (!local || local.canonicalId != null) return false;
    await this.db.transaction('rw', [this.db.bindings, this.db.localNodes, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(binding.id);
      if (!b) return;
      await this.db.localNodes.put({
        ...local,
        canonicalId: change.node_id,
        position: payload.position,
      });
      await this.advanceApplied(b, change.revision);
    });
    await logDiagnostic(this.db, 'info', 'applier', 'local create adopted canonical id from ack', {
      bindingId: binding.id,
      browserId: op.browserId,
      canonicalId: change.node_id,
    });
    return true;
  }

  // --- update title/url ---

  private async applyUpdateField(
    binding: BindingRecord,
    change: ChangeWire,
    target: { title?: string; url?: string },
  ): Promise<void> {
    const mirror = await findMirrorByCanonical(this.db, binding.id, change.node_id);
    if (!mirror?.browserId) {
      // Applied revisions are contiguous, so the create for this node either
      // landed here or was acknowledged as satisfied. A missing mapping means
      // local state was lost; skipping would hide it from any later repair.
      await logDiagnostic(this.db, 'error', 'applier', 'update for unmapped node, binding needs recovery', {
        bindingId: binding.id,
        change,
      });
      throw new UnmappedProjectionError('node', binding.id, change.revision, change.node_id);
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
      // Left for the onChanged echo to consume (doc 05 §8): consuming it here
      // would turn our own rename into a pending local edit.
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
      await logDiagnostic(this.db, 'error', 'applier', 'move for unmapped node, binding needs recovery', {
        bindingId: binding.id,
        change,
      });
      throw new UnmappedProjectionError('node', binding.id, change.revision, change.node_id);
    }
    const parent = await this.resolveParent(binding, payload.parent);
    if (parent.kind === 'excluded') {
      await this.advanceTo(binding.id, change.revision);
      return;
    }
    if (parent.kind === 'missing') {
      await logDiagnostic(this.db, 'error', 'applier', 'move with unmapped parent, binding needs recovery', {
        bindingId: binding.id,
        change,
        ref: parent.ref,
      });
      throw new UnmappedProjectionError('parent', binding.id, change.revision, parent.ref);
    }
    const parentBrowserId = parent.browserId;

    // Ensure-state: same parent and canonical position already matches.
    if (mirror.parentBrowserId === parentBrowserId && mirror.position === payload.position) {
      await this.advanceTo(binding.id, change.revision);
      return;
    }

    const index = await this.browserIndexForPosition(binding.id, parentBrowserId, payload.position, mirror.browserId);
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
      // The onMoved echo consumes this one (doc 05 §8).
      await this.db.localNodes.put({ ...mirror, parentBrowserId, position: payload.position });
      // A move renumbers the destination *and* the parent it left.
      await this.mirrorPositions(binding.id, parentBrowserId);
      if (mirror.parentBrowserId && mirror.parentBrowserId !== parentBrowserId) {
        await this.mirrorPositions(binding.id, mirror.parentBrowserId);
      }
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
    const live = await this.adapter.getNode(mirror.browserId);
    if (!live) {
      // Already absent locally (the user removed it, or a previous round
      // deleted it before the mirror commit). Drop the stale subtree and
      // advance; there is nothing for the browser API to delete.
      await this.db.transaction('rw', [this.db.bindings, this.db.localNodes], async () => {
        const b = await this.db.bindings.get(binding.id);
        if (!b) return;
        const subtree = await collectSubtree(this.db, binding.id, mirror.browserId);
        await this.db.localNodes.bulkDelete(subtree.map((r) => [binding.id, r.browserId] as [string, string]));
        await this.advanceApplied(b, change.revision);
      });
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
    // The live node decides the deletion verb: browsers refuse to drop a
    // non-empty container with the single-item call.
    await removeByType(this.adapter, { id: live.id, type: live.type });
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

  private async resolveParent(binding: BindingRecord, parent: ParentRefWire): Promise<ParentResolution> {
    if (parent.type === 'root') {
      const mount = binding.mount;
      if (mount.mode === 'partial' && parent.key === mount.rootKey) {
        return mount.folderBrowserId ? { kind: 'mapped', browserId: mount.folderBrowserId } : { kind: 'missing', ref: `root:${parent.key}` };
      }
      if (mount.mode === 'full' && mount.roots && parent.key != null) {
        const browserId = mount.roots[parent.key];
        // A root the mount knows nothing about is outside this replica's
        // projection, not a lost mapping.
        return browserId ? { kind: 'mapped', browserId } : { kind: 'excluded' };
      }
      return { kind: 'excluded' };
    }
    const ref = parent.id ?? '';
    const row = await findMirrorByCanonical(this.db, binding.id, ref);
    return row?.browserId ? { kind: 'mapped', browserId: row.browserId } : { kind: 'missing', ref };
  }

  /**
   * Translate a canonical sibling position into a browser child index.
   *
   * The browser removes the node first and then inserts at the index, so the
   * answer is the browser slot of the mapped sibling that must end up
   * directly after it: the (position)-th mapped sibling, excluding the node
   * being placed. Appending is the length of that same list.
   *
   * Browser ids and canonical ids are different namespaces and are only ever
   * compared within their own kind, and unmapped local-only children (a
   * separator, a folder outside the projection) still occupy browser slots,
   * so the index is looked up in the full child list.
   */
  private async browserIndexForPosition(
    bindingId: string,
    parentBrowserId: string,
    position: number,
    movedBrowserId: string | null,
  ): Promise<number> {
    const children = await this.adapter.getChildren(parentBrowserId);
    const withoutMoved = children.filter((c) => c.id !== movedBrowserId);
    const mapped: { id: string; position: number }[] = [];
    for (const child of withoutMoved) {
      const m: LocalNodeRecord | undefined = await this.db.localNodes.get([bindingId, child.id]);
      if (m?.canonicalId && m.position != null) mapped.push({ id: child.id, position: m.position });
    }
    mapped.sort((a, b) => a.position - b.position);
    const target = mapped[position];
    if (!target) return withoutMoved.length;
    const at = withoutMoved.findIndex((c) => c.id === target.id);
    return at < 0 ? withoutMoved.length : at;
  }

  /**
   * Re-read the browser's order for a parent and mirror it onto the mapped
   * children. A single CREATE/MOVE change renumbers the whole sibling set on
   * the server; without this the mirrors keep the pre-change positions and
   * every later index computation is off by one.
   */
  private async mirrorPositions(bindingId: string, parentBrowserId: string): Promise<void> {
    await syncMirrorPositions(this.db, this.adapter, bindingId, parentBrowserId);
  }

  /**
   * A node's rank among the *mapped* children in the browser's real sibling
   * order. Equal to its canonical position when the projection holds, which
   * is what makes an order regression detectable after a crash: parent alone
   * cannot tell a same-parent reorder from one that never ran.
   */
  private async mappedRank(bindingId: string, parentBrowserId: string, browserId: string): Promise<number | null> {
    const children = await this.adapter.getChildren(parentBrowserId);
    let rank = 0;
    for (const child of children) {
      if (child.id === browserId) return rank;
      const m = await this.db.localNodes.get([bindingId, child.id]);
      if (m?.canonicalId) rank += 1;
    }
    return null;
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
        // A folder has no url: the create payload carries '' for one, and
        // writing that onto the mirror would claim the browser holds a folder
        // bookmark and fail verification on every resync.
        const type = node?.type ?? mirror.type;
        await this.db.localNodes.put({
          ...mirror,
          parentBrowserId: node?.parentId ?? mirror.parentBrowserId,
          title: node?.title ?? exp.title ?? mirror.title,
          url: type === 'folder' ? null : (node?.url ?? exp.url ?? mirror.url),
          position: exp.position ?? mirror.position,
        });
      }
      const parentId = node?.parentId ?? exp.parentBrowserId ?? mirror?.parentBrowserId ?? null;
      if (parentId && (exp.kind === 'move' || exp.kind === 'create')) {
        await this.mirrorPositions(b.id, parentId);
        const source = exp.kind === 'move' ? mirror?.parentBrowserId : null;
        if (source && source !== parentId) await this.mirrorPositions(b.id, source);
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

/**
 * Re-read the browser's sibling order for one parent and write it onto the
 * mapped children. The browser is the local source of truth for order, so
 * every path that reshapes a parent's children (an incremental change, a
 * reconciliation step) ends by adopting the order it just produced.
 */
export async function syncMirrorPositions(
  db: PontisDB,
  adapter: BrowserAdapter,
  bindingId: string,
  parentBrowserId: string,
): Promise<void> {
  const children = await adapter.getChildren(parentBrowserId);
  let rank = 0;
  for (const child of children) {
    const m = await db.localNodes.get([bindingId, child.id]);
    if (!m?.canonicalId) continue;
    if (m.position !== rank) await db.localNodes.put({ ...m, position: rank });
    rank += 1;
  }
}
