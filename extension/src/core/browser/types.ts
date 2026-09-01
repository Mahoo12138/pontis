// Browser Adapter contract (doc 05 §2): sync logic never touches
// chrome.bookmarks.* directly; Chrome/Edge/Firefox differences stay here.

import type { NodeType } from '../protocol/types';

export interface BrowserNode {
  id: string;
  parentId: string | null;
  title: string;
  url: string | null;
  type: NodeType;
  /** Sibling index within the parent's children. */
  index: number;
}

/**
 * Events are captured from the adapter, never suppressed (doc 05 §8):
 * remote mutations go through expected-mutation matching instead.
 */
export type BrowserEvent =
  | { kind: 'created'; node: BrowserNode }
  | { kind: 'changed'; node: BrowserNode }
  | { kind: 'moved'; node: BrowserNode; oldParentId: string | null }
  | { kind: 'removed'; node: BrowserNode };

export interface BrowserAdapter {
  getNode(id: string): Promise<BrowserNode | null>;
  getChildren(parentId: string): Promise<BrowserNode[]>;
  create(parentId: string, details: { title: string; url?: string }): Promise<BrowserNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<void>;
  move(id: string, parentId: string, index: number | null): Promise<void>;
  remove(id: string): Promise<void>;
  onCreated(handler: (node: BrowserNode) => void): () => void;
  onChanged(handler: (node: BrowserNode) => void): () => void;
  onMoved(handler: (node: BrowserNode, oldParentId: string | null) => void): () => void;
  onRemoved(handler: (node: BrowserNode) => void): () => void;
}
