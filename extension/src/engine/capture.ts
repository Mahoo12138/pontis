import { Operation, ParentRef } from '@pontis/protocol';
import { v7 as uuidv7 } from 'uuid';

import { BrowserAdapter, BrowserEvent } from '../adapter/types';
import { MirrorNode } from '../store/db';
import { ReplicaStore } from '../store/replica';

/**
 * Event capture (doc 05 §5, §13): browser mutations become mirror
 * updates plus queued operations in one transaction — unless the event
 * matches a persisted expected remote mutation (doc 05 §8), in which
 * case it only resolves the expectation. Capture never pauses.
 */
export class EventCapture {
  private unsubscribe?: () => void;

  constructor(private store: ReplicaStore, private adapter: BrowserAdapter, private bindingId: string) {}

  start(): () => void {
    this.unsubscribe = this.adapter.onEvent((event) =>
      this.handle(event).catch((err) => {
        throw new Error(`capture: ${JSON.stringify(event)}: ${err}`);
      }),
    );
    return () => this.unsubscribe?.();
  }

  private async handle(event: BrowserEvent): Promise<void> {
    switch (event.kind) {
      case 'created':
        await this.onCreated(event.node);
        return;
      case 'changed':
        await this.onChanged(event);
        return;
      case 'moved':
        await this.onMoved(event);
        return;
      case 'removed':
        await this.onRemoved(event);
        return;
    }
  }

  // --- created ---

  private async onCreated(node: { id: string; parentId: string | null; type: 'root' | 'folder' | 'bookmark'; title: string; url?: string }): Promise<void> {
    if (node.type === 'root' || node.parentId === null) {
      return; // browser roots are configuration, not captured data
    }
    // A projected root container (Recovered/<Device>, doc 04 §11) is a
    // browser-local container for a canonical root slot, not data.
    const projected = await this.store.takeExpectation(
      (e) => e.bindingId === this.bindingId && e.kind === 'project_root' && e.parentBrowserId === node.parentId && e.title === node.title,
    );
    if (projected) {
      const binding = await this.binding();
      await this.store.setRootMap(this.bindingId, { ...binding.rootMap, [projected.title!]: node.id });
      return;
    }
    const binding = await this.binding();
    const parentCanonical = await this.parentRefOfBrowser(binding.rootMap, node.parentId);
    if (!parentCanonical) {
      // Parent not managed (unmapped subtree): the integrity scan owns it.
      return;
    }

    // Expected remote create: resolve the provisional expectation by its
    // matching fields (doc 05 §9) and only build the mapping.
    const expected = await this.store.takeExpectation(
      (e) =>
        e.bindingId === this.bindingId &&
        e.kind === 'create' &&
        e.parentBrowserId === node.parentId &&
        e.type === node.type &&
        e.title === node.title &&
        (e.url ?? undefined) === (node.url ?? undefined),
    );
    if (expected && expected.canonicalId) {
      const position = await this.canonicalPosition(node.parentId, node.id);
      await this.store.putMirror({
        bindingId: this.bindingId,
        canonicalId: expected.canonicalId,
        browserId: node.id,
        type: node.type as 'folder' | 'bookmark',
        title: node.title,
        url: node.url,
        ...parentRow(parentCanonical),
        position,
      });
      return;
    }

    const canonicalId = uuidv7();
    const op: Operation = {
      op_id: uuidv7(),
      client_seq: 0, // allocated by the store transaction
      base_revision: (await this.binding()).appliedRevision,
      type: 'create',
      node_id: canonicalId,
      node_type: node.type as 'folder' | 'bookmark',
      title: node.title,
      url: node.url,
      parent: parentCanonical,
      before_id: await this.canonicalAnchor(node.parentId, node.id),
    };
    await this.store.captureLocalMutation(this.bindingId, {
      upserts: [
        {
          bindingId: this.bindingId,
          canonicalId,
          browserId: node.id,
          type: node.type as 'folder' | 'bookmark',
          title: node.title,
          url: node.url,
          ...parentRow(parentCanonical),
          position: await this.canonicalPosition(node.parentId, node.id),
        },
      ],
      deletes: [],
      ops: [op],
    });
  }

  // --- changed ---

  private async onChanged(event: { id: string; title: string; url?: string }): Promise<void> {
    const binding = await this.binding();
    const mirror = await this.store.getMirrorByBrowser(this.bindingId, event.id);
    if (!mirror) {
      return; // unmanaged node
    }
    // Expected remote rename: consume the expectation, mirror is already
    // up to date (the applier wrote it).
    const expected = await this.store.takeExpectation(
      (e) => e.bindingId === this.bindingId && e.kind === 'update' && e.canonicalId === mirror.canonicalId,
    );
    if (expected) {
      return;
    }

    const ops: Operation[] = [];
    if (event.title !== mirror.title) {
      ops.push({
        op_id: uuidv7(),
        client_seq: 0,
        base_revision: binding.appliedRevision,
        type: 'update_title',
        node_id: mirror.canonicalId,
        title: event.title,
      });
    }
    if ((event.url ?? undefined) !== (mirror.url ?? undefined)) {
      ops.push({
        op_id: uuidv7(),
        client_seq: 0,
        base_revision: binding.appliedRevision,
        type: 'update_url',
        node_id: mirror.canonicalId,
        url: event.url ?? '',
      });
    }
    if (ops.length === 0) {
      return;
    }
    const updated: MirrorNode = { ...mirror };
    if (event.title !== mirror.title) {
      updated.title = event.title;
    }
    if ((event.url ?? undefined) !== (mirror.url ?? undefined)) {
      updated.url = event.url;
    }
    await this.store.captureLocalMutation(this.bindingId, { upserts: [updated], deletes: [], ops });
  }

  // --- moved ---

  private async onMoved(event: { id: string; parentId: string; index: number }): Promise<void> {
    const binding = await this.binding();
    const mirror = await this.store.getMirrorByBrowser(this.bindingId, event.id);
    if (!mirror) {
      return;
    }
    const expected = await this.store.takeExpectation(
      (e) => e.bindingId === this.bindingId && e.kind === 'move' && e.canonicalId === mirror.canonicalId,
    );
    if (expected) {
      return;
    }

    const parentCanonical = await this.parentRefOfBrowser(binding.rootMap, event.parentId);
    if (!parentCanonical) {
      return; // moved out of the managed scope: integrity scan territory
    }
    const position = await this.canonicalPosition(event.parentId, event.id);
    const updated: MirrorNode = { ...mirror, ...parentRow(parentCanonical), position };
    const op: Operation = {
      op_id: uuidv7(),
      client_seq: 0,
      base_revision: binding.appliedRevision,
      type: 'move',
      node_id: mirror.canonicalId,
      parent: parentCanonical,
      before_id: await this.canonicalAnchor(event.parentId, event.id),
    };
    await this.store.captureLocalMutation(this.bindingId, { upserts: [updated], deletes: [], ops: [op] });
  }

  // --- removed ---

  private async onRemoved(event: { id: string }): Promise<void> {
    const binding = await this.binding();
    const mirror = await this.store.getMirrorByBrowser(this.bindingId, event.id);
    if (!mirror) {
      return;
    }
    const expected = await this.store.takeExpectation(
      (e) => e.bindingId === this.bindingId && e.kind === 'delete' && e.canonicalId === mirror.canonicalId,
    );
    const subtree = await this.subtreeCanonicalIds(mirror.canonicalId);
    if (expected) {
      await this.store.deleteMirrorMany(this.bindingId, subtree);
      return;
    }
    const op: Operation = {
      op_id: uuidv7(),
      client_seq: 0,
      base_revision: binding.appliedRevision,
      type: 'delete',
      node_id: mirror.canonicalId,
    };
    await this.store.captureLocalMutation(this.bindingId, { upserts: [], deletes: subtree, ops: [op] });
  }

  // --- helpers ---

  private async binding() {
    const binding = await this.store.getBinding(this.bindingId);
    if (!binding) {
      throw new Error(`capture: unknown binding ${this.bindingId}`);
    }
    return binding;
  }

  /** Canonical parent ref of a browser container, or null when unmanaged. */
  private async parentRefOfBrowser(rootMap: Record<string, string>, browserId: string): Promise<ParentRef | null> {
    for (const [rootKey, rootBrowserId] of Object.entries(rootMap)) {
      if (rootBrowserId === browserId) {
        return { type: 'root', key: rootKey };
      }
    }
    const mirror = await this.store.getMirrorByBrowser(this.bindingId, browserId);
    if (!mirror) {
      return null;
    }
    return { type: 'node', id: mirror.canonicalId };
  }

  /**
   * Canonical position of a node among its mapped siblings: the count of
   * mapped siblings preceding it in browser order.
   */
  private async canonicalPosition(parentBrowserId: string, browserId: string): Promise<number> {
    const siblings = await this.adapter.getChildren(parentBrowserId);
    let position = 0;
    for (const sibling of siblings) {
      if (sibling.id === browserId) {
        break;
      }
      if (await this.store.getMirrorByBrowser(this.bindingId, sibling.id)) {
        position++;
      }
    }
    return position;
  }

  /** Next mapped sibling's canonical id, or undefined to append (doc 05 §12). */
  private async canonicalAnchor(parentBrowserId: string, browserId: string): Promise<string | undefined> {
    const siblings = await this.adapter.getChildren(parentBrowserId);
    const at = siblings.findIndex((s) => s.id === browserId);
    for (let i = at + 1; i < siblings.length; i++) {
      const mirror = await this.store.getMirrorByBrowser(this.bindingId, siblings[i]!.id);
      if (mirror) {
        return mirror.canonicalId;
      }
    }
    return undefined;
  }

  /** Canonical ids of the whole subtree rooted at canonicalId, inclusive. */
  private async subtreeCanonicalIds(canonicalId: string): Promise<string[]> {
    const all = await this.store.listMirrorAll(this.bindingId);
    const byParent = new Map<string, string[]>();
    for (const node of all) {
      if (node.parentType !== 'node') {
        continue;
      }
      const list = byParent.get(node.parentCanonicalId!) ?? [];
      list.push(node.canonicalId);
      byParent.set(node.parentCanonicalId!, list);
    }
    const out: string[] = [];
    const stack = [canonicalId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      out.push(cur);
      stack.push(...(byParent.get(cur) ?? []));
    }
    return out;
  }
}

function parentRow(ref: ParentRef): Pick<MirrorNode, 'parentType' | 'parentCanonicalId' | 'parentRootKey'> {
  if (ref.type === 'node') {
    return { parentType: 'node', parentCanonicalId: ref.id, parentRootKey: undefined };
  }
  return { parentType: 'root', parentCanonicalId: undefined, parentRootKey: ref.key };
}
