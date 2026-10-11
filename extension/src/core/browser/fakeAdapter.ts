// In-memory Browser Adapter for core tests: a simple bookmark tree with
// a call log and an onMutation hook (used to assert that expectations are
// persisted before the browser API runs).

import type { BrowserAdapter, BrowserNode } from './types';
import type { NodeType } from '../protocol/types';

export interface FakeAdapterOptions {
  /** Invoked at the start of every mutating call (create/update/move/remove). */
  onMutation?: (call: string) => Promise<void> | void;
}

export class FakeBrowserAdapter implements BrowserAdapter {
  private nodes = new Map<string, BrowserNode>();
  private nextId = 1;
  calls: string[] = [];

  private listeners = {
    created: new Set<(node: BrowserNode) => void>(),
    changed: new Set<(node: BrowserNode) => void>(),
    moved: new Set<(node: BrowserNode, oldParentId: string | null) => void>(),
    removed: new Set<(node: BrowserNode) => void>(),
  };

  constructor(private options: FakeAdapterOptions = {}) {}

  // --- test tree construction ---

  seed(node: {
    id: string;
    parentId: string | null;
    title: string;
    url?: string | null;
    index?: number;
    folderType?: string;
    unmodifiable?: boolean;
  }): BrowserNode {
    const type: NodeType = node.url == null ? 'folder' : 'bookmark';
    const full: BrowserNode = {
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      url: node.url ?? null,
      type,
      index: node.index ?? this.childrenOf(node.parentId).length,
      ...(node.folderType == null ? {} : { folderType: node.folderType }),
      ...(node.unmodifiable ? { unmodifiable: true } : {}),
    };
    this.nodes.set(full.id, full);
    // Generated ids continue the seeded bN sequence: without this, a create
    // would hand back an id the test already seeded and overwrite that node.
    const seededIndex = /^b(\d+)$/.exec(full.id);
    if (seededIndex) this.nextId = Math.max(this.nextId, Number(seededIndex[1]) + 1);
    return full;
  }

  // --- listener emission for tests ---

  emitCreated(node: BrowserNode): void {
    for (const l of this.listeners.created) l(node);
  }

  emitChanged(node: BrowserNode): void {
    for (const l of this.listeners.changed) l(node);
  }

  emitMoved(node: BrowserNode, oldParentId: string | null): void {
    for (const l of this.listeners.moved) l(node, oldParentId);
  }

  emitRemoved(node: BrowserNode): void {
    for (const l of this.listeners.removed) l(node);
  }

  // --- BrowserAdapter ---

  async getNode(id: string): Promise<BrowserNode | null> {
    return this.nodes.get(id) ?? null;
  }

  async getChildren(parentId: string): Promise<BrowserNode[]> {
    // The real browser hands back policy folders; the adapter contract hides
    // them because nothing under one can be written (see types.ts).
    return this.childrenOf(parentId).filter((n) => !n.unmodifiable).sort((a, b) => a.index - b.index);
  }

  /** The browser's own restrictions, mirrored rather than papered over. */
  private guardItem(verb: string, node: BrowserNode): void {
    if (node.folderType != null || node.parentId == null) {
      throw new Error(`fakeAdapter: ${verb} of browser folder ${node.id} is not supported`);
    }
    if (this.policyLocked(node)) {
      throw new Error(`fakeAdapter: ${verb} of policy-locked ${node.id} is not supported`);
    }
  }

  private guardContents(verb: string, parentId: string): void {
    const parent = this.nodes.get(parentId);
    if (!parent) throw new Error(`fakeAdapter: ${verb} into unknown parent ${parentId}`);
    // The bar and "other bookmarks" take children; the hidden root they hang
    // off does not.
    if (parent.parentId == null) {
      throw new Error(`fakeAdapter: ${verb} into the root folder is not supported`);
    }
    if (this.policyLocked(parent)) {
      throw new Error(`fakeAdapter: ${verb} into policy-locked ${parentId} is not supported`);
    }
  }

  private policyLocked(node: BrowserNode): boolean {
    let cur: BrowserNode | undefined = node;
    while (cur) {
      if (cur.unmodifiable) return true;
      cur = cur.parentId == null ? undefined : this.nodes.get(cur.parentId);
    }
    return false;
  }

  async create(parentId: string, details: { title: string; url?: string; index?: number | null }): Promise<BrowserNode> {
    await this.options.onMutation?.(`create:${parentId}:${details.title}`);
    this.calls.push(`create:${parentId}:${details.title}`);
    this.guardContents('create', parentId);
    const ordered = await this.getChildren(parentId);
    const at =
      details.index == null ? ordered.length : Math.max(0, Math.min(details.index, ordered.length));
    const node: BrowserNode = {
      id: `b${this.nextId++}`,
      parentId,
      title: details.title,
      url: details.url ?? null,
      type: details.url ? 'bookmark' : 'folder',
      index: at,
    };
    this.nodes.set(node.id, node);
    ordered.splice(at, 0, node);
    ordered.forEach((n, i) => {
      n.index = i;
    });
    return node;
  }

  async update(id: string, changes: { title?: string; url?: string }): Promise<void> {
    await this.options.onMutation?.(`update:${id}`);
    this.calls.push(`update:${id}`);
    const node = this.nodes.get(id);
    if (!node) throw new Error(`fakeAdapter: update of unknown node ${id}`);
    this.guardItem('update', node);
    if (changes.title !== undefined) node.title = changes.title;
    if (changes.url !== undefined) node.url = changes.url;
  }

  async move(id: string, parentId: string, index: number | null): Promise<void> {
    await this.options.onMutation?.(`move:${id}:${parentId}:${index ?? 'append'}`);
    this.calls.push(`move:${id}:${parentId}:${index ?? 'append'}`);
    const node = this.nodes.get(id);
    if (!node) throw new Error(`fakeAdapter: move of unknown node ${id}`);
    this.guardItem('move', node);
    this.guardContents('move', parentId);
    const oldParent = node.parentId;
    // Insertion order is not sibling order: re-splice against the current
    // index sequence, otherwise a move lands in creation order.
    const siblings = (await this.getChildren(parentId)).filter((n) => n.id !== id);
    const targetIndex = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    siblings.splice(targetIndex, 0, node);
    siblings.forEach((n, i) => {
      n.parentId = parentId;
      n.index = i;
    });
    // Leaving a parent compacts the siblings it dropped, exactly as the
    // browser renumbers them; skipping this leaves gaps in the fake.
    if (oldParent !== parentId) await this.renumber(oldParent);
  }

  /**
   * Mirror the browser's restriction rather than being more permissive: a
   * test double that silently recursed would hide exactly the bug the real
   * API raises.
   */
  async removeBookmark(id: string): Promise<void> {
    await this.options.onMutation?.(`removeBookmark:${id}`);
    this.calls.push(`removeBookmark:${id}`);
    const node = this.nodes.get(id);
    if (!node) throw new Error(`fakeAdapter: removeBookmark of unknown node ${id}`);
    this.guardItem('removeBookmark', node);
    if (node.type === 'folder') {
      throw new Error(`fakeAdapter: removeBookmark of folder ${id} requires removeSubtree`);
    }
    this.nodes.delete(id);
    await this.renumber(node.parentId);
  }

  async removeSubtree(id: string): Promise<void> {
    await this.options.onMutation?.(`removeSubtree:${id}`);
    this.calls.push(`removeSubtree:${id}`);
    const root = this.nodes.get(id);
    if (!root) throw new Error(`fakeAdapter: removeSubtree of unknown node ${id}`);
    this.guardItem('removeSubtree', root);
    const removeRec = (nid: string) => {
      for (const child of this.childrenOf(nid)) removeRec(child.id);
      this.nodes.delete(nid);
    };
    removeRec(id);
    await this.renumber(root.parentId);
  }

  private async renumber(parentId: string | null): Promise<void> {
    if (parentId == null) return;
    (await this.getChildren(parentId)).forEach((n, i) => {
      n.index = i;
    });
  }

  onCreated(handler: (node: BrowserNode) => void): () => void {
    this.listeners.created.add(handler);
    return () => this.listeners.created.delete(handler);
  }

  onChanged(handler: (node: BrowserNode) => void): () => void {
    this.listeners.changed.add(handler);
    return () => this.listeners.changed.delete(handler);
  }

  onMoved(handler: (node: BrowserNode, oldParentId: string | null) => void): () => void {
    this.listeners.moved.add(handler);
    return () => this.listeners.moved.delete(handler);
  }

  onRemoved(handler: (node: BrowserNode) => void): () => void {
    this.listeners.removed.add(handler);
    return () => this.listeners.removed.delete(handler);
  }

  // --- internals ---

  private childrenOf(parentId: string | null): BrowserNode[] {
    return [...this.nodes.values()].filter((n) => n.parentId === parentId);
  }
}
