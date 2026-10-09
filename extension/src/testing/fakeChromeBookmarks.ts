// A stand-in for chrome.bookmarks that behaves like the real API, not like
// an idealized one: unknown ids reject, and remove() refuses a folder that
// still has children. The adapter contract suite runs the fake adapter and
// the Chromium adapter against the same rules so a permissive test double
// cannot mask a real-API failure.

import type { ChromeBookmarkNode, ChromeBookmarksApi } from '../core/browser/chromium';

export interface ChromeTreeSeed {
  id: string;
  /** Omitted for a browser root, which has no parent, like chrome.bookmarks. */
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
}

class ChromeError extends Error {}

function notFound(id: string): ChromeError {
  return new ChromeError(
    `Error in function bookmarks.get, argument 1: No item with the given ID was found. (id: ${id})`,
  );
}

export interface FakeChrome extends ChromeBookmarksApi {
  /** Raw tree for assertions; mirrors what the browser actually holds. */
  tree(): ChromeBookmarkNode[];
  seedNode(node: ChromeTreeSeed): void;
}

export function createFakeChromeApi(): FakeChrome {
  const nodes = new Map<string, ChromeBookmarkNode>();
  let nextId = 100;

  const childrenOf = (parentId: string): ChromeBookmarkNode[] =>
    [...nodes.values()].filter((n) => n.parentId === parentId).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const mustGet = (id: string): ChromeBookmarkNode => {
    const n = nodes.get(id);
    if (!n) throw notFound(id);
    return n;
  };

  const renumber = (parentId: string) => {
    childrenOf(parentId).forEach((n, i) => {
      n.index = i;
    });
  };

  const insert = (node: ChromeBookmarkNode, index: number | undefined) => {
    const siblings = childrenOf(node.parentId!);
    const at = index == null ? siblings.length : Math.max(0, Math.min(index, siblings.length));
    siblings.splice(at, 0, node);
    siblings.forEach((n, i) => {
      n.index = i;
    });
    nodes.set(node.id, node);
  };

  const api: FakeChrome = {
    tree: () => [...nodes.values()],
    seedNode: (seed) => {
      const node: ChromeBookmarkNode = {
        id: seed.id,
        parentId: seed.parentId,
        title: seed.title,
        url: seed.url,
        index: seed.index ?? childrenOf(seed.parentId ?? '').length,
      };
      nodes.set(node.id, node);
    },
    get: async (idOrIds) => {
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
      return ids.map(mustGet);
    },
    getChildren: async (id) => childrenOf(mustGet(id).id),
    create: async ({ parentId, title, url, index }) => {
      mustGet(parentId);
      const node: ChromeBookmarkNode = { id: String(nextId++), parentId, title: title ?? '', url, index: 0 };
      insert(node, index);
      return node;
    },
    update: async (id, changes) => {
      const node = mustGet(id);
      if (changes.title !== undefined) node.title = changes.title;
      if (changes.url !== undefined) node.url = changes.url;
      return node;
    },
    move: async (id, destination) => {
      const node = mustGet(id);
      mustGet(destination.parentId);
      const oldParent = node.parentId!;
      const sameParent = oldParent === destination.parentId;
      const remaining = childrenOf(oldParent).filter((n) => n.id !== id);
      if (!sameParent) remaining.forEach((n, i) => (n.index = i));
      const siblings = sameParent ? remaining : childrenOf(destination.parentId);
      const at =
        destination.index == null
          ? siblings.length
          : Math.max(0, Math.min(destination.index, siblings.length));
      siblings.splice(at, 0, node);
      siblings.forEach((n, i) => {
        n.index = i;
        n.parentId = destination.parentId;
      });
      nodes.set(id, { ...node, parentId: destination.parentId });
      return nodes.get(id)!;
    },
    remove: async (id) => {
      const node = mustGet(id);
      if (childrenOf(node.id).length > 0) {
        throw new ChromeError('Error in function bookmarks.remove: Removing items that have children is not supported.');
      }
      const parentId = node.parentId!;
      nodes.delete(id);
      renumber(parentId);
    },
    removeTree: async (id) => {
      const node = mustGet(id);
      const drop = (n: ChromeBookmarkNode) => {
        for (const child of childrenOf(n.id)) drop(child);
        nodes.delete(n.id);
      };
      const parentId = node.parentId!;
      drop(node);
      renumber(parentId);
    },
    onCreated: { addListener: () => {}, removeListener: () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} },
    onMoved: { addListener: () => {}, removeListener: () => {} },
    onRemoved: { addListener: () => {}, removeListener: () => {} },
  };

  return api;
}
