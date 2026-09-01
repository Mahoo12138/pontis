// Exact Tree Matcher (doc 06 §6, doc 07 §3): conservative, parent-aware,
// top-down identity resolution for initial sync. Only exact + unique
// candidates match — folder by exact title, bookmark by exact raw URL.
// Ambiguity is never guessed; no rename/move/delete inference.

import type { BrowserAdapter, BrowserNode } from '../browser/types';
import type { ParentRefWire } from '../protocol/types';
import { canonicalChildren, type CanonicalTree, type CanonicalTreeNode } from './canonicalTree';

/** Recursive browser subtree snapshot rooted at a managed root. */
export interface BrowserSnapshotNode {
  node: BrowserNode;
  children: BrowserSnapshotNode[];
}

export async function snapshotBrowserTree(
  adapter: BrowserAdapter,
  rootBrowserId: string,
): Promise<BrowserSnapshotNode> {
  const root = await adapter.getNode(rootBrowserId);
  if (!root) throw new Error(`snapshotBrowserTree: mount root ${rootBrowserId} not found`);
  const walk = async (node: BrowserNode): Promise<BrowserSnapshotNode> => {
    const children = await adapter.getChildren(node.id);
    const built: BrowserSnapshotNode[] = [];
    for (const c of children) built.push(await walk(c));
    return { node, children: built };
  };
  return walk(root);
}

export function countBrowserSubtree(root: BrowserSnapshotNode): number {
  let count = 0;
  const queue = [...root.children];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    count += 1;
    queue.push(...cur.children);
  }
  return count;
}

export interface MatchPair {
  browserId: string;
  canonicalId: string;
}

export interface MatchAmbiguity {
  canonicalId?: string;
  browserId?: string;
  reason: string;
}

export interface MatchResult {
  matched: MatchPair[];
  /** Top-level unmatched browser subtree roots. */
  browserOnly: BrowserSnapshotNode[];
  /** Top-level canonical nodes with no browser counterpart. */
  serverOnly: CanonicalTreeNode[];
  ambiguous: MatchAmbiguity[];
}

/**
 * Match the browser snapshot against the canonical tree below `parent`
 * (the mount root slot for the top call). Pure, synchronous.
 */
export function matchExact(
  snapshot: BrowserSnapshotNode,
  tree: CanonicalTree,
  parent: ParentRefWire,
): MatchResult {
  const result: MatchResult = { matched: [], browserOnly: [], serverOnly: [], ambiguous: [] };
  matchLevel(snapshot, tree, parent, result);
  return result;
}

function matchLevel(
  snapshot: BrowserSnapshotNode,
  tree: CanonicalTree,
  parent: ParentRefWire,
  result: MatchResult,
): void {
  const canonical = canonicalChildren(tree, parent);
  const browser = snapshot.children;
  const consumed = new Set<string>();

  for (const c of canonical) {
    const candidates = browser.filter((b) => !consumed.has(b.node.id) && isCandidate(b.node, c));
    if (candidates.length === 0) {
      result.serverOnly.push(c);
      continue;
    }
    if (candidates.length > 1) {
      result.ambiguous.push({ canonicalId: c.id, reason: c.type === 'folder' ? 'duplicate_folder_title' : 'duplicate_bookmark_url' });
      continue;
    }
    const b = candidates[0]!;
    consumed.add(b.node.id);
    result.matched.push({ browserId: b.node.id, canonicalId: c.id });
    if (c.type === 'folder') {
      matchLevel(b, tree, { type: 'node', id: c.id }, result);
    }
  }

  for (const b of browser) {
    if (!consumed.has(b.node.id)) result.browserOnly.push(b);
  }
}

function isCandidate(node: BrowserNode, c: CanonicalTreeNode): boolean {
  if (c.type === 'folder') return node.type === 'folder' && node.title === c.title;
  return node.type === 'bookmark' && node.url != null && node.url === c.url;
}
