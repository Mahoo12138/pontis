import { BrowserAdapter, BrowserEvent, BrowserNode, BrowserRoot } from './types';

/**
 * In-memory BrowserAdapter: the test double for the real browser API
 * (doc 21 §10). Semantics mirror chrome.bookmarks: mutations emit
 * events synchronously, remove() takes a whole subtree.
 */
export class FakeBrowserAdapter implements BrowserAdapter {
  private nodes = new Map<string, BrowserNode>();
  private children = new Map<string, string[]>();
  private nextId = 1;
  private handlers = new Set<(event: BrowserEvent) => void>();

  constructor(rootTitles: string[] = ['Bar']) {
    for (const title of rootTitles) {
      this.addRoot(title);
    }
  }

  private addRoot(title: string): string {
    const id = `root-${this.nextId++}`;
    this.nodes.set(id, { id, parentId: null, type: 'root', title });
    this.children.set(id, []);
    return id;
  }

  listRoots(): Promise<BrowserRoot[]> {
    const roots: BrowserRoot[] = [];
    for (const node of this.nodes.values()) {
      if (node.type === 'root') {
        roots.push({ id: node.id, title: node.title });
      }
    }
    return Promise.resolve(roots);
  }

  async getNode(id: string): Promise<BrowserNode | undefined> {
    return this.nodes.get(id);
  }

  async getChildren(parentId: string): Promise<BrowserNode[]> {
    return (this.children.get(parentId) ?? [])
      .map((id) => this.nodes.get(id)!)
      .filter((n) => n !== undefined);
  }

  async create(parentId: string, type: 'folder' | 'bookmark', title: string, url?: string): Promise<BrowserNode> {
    if (!this.nodes.has(parentId)) {
      throw new Error(`fake-adapter: unknown parent ${parentId}`);
    }
    const id = `node-${this.nextId++}`;
    const node: BrowserNode = { id, parentId, type, title, url };
    this.nodes.set(id, node);
    this.children.set(id, []);
    this.children.get(parentId)!.push(id);
    await this.emit({ kind: 'created', node: { ...node } });
    return { ...node };
  }

  async update(id: string, fields: { title?: string; url?: string }): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`fake-adapter: unknown node ${id}`);
    }
    if (fields.title !== undefined) {
      node.title = fields.title;
    }
    if (fields.url !== undefined) {
      node.url = fields.url;
    }
    await this.emit({ kind: 'changed', id, title: node.title, url: node.url });
  }

  async move(id: string, parentId: string, index?: number): Promise<void> {
    const node = this.nodes.get(id);
    if (!node || !this.nodes.has(parentId)) {
      throw new Error(`fake-adapter: cannot move ${id} to ${parentId}`);
    }
    const from = this.children.get(node.parentId!)!;
    from.splice(from.indexOf(id), 1);
    node.parentId = parentId;
    const to = this.children.get(parentId)!;
    const at = index === undefined ? to.length : Math.min(index, to.length);
    to.splice(at, 0, id);
    await this.emit({ kind: 'moved', id, parentId, index: at });
  }

  async remove(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) {
      return; // chrome.bookmarks is a no-op for missing ids
    }
    // Collect the subtree before mutating: children reference parents
    // that are about to disappear.
    const subtree: string[] = [];
    const collect = (cur: string) => {
      subtree.push(cur);
      for (const child of this.children.get(cur) ?? []) {
        collect(child);
      }
    };
    collect(id);
    if (node.parentId) {
      const siblings = this.children.get(node.parentId)!;
      const at = siblings.indexOf(id);
      if (at >= 0) {
        siblings.splice(at, 1);
      }
    }
    for (const cur of subtree) {
      this.children.delete(cur);
      this.nodes.delete(cur);
    }
    await this.emit({ kind: 'removed', id });
  }

  onEvent(handler: (event: BrowserEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private async emit(event: BrowserEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
    // Let IndexedDB transactions commit before the mutation returns so
    // tests observe a settled state (real callers go through the same
    // async pipeline anyway).
    await new Promise((resolve) => setImmediate(resolve));
  }
}
