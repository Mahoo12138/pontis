// Reading the managed scope out of the browser (doc 05 §14).
//
// This is a scan, not a decision: it hands the caller the subtree as it is at
// this moment. Resolving identity between that tree and the canonical one is
// the server's reconciliation engine (doc 07 §3); the extension used to carry a
// second conservative matcher here, and it had no caller left.

import type { BrowserAdapter, BrowserNode } from '../browser/types';

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
