// BrowserAdapter isolates Chrome/Edge/Firefox bookmark APIs from the
// sync core (doc 05 §2). The core never calls chrome.bookmarks directly.

export interface BrowserNode {
  id: string;
  /** null for browser root containers. */
  parentId: string | null;
  type: 'root' | 'folder' | 'bookmark';
  title: string;
  url?: string;
}

export interface BrowserRoot {
  id: string;
  title: string;
}

export type BrowserEvent =
  | { kind: 'created'; node: BrowserNode }
  | { kind: 'changed'; id: string; title: string; url?: string }
  | { kind: 'moved'; id: string; parentId: string; index: number }
  | { kind: 'removed'; id: string };

/**
 * The subset of the browser bookmark API the sync core needs. All
 * mutation methods return the affected node where the platform allows
 * it; that return value is the V1 confirmation that browser state has
 * changed (doc 05 §11, crash rule 4).
 */
export interface BrowserAdapter {
  listRoots(): Promise<BrowserRoot[]>;
  getNode(id: string): Promise<BrowserNode | undefined>;
  getChildren(parentId: string): Promise<BrowserNode[]>;

  create(parentId: string, type: 'folder' | 'bookmark', title: string, url?: string): Promise<BrowserNode>;
  update(id: string, fields: { title?: string; url?: string }): Promise<void>;
  move(id: string, parentId: string, index?: number): Promise<void>;
  remove(id: string): Promise<void>;

  /** Subscribes to bookmark mutations; returns an unsubscribe fn. */
  onEvent(handler: (event: BrowserEvent) => void | Promise<void>): () => void;
}
