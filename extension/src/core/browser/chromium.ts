// Chromium (Chrome/Edge) implementation of the Browser Adapter over
// chrome.bookmarks. Firefox gets its own adapter later; the sync core
// only depends on the BrowserAdapter interface.

import type { NodeType } from '../protocol/types';
import type { BrowserAdapter, BrowserNode } from './types';

/** Structural subset of chrome.bookmarks.BookmarkTreeNode we rely on. */
export interface ChromeBookmarkNode {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
}

/** Structural subset of the chrome.bookmarks namespace. */
export interface ChromeBookmarksApi {
  get(idOrIds: string | string[]): Promise<ChromeBookmarkNode[]>;
  getChildren(id: string): Promise<ChromeBookmarkNode[]>;
  create(bookmark: { parentId: string; title?: string; url?: string; index?: number }): Promise<ChromeBookmarkNode>;
  update(id: string, changes: { title?: string; url?: string }): Promise<ChromeBookmarkNode>;
  move(id: string, destination: { parentId: string; index?: number }): Promise<ChromeBookmarkNode>;
  /** Rejects for a folder with children; the browser requires removeTree. */
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
  onCreated: ChromeEvent<(id: string, node: ChromeBookmarkNode) => void>;
  onChanged: ChromeEvent<(id: string, info: { title: string; url?: string }) => void>;
  onMoved: ChromeEvent<(id: string, info: { parentId: string; index: number; oldParentId: string }) => void>;
  onRemoved: ChromeEvent<(id: string, info: { parentId: string; index: number; node: ChromeBookmarkNode }) => void>;
}

interface ChromeEvent<T extends (...args: never[]) => void> {
  addListener(cb: T): void;
  removeListener(cb: T): void;
}

function toNode(n: ChromeBookmarkNode): BrowserNode {
  const type: NodeType = n.url == null ? 'folder' : 'bookmark';
  return {
    id: n.id,
    parentId: n.parentId ?? null,
    title: n.title,
    url: type === 'bookmark' ? (n.url ?? null) : null,
    type,
    index: n.index ?? 0,
  };
}

/**
 * chrome.bookmarks.get rejects rather than resolving to an empty list when
 * the id is unknown. Existence probes are the main use of getNode, so that
 * rejection is the not-found result, not an error to propagate.
 */
function isUnknownItemId(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /no item with the given id|non-?existant item id|cannot find\b|not found/i.test(message);
}

export function createChromiumAdapter(api: ChromeBookmarksApi): BrowserAdapter {
  const getNode = async (id: string): Promise<BrowserNode | null> => {
    let nodes: ChromeBookmarkNode[];
    try {
      nodes = await api.get(id);
    } catch (err) {
      if (isUnknownItemId(err)) return null;
      throw err;
    }
    const [n] = nodes;
    return n ? toNode(n) : null;
  };

  return {
    getNode,
    getChildren: async (parentId) => (await api.getChildren(parentId)).map(toNode),
    create: async (parentId, details) =>
      toNode(
        await api.create({
          parentId,
          title: details.title,
          url: details.url,
          // Chrome treats an explicit undefined index as "append", but the
          // key must stay absent for the parameter to be ignored at all.
          ...(details.index == null ? {} : { index: details.index }),
        }),
      ),
    update: async (id, changes) => {
      await api.update(id, changes);
    },
    move: async (id, parentId, index) => {
      await api.move(id, { parentId, index: index ?? undefined });
    },
    removeBookmark: async (id) => {
      await api.remove(id);
    },
    removeSubtree: async (id) => {
      await api.removeTree(id);
    },
    onCreated: (h) => {
      const l = (_id: string, node: ChromeBookmarkNode) => h(toNode(node));
      api.onCreated.addListener(l);
      return () => api.onCreated.removeListener(l);
    },
    onChanged: (h) => {
      const l = async (id: string) => {
        // onChanged only carries the new title/url; refresh for a full node.
        const node = await getNode(id);
        if (node) h(node);
      };
      api.onChanged.addListener(l);
      return () => api.onChanged.removeListener(l);
    },
    onMoved: (h) => {
      const l = async (id: string, info: { oldParentId: string }) => {
        const node = await getNode(id);
        if (node) h(node, info.oldParentId);
      };
      api.onMoved.addListener(l);
      return () => api.onMoved.removeListener(l);
    },
    onRemoved: (h) => {
      const l = (id: string, info: { parentId: string; index: number; node: ChromeBookmarkNode }) =>
        h(toNode({ ...info.node, id, parentId: info.parentId, index: info.index }));
      api.onRemoved.addListener(l);
      return () => api.onRemoved.removeListener(l);
    },
  };
}
