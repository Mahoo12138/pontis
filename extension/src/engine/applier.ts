import { ApplyStep, Change, ChangePayload, ParentRef } from '@pontis/protocol';

import { BrowserAdapter } from '../adapter/types';
import { MirrorNode } from '../store/db';
import { ReplicaStore } from '../store/replica';

/**
 * Remote change applier (doc 05 §8-10): applies canonical changes and
 * reconciliation steps with ensure-state semantics. Expectations are
 * persisted BEFORE the browser API call (crash rule 2) so the resulting
 * browser events never become local operations; applied_revision only
 * advances after the browser state is confirmed (crash rule 4, V1: the
 * API's return value is the confirmation).
 */
export class RemoteApplier {
  constructor(private store: ReplicaStore, private adapter: BrowserAdapter, private bindingId: string) {}

  /** Applies one inbox change; the caller confirms the revision after. */
  async applyChange(change: Pick<Change, 'type' | 'node_id' | 'payload'>): Promise<void> {
    const payload = change.payload as ChangePayload;
    switch (change.type) {
      case 'create': {
        const p = payload as Extract<ChangePayload, { position: number; parent: ParentRef; type: string }>;
        await this.ensureCreate(change.node_id, p.type as 'folder' | 'bookmark', p.title, p.url, p.parent, p.position);
        return;
      }
      case 'update_title': {
        const p = payload as { title: string };
        await this.ensureFields(change.node_id, p.title, undefined);
        return;
      }
      case 'update_url': {
        const p = payload as { url: string };
        await this.ensureFields(change.node_id, undefined, p.url);
        return;
      }
      case 'move': {
        const p = payload as { parent: ParentRef; position: number };
        await this.ensurePlacement(change.node_id, p.parent, p.position);
        return;
      }
      case 'delete': {
        await this.ensureDelete(change.node_id);
        return;
      }
      default:
        throw new Error(`applier: unknown change type ${change.type}`);
    }
  }

  // --- ensure-state primitives ---

  private async ensureCreate(canonicalId: string, type: 'folder' | 'bookmark', title: string, url: string | undefined, parent: ParentRef, position: number): Promise<void> {
    const existing = await this.store.getMirrorByCanonical(this.bindingId, canonicalId);
    if (existing) {
      // Own echo or re-delivery: the browser already holds the node.
      await this.ensureFields(canonicalId, title, url);
      await this.ensurePlacement(canonicalId, parent, position);
      return;
    }
    const parentBrowserId = await this.resolveParentBrowser(parent);
    // Expectation first (doc 05 §8): the created event resolves it and
    // never becomes a local op.
    await this.store.putExpectation({
      bindingId: this.bindingId,
      kind: 'create',
      canonicalId,
      parentBrowserId,
      type,
      title,
      url,
    });
    const created = await this.adapter.create(parentBrowserId, type, title, url);
    const node = await this.store.getMirrorByBrowser(this.bindingId, created.id);
    if (!node) {
      await this.store.putMirror({
        bindingId: this.bindingId,
        canonicalId,
        browserId: created.id,
        type,
        title,
        url,
        ...parentColumns(parent),
        position,
      });
    }
    await this.ensurePlacement(canonicalId, parent, position);
  }

  private async ensureFields(canonicalId: string, title: string | undefined, url: string | undefined): Promise<void> {
    const mirror = await this.store.getMirrorByCanonical(this.bindingId, canonicalId);
    if (!mirror) {
      throw new Error(`applier: update for unknown node ${canonicalId}`);
    }
    const fields: { title?: string; url?: string } = {};
    if (title !== undefined && mirror.title !== title) {
      fields.title = title;
    }
    if (url !== undefined && (mirror.url ?? undefined) !== url) {
      fields.url = url;
    }
    if (Object.keys(fields).length > 0) {
      await this.store.putExpectation({ bindingId: this.bindingId, kind: 'update', canonicalId });
      await this.adapter.update(mirror.browserId, fields);
      await this.store.putMirror({ ...mirror, ...(fields.title !== undefined ? { title: fields.title } : {}), ...(fields.url !== undefined ? { url: fields.url } : {}) });
    }
  }

  private async ensurePlacement(canonicalId: string, parent: ParentRef, position: number): Promise<void> {
    const mirror = await this.store.getMirrorByCanonical(this.bindingId, canonicalId);
    if (!mirror) {
      throw new Error(`applier: move for unknown node ${canonicalId}`);
    }
    const parentBrowserId = await this.resolveParentBrowser(parent);

    // Canonical sibling order from the mirror, self re-inserted at the
    // target position (the executor's dense reindex, mirrored).
    const siblings =
      parent.type === 'node'
        ? await this.store.listMirrorChildrenOfNode(this.bindingId, parent.id!)
        : await this.store.listMirrorChildrenOfRoot(this.bindingId, parent.key!);
    const others = siblings.filter((s) => s.canonicalId !== canonicalId).sort((a, b) => a.position - b.position);
    const at = Math.max(0, Math.min(position, others.length));
    const order: MirrorNode[] = [];
    others.forEach((s, i) => {
      if (i === at) {
        order.push(mirror);
      }
      order.push(s);
    });
    if (order.length === others.length) {
      order.push(mirror);
    }
    const updates: MirrorNode[] = [];
    order.forEach((s, i) => {
      if (s.position !== i || s.canonicalId === canonicalId) {
        updates.push({ ...s, ...parentColumns(parent), position: i });
      }
    });
    await this.store.putMirrorMany(updates);

    // Browser placement: anchor on the canonical successor's browser
    // node; unmapped transients are skipped (append when none). The
    // index counts self-removal: the browser index is the final slot
    // after the node leaves its current position.
    const successor = order.find((s, i) => i > at && s.canonicalId !== canonicalId);
    const browserChildren = await this.adapter.getChildren(parentBrowserId);
    const node = await this.adapter.getNode(mirror.browserId);
    if (!node) {
      throw new Error(`applier: browser node ${mirror.browserId} vanished`);
    }
    let index: number | undefined;
    if (successor) {
      const successorAt = browserChildren.findIndex((c) => c.id === successor.browserId);
      if (successorAt >= 0) {
        const selfAt = browserChildren.findIndex((c) => c.id === mirror.browserId);
        index = successorAt - (selfAt >= 0 && selfAt < successorAt ? 1 : 0);
      }
    }
    const currentAt = browserChildren.findIndex((c) => c.id === mirror.browserId);
    const inPlace =
      node.parentId === parentBrowserId &&
      (index === undefined ? currentAt >= 0 && currentAt === browserChildren.length - 1 : currentAt === index);
    if (!inPlace) {
      await this.store.putExpectation({ bindingId: this.bindingId, kind: 'move', canonicalId });
      await this.adapter.move(mirror.browserId, parentBrowserId, index);
    }
  }

  private async ensureDelete(canonicalId: string): Promise<void> {
    const mirror = await this.store.getMirrorByCanonical(this.bindingId, canonicalId);
    if (!mirror) {
      return; // own delete echo: already gone
    }
    const subtree = await this.subtreeCanonicalIds(canonicalId);
    await this.store.putExpectation({ bindingId: this.bindingId, kind: 'delete', canonicalId });
    await this.adapter.remove(mirror.browserId);
    await this.store.deleteMirrorMany(this.bindingId, subtree);
  }

  // --- reconciliation steps (doc 08 §13) ---

  async applySteps(steps: ApplyStep[]): Promise<void> {
    for (const step of steps) {
      switch (step.kind) {
        case 'assign_identity': {
          // A pre-reconciliation capture may have mapped this browser
          // node to a client-generated id: the server-confirmed identity
          // replaces it.
          const stale = await this.store.getMirrorByBrowser(this.bindingId, step.local_ref!);
          if (stale && stale.canonicalId !== step.canonical_id) {
            await this.store.deleteMirrorMany(this.bindingId, [stale.canonicalId]);
          }
          const existing = await this.store.getMirrorByCanonical(this.bindingId, step.canonical_id!);
          if (existing) {
            break; // ensure-state: mapping already established
          }
          const node = await this.adapter.getNode(step.local_ref!);
          if (!node) {
            throw new Error(`applier: assign_identity for unknown browser node ${step.local_ref}`);
          }
          await this.store.putMirror({
            bindingId: this.bindingId,
            canonicalId: step.canonical_id!,
            browserId: step.local_ref!,
            type: node.type as 'folder' | 'bookmark',
            title: node.title,
            url: node.url,
            // Provisional placement; rebuilt from the browser tree below.
            parentType: 'root',
            parentRootKey: '',
            position: -1,
          });
          break;
        }
        case 'create': {
          const existing = await this.store.getMirrorByCanonical(this.bindingId, step.canonical_id!);
          if (existing) {
            break; // ensure-state
          }
          const parent = step.parent ?? { type: 'root', key: 'main' };
          const parentBrowserId = await this.resolveParentBrowser(parent);
          await this.store.putExpectation({
            bindingId: this.bindingId,
            kind: 'create',
            canonicalId: step.canonical_id!,
            parentBrowserId,
            type: step.type!,
            title: step.title!,
            url: step.url,
          });
          const created = await this.adapter.create(parentBrowserId, step.type!, step.title!, step.url);
          const node = await this.store.getMirrorByBrowser(this.bindingId, created.id);
          if (!node) {
            await this.store.putMirror({
              bindingId: this.bindingId,
              canonicalId: step.canonical_id!,
              browserId: created.id,
              type: step.type!,
              title: step.title!,
              url: step.url,
              ...parentColumns(parent),
              position: -1,
            });
          }
          break;
        }
        case 'update': {
          await this.ensureFields(step.canonical_id!, step.title, step.url);
          break;
        }
        case 'move': {
          const mirror = await this.store.getMirrorByCanonical(this.bindingId, step.canonical_id!);
          if (!mirror) {
            throw new Error(`applier: move step for unknown node ${step.canonical_id}`);
          }
          const parent = step.parent!;
          const parentBrowserId = await this.resolveParentBrowser(parent);
          const node = await this.adapter.getNode(mirror.browserId);
          let index: number | undefined;
          if (step.before_id) {
            const anchor = await this.store.getMirrorByCanonical(this.bindingId, step.before_id);
            if (anchor) {
              const browserChildren = await this.adapter.getChildren(parentBrowserId);
              const at = browserChildren.findIndex((c) => c.id === anchor.browserId);
              const selfAt = browserChildren.findIndex((c) => c.id === mirror.browserId);
              if (at >= 0) {
                index = at - (selfAt >= 0 && selfAt < at ? 1 : 0);
              }
            }
          }
          if (node!.parentId !== parentBrowserId || index !== undefined) {
            await this.store.putExpectation({ bindingId: this.bindingId, kind: 'move', canonicalId: step.canonical_id! });
            await this.adapter.move(mirror.browserId, parentBrowserId, index);
          }
          break;
        }
        case 'delete': {
          const mirror = await this.store.getMirrorByCanonical(this.bindingId, step.canonical_id!);
          if (!mirror) {
            break; // ensure-state: already gone
          }
          const subtree = await this.subtreeCanonicalIds(step.canonical_id!);
          await this.store.putExpectation({ bindingId: this.bindingId, kind: 'delete', canonicalId: step.canonical_id! });
          await this.adapter.remove(mirror.browserId);
          await this.store.deleteMirrorMany(this.bindingId, subtree);
          break;
        }
        default:
          throw new Error(`applier: unknown step kind ${step.kind}`);
      }
    }
    // Steps carry anchors rather than final positions: rebuild the
    // mirror's parent/position columns from the browser tree (doc 05 §4
    // integrity scan).
    await this.rebuildMirrorFromBrowser();
  }

  /** Refreshes mirror parent/position from the actual browser tree. */
  async rebuildMirrorFromBrowser(): Promise<void> {
    const binding = await this.store.getBinding(this.bindingId);
    if (!binding) {
      return;
    }
    for (const rootKey of Object.keys(binding.rootMap)) {
      const browserRootId = binding.rootMap[rootKey]!;
      await this.walk(browserRootId, { type: 'root', key: rootKey });
    }
  }

  private async walk(browserId: string, parentRef: ParentRef): Promise<void> {
    const children = await this.adapter.getChildren(browserId);
    let position = 0;
    for (const child of children) {
      const mirror = await this.store.getMirrorByBrowser(this.bindingId, child.id);
      if (!mirror) {
        continue;
      }
      await this.store.putMirror({ ...mirror, ...parentColumns(parentRef), position });
      position++;
      if (child.type === 'folder') {
        await this.walk(child.id, { type: 'node', id: mirror.canonicalId });
      }
    }
  }

  // --- helpers ---

  private async resolveParentBrowser(parent: ParentRef): Promise<string> {
    if (parent.type === 'root') {
      const binding = await this.store.getBinding(this.bindingId);
      const mapped = binding?.rootMap[parent.key!];
      if (mapped) {
        return mapped;
      }
      // Unknown root slot (Recovered/<Device>, doc 04 §11): project it as
      // a container folder under the first managed root. The expectation
      // makes the capture treat the folder as a container, not data.
      const roots = Object.values(binding?.rootMap ?? {});
      if (roots.length === 0) {
        throw new Error(`applier: no managed root to host unmapped slot ${parent.key}`);
      }
      const host = roots[0]!;
      const rootKey = parent.key!;
      await this.store.putExpectation({
        bindingId: this.bindingId,
        kind: 'project_root',
        title: rootKey,
        parentBrowserId: host,
      });
      const folder = await this.adapter.create(host, 'folder', rootKey);
      const rootMap = { ...(binding?.rootMap ?? {}), [rootKey]: folder.id };
      await this.store.setRootMap(this.bindingId, rootMap);
      return folder.id;
    }
    const mirror = await this.store.getMirrorByCanonical(this.bindingId, parent.id!);
    if (!mirror) {
      throw new Error(`applier: parent ${parent.id} not known to the replica`);
    }
    return mirror.browserId;
  }

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

function parentColumns(ref: ParentRef): Pick<MirrorNode, 'parentType' | 'parentCanonicalId' | 'parentRootKey'> {
  if (ref.type === 'node') {
    return { parentType: 'node', parentCanonicalId: ref.id, parentRootKey: undefined };
  }
  return { parentType: 'root', parentCanonicalId: undefined, parentRootKey: ref.key };
}
