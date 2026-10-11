// A stand-in for chrome.bookmarks that behaves like the real API, not like
// an idealized one: unknown ids reject, remove() refuses a folder that still
// has children, and the folders the browser owns — the hidden root, anything
// with a folderType, anything under a policy-managed folder — refuse every
// write. The adapter contract suite runs the fake adapter and the Chromium
// adapter against the same rules so a permissive test double cannot mask a
// real-API failure.

import type { ChromeBookmarkNode, ChromeBookmarksApi } from '../core/browser/chromium';

export interface ChromeTreeSeed {
  id: string;
  /** Omitted for a browser root, which has no parent, like chrome.bookmarks. */
  parentId?: string;
  title: string;
  url?: string;
  index?: number;
  folderType?: string;
  unmodifiable?: boolean;
}

class ChromeError extends Error {}

/** A parentless node is the hidden root the bar and "other bookmarks" hang off. */
const isRootFolder = (node: ChromeBookmarkNode): boolean => node.parentId == null;

function notFound(id: string): ChromeError {
  return new ChromeError(
    `Error in function bookmarks.get, argument 1: No item with the given ID was found. (id: ${id})`,
  );
}

function refused(verb: string, reason: string): ChromeError {
  return new ChromeError(`Error in function bookmarks.${verb}: ${reason}`);
}

// Verbatim from a real profile (Chrome 153), which says this for the bar,
// "other bookmarks" and the hidden root alike.
const BROWSER_ROOT = "Can't modify the root bookmark folders.";
const POLICY_LOCKED = 'The item belongs to a folder managed by policy.';

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

  /** The node plus every ancestor: Chrome applies its rules to the chain. */
  const chain = (node: ChromeBookmarkNode): ChromeBookmarkNode[] => {
    const out: ChromeBookmarkNode[] = [];
    let cur: ChromeBookmarkNode | undefined = node;
    while (cur) {
      out.push(cur);
      cur = cur.parentId == null ? undefined : nodes.get(cur.parentId);
    }
    return out;
  };

  const policyLocked = (node: ChromeBookmarkNode): boolean =>
    chain(node).some((n) => n.unmodifiable === true);

  /** A write aimed at one item: browser folders and policy items are frozen. */
  const guardItem = (verb: string, node: ChromeBookmarkNode): void => {
    if (node.folderType != null || isRootFolder(node)) throw refused(verb, BROWSER_ROOT);
    if (policyLocked(node)) throw refused(verb, POLICY_LOCKED);
  };

  /**
   * A write aimed at a folder's contents. The bar and "other bookmarks" are
   * browser folders you may write into — only the root and policy-managed
   * folders refuse their children.
   */
  const guardContents = (verb: string, folder: ChromeBookmarkNode): void => {
    if (isRootFolder(folder)) throw refused(verb, BROWSER_ROOT);
    if (policyLocked(folder)) throw refused(verb, POLICY_LOCKED);
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
        ...(seed.folderType == null ? {} : { folderType: seed.folderType }),
        ...(seed.unmodifiable ? { unmodifiable: true } : {}),
      };
      nodes.set(node.id, node);
    },
    get: async (idOrIds) => {
      const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
      return ids.map(mustGet);
    },
    getChildren: async (id) => childrenOf(mustGet(id).id),
    create: async ({ parentId, title, url, index }) => {
      guardContents('create', mustGet(parentId));
      const node: ChromeBookmarkNode = { id: String(nextId++), parentId, title: title ?? '', url, index: 0 };
      insert(node, index);
      return node;
    },
    update: async (id, changes) => {
      const node = mustGet(id);
      guardItem('update', node);
      if (changes.title !== undefined) node.title = changes.title;
      if (changes.url !== undefined) node.url = changes.url;
      return node;
    },
    move: async (id, destination) => {
      const node = mustGet(id);
      const dest = mustGet(destination.parentId);
      guardItem('move', node);
      guardContents('move', dest);
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
      guardItem('remove', node);
      if (childrenOf(node.id).length > 0) {
        throw new ChromeError('Error in function bookmarks.remove: Removing items that have children is not supported.');
      }
      const parentId = node.parentId!;
      nodes.delete(id);
      renumber(parentId);
    },
    removeTree: async (id) => {
      const node = mustGet(id);
      guardItem('removeTree', node);
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
