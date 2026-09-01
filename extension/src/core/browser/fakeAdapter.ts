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
  }): BrowserNode {
    const type: NodeType = node.url == null ? 'folder' : 'bookmark';
    const full: BrowserNode = {
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      url: node.url ?? null,
      type,
      index: node.index ?? this.childrenOf(node.parentId).length,
    };
    this.nodes.set(full.id, full);
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
    return this.childrenOf(parentId).sort((a, b) => a.index - b.index);
  }

  async create(parentId: string, details: { title: string; url?: string }): Promise<BrowserNode> {
    await this.options.onMutation?.(`create:${parentId}:${details.title}`);
    this.calls.push(`create:${parentId}:${details.title}`);
    const node: BrowserNode = {
      id: `b${this.nextId++}`,
      parentId,
      title: details.title,
      url: details.url ?? null,
      type: details.url ? 'bookmark' : 'folder',
      index: this.childrenOf(parentId).length,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  async update(id: string, changes: { title?: string; url?: string }): Promise<void> {
    await this.options.onMutation?.(`update:${id}`);
    this.calls.push(`update:${id}`);
    const node = this.nodes.get(id);
    if (!node) throw new Error(`fakeAdapter: update of unknown node ${id}`);
    if (changes.title !== undefined) node.title = changes.title;
    if (changes.url !== undefined) node.url = changes.url;
  }

  async move(id: string, parentId: string, index: number | null): Promise<void> {
    await this.options.onMutation?.(`move:${id}:${parentId}:${index ?? 'append'}`);
    this.calls.push(`move:${id}:${parentId}:${index ?? 'append'}`);
    const node = this.nodes.get(id);
    if (!node) throw new Error(`fakeAdapter: move of unknown node ${id}`);
    const oldParent = node.parentId;
    const siblings = this.childrenOf(parentId).filter((n) => n.id !== id);
    const targetIndex = index == null ? siblings.length : Math.min(index, siblings.length);
    siblings.splice(targetIndex, 0, node);
    siblings.forEach((n, i) => {
      n.parentId = parentId;
      n.index = i;
    });
    void oldParent;
  }

  async remove(id: string): Promise<void> {
    await this.options.onMutation?.(`remove:${id}`);
    this.calls.push(`remove:${id}`);
    const node = this.nodes.get(id);
    if (!node) return;
    const removeRec = (nid: string) => {
      for (const child of this.childrenOf(nid)) removeRec(child.id);
      this.nodes.delete(nid);
    };
    removeRec(id);
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
