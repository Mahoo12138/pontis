/**
 * Structure analysis over a space's node tree.
 *
 * Takes the `TreeIndex` the explorer already builds (features/explorer/tree.ts)
 * rather than re-deriving parents — the analytics page and the list must agree
 * about what the tree is, or the numbers stop being checkable.
 */
import type { Node } from '@pontis/api';
import type { TreeIndex } from '../explorer/tree';
import type { CountBucket } from './buckets';
import { bandCounts } from './buckets';

/** A folder with its recursive subtree size and its path from a root. */
export interface FolderStat {
  node: Node;
  /** Bookmarks anywhere below, not just direct children. */
  bookmarks: number;
  folders: number;
  /** Bookmarks that are direct children. */
  directBookmarks: number;
  /** Titles from the top-level ancestor down to this folder, inclusive. */
  path: string[];
  depth: number;
}

/**
 * Titles from the top-level ancestor down to this node, inclusive.
 *
 * Climbs `parentOf`, the same walk the breadcrumb does
 * (routes/space-explorer.tsx:100-107). The root *slot* is not a node, so it
 * never appears here — callers prepend the space name when they want it.
 */
export function pathOf(index: TreeIndex, nodeId: string): string[] {
  const parts: string[] = [];
  let cur = index.byId.get(nodeId);
  while (cur) {
    parts.unshift(cur.title);
    cur = index.parentOf.get(cur.id) ?? undefined;
  }
  return parts;
}

/** 1-based nesting level of a node; roots sit at depth 1. */
export function depthOf(index: TreeIndex, nodeId: string): number {
  let depth = 0;
  let cur = index.byId.get(nodeId);
  while (cur) {
    depth += 1;
    cur = index.parentOf.get(cur.id) ?? undefined;
  }
  return depth;
}

/**
 * Every folder with its statistics, in document order, in one walk.
 *
 * Subtree totals accumulate on the way back up rather than by re-descending
 * per folder, which keeps a 1400-node space linear. `childrenOf` only gives
 * direct children (tree.ts:110) — what the disclosure triangle wants, not what
 * "largest folder" wants. Descending from `roots` also means a malformed
 * parent cycle is simply unreachable instead of an infinite loop.
 */
export function folderStats(index: TreeIndex): FolderStat[] {
  const out: FolderStat[] = [];
  const path: string[] = [];

  const walk = (node: Node, depth: number): { bookmarks: number; folders: number } => {
    if (node.type === 'bookmark') return { bookmarks: 1, folders: 0 };

    path.push(node.title);
    const total = { bookmarks: 0, folders: 0 };
    let directBookmarks = 0;
    for (const child of index.childrenOf(node.id)) {
      const sub = walk(child, depth + 1);
      total.bookmarks += sub.bookmarks;
      total.folders += sub.folders + (child.type === 'folder' ? 1 : 0);
      if (child.type === 'bookmark') directBookmarks += 1;
    }
    out.push({
      node,
      bookmarks: total.bookmarks,
      folders: total.folders,
      directBookmarks,
      path: [...path],
      depth,
    });
    path.pop();
    return total;
  };

  for (const root of index.roots) walk(root, 1);
  return out;
}

/**
 * The N biggest folders by recursive bookmark count.
 *
 * Empty folders are excluded: they are not the bottom of this ranking but a
 * different finding, and the 空文件夹 section already reports them.
 */
export function largestFolders(index: TreeIndex, limit = 5): FolderStat[] {
  return folderStats(index)
    .filter((stat) => stat.bookmarks > 0)
    .sort((a, b) => b.bookmarks - a.bookmarks || a.node.title.localeCompare(b.node.title))
    .slice(0, limit);
}

/** Folders holding nothing anywhere in their subtree. */
export function emptyFolders(index: TreeIndex): FolderStat[] {
  return folderStats(index).filter((f) => f.bookmarks === 0 && f.folders === 0);
}

/**
 * Folders with exactly one child.
 *
 * Reported instead of an "organization score": a chain of single-child folders
 * is a concrete, checkable sign of over-classification that can be acted on
 * one folder at a time, whereas a score is neither falsifiable nor actionable.
 */
export function singletonFolders(index: TreeIndex): FolderStat[] {
  // Direct children, not `folders`: that one is recursive, so a folder whose
  // single child is itself a wide subtree would wrongly look well populated.
  return folderStats(index).filter((f) => index.childrenOf(f.node.id).length === 1);
}

/** Nodes hanging directly off a root slot instead of inside a folder. */
export function rootOrphans(index: TreeIndex): { bookmarks: number; folders: number } {
  let bookmarks = 0;
  let folders = 0;
  for (const root of index.roots) {
    if (root.type === 'bookmark') bookmarks += 1;
    else folders += 1;
  }
  return { bookmarks, folders };
}

export interface DepthBucket {
  /** 1-based nesting level. */
  depth: number;
  folders: number;
  bookmarks: number;
}

/** How many nodes sit at each nesting level. */
export function depthHistogram(index: TreeIndex): DepthBucket[] {
  const buckets = new Map<number, DepthBucket>();
  const walk = (nodes: Node[], depth: number) => {
    for (const node of nodes) {
      const bucket = buckets.get(depth) ?? { depth, folders: 0, bookmarks: 0 };
      if (node.type === 'folder') bucket.folders += 1;
      else bucket.bookmarks += 1;
      buckets.set(depth, bucket);
      walk(index.childrenOf(node.id), depth + 1);
    }
  };
  walk(index.roots, 1);
  return [...buckets.values()].sort((a, b) => a.depth - b.depth);
}

// Inclusive upper bound per bucket; anything past the last one is the tail.
const PER_FOLDER_EDGES = [0, 1, 5, 20, 50];
const PER_FOLDER_LABELS = ['0', '1', '2–5', '6–20', '21–50', '51+'];

/**
 * Distribution of *direct* bookmark counts per folder.
 *
 * Direct, not recursive: "this folder holds 3 bookmarks" is something a person
 * can see and change, while a recursive count charges every ancestor of a deep
 * folder for the same bookmarks and makes the totals meaningless.
 */
export function perFolderBuckets(index: TreeIndex): CountBucket[] {
  return bandCounts(
    folderStats(index).map((stat) => stat.directBookmarks),
    PER_FOLDER_EDGES,
    PER_FOLDER_LABELS,
  );
}

export interface NameCollision {
  name: string;
  /** Each colliding folder's path, so the list is actionable. */
  items: { node: Node; path: string[] }[];
}

/**
 * Folders sharing a title under the same parent.
 *
 * Only siblings collide: two unrelated folders both called 「临时」 somewhere in
 * a large collection is normal, and reporting those would drown the cases
 * where navigation is genuinely ambiguous.
 */
export function duplicateFolderNames(index: TreeIndex): NameCollision[] {
  const groups = new Map<string, FolderStat[]>();
  for (const stat of folderStats(index)) {
    const parent = stat.node.parent_id ?? '(root)';
    const key = parent + '|' + stat.node.title;
    const list = groups.get(key) ?? [];
    list.push(stat);
    groups.set(key, list);
  }
  return [...groups.values()]
    .filter((list) => list.length > 1)
    .map((list) => ({
      name: list[0]?.node.title ?? '',
      items: list.map((s) => ({ node: s.node, path: s.path })),
    }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

export interface StructureSummary {
  bookmarks: number;
  folders: number;
  /** Deepest nesting level actually used. */
  maxDepth: number;
  /** Bookmarks hanging directly off a root slot. */
  unfiled: number;
}

/** Headline counts, in one pass over the flat list. */
export function structureSummary(nodes: Node[], index: TreeIndex): StructureSummary {
  let bookmarks = 0;
  let folders = 0;
  for (const node of nodes) {
    if (node.type === 'folder') folders += 1;
    else bookmarks += 1;
  }
  const histogram = depthHistogram(index);
  return {
    bookmarks,
    folders,
    maxDepth: histogram.reduce((deepest, bucket) => Math.max(deepest, bucket.depth), 0),
    unfiled: rootOrphans(index).bookmarks,
  };
}
