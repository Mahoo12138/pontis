// Canonical tree replay (doc 06 §8 direction): the server has no snapshot
// endpoint in v1, so the authoritative canonical tree is rebuilt by
// replaying the journal change stream. Pure functions — no I/O, no
// browser access; the initial-sync engine consumes the result.

import {
  asCreatePayload,
  asMovePayload,
  asUpdateTitlePayload,
  asUpdateURLPayload,
  type ChangeWire,
  type NodeType,
  type ParentRefWire,
} from '../protocol/types';

export interface CanonicalTreeNode {
  id: string;
  type: NodeType;
  title: string;
  url: string;
  parent: ParentRefWire;
  position: number;
  /** Revision of the change that last touched the node. */
  revision: number;
}

export interface CanonicalTree {
  nodes: Map<string, CanonicalTreeNode>;
}

export function parentKey(parent: ParentRefWire): string {
  return parent.type === 'root' ? `root:${parent.key ?? ''}` : `node:${parent.id ?? ''}`;
}

/** Replay a change stream (ordered by revision) into a canonical tree. */
export function replayChanges(changes: ChangeWire[]): CanonicalTree {
  const tree: CanonicalTree = { nodes: new Map() };
  for (const change of changes) {
    applyChange(tree, change);
  }
  return tree;
}

function applyChange(tree: CanonicalTree, change: ChangeWire): void {
  switch (change.type) {
    case 'create': {
      const p = asCreatePayload(change.payload);
      if (!p) return;
      tree.nodes.set(change.node_id, {
        id: change.node_id,
        type: p.type,
        title: p.title,
        url: p.url,
        parent: p.parent,
        position: p.position,
        revision: change.revision,
      });
      return;
    }
    case 'update_title': {
      const p = asUpdateTitlePayload(change.payload);
      const node = tree.nodes.get(change.node_id);
      if (p && node) {
        node.title = p.title;
        node.revision = change.revision;
      }
      return;
    }
    case 'update_url': {
      const p = asUpdateURLPayload(change.payload);
      const node = tree.nodes.get(change.node_id);
      if (p && node) {
        node.url = p.url;
        node.revision = change.revision;
      }
      return;
    }
    case 'move': {
      const p = asMovePayload(change.payload);
      const node = tree.nodes.get(change.node_id);
      if (p && node) {
        node.parent = p.parent;
        node.position = p.position;
        node.revision = change.revision;
      }
      return;
    }
    case 'delete': {
      // The payload count is informational; removing the node removes its
      // whole canonical subtree (server deletes are subtree deletes).
      // Unknown nodes prune nothing (already absent / never seen).
      if (tree.nodes.has(change.node_id)) removeSubtree(tree, change.node_id);
      return;
    }
  }
}

export function removeSubtree(tree: CanonicalTree, rootId: string): void {
  const doomed = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of tree.nodes.values()) {
      if (doomed.has(node.id)) continue;
      if (node.parent.type === 'node' && node.parent.id != null && doomed.has(node.parent.id)) {
        doomed.add(node.id);
        grew = true;
      }
    }
  }
  for (const id of doomed) tree.nodes.delete(id);
}

/** Children of a canonical parent (root slot or node), in position order. */
export function canonicalChildren(tree: CanonicalTree, parent: ParentRefWire): CanonicalTreeNode[] {
  const key = parentKey(parent);
  return [...tree.nodes.values()]
    .filter((n) => parentKey(n.parent) === key)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** Number of nodes in the canonical subtree under a parent (exclusive). */
export function countSubtree(tree: CanonicalTree, parent: ParentRefWire): number {
  let count = 0;
  const queue = canonicalChildren(tree, parent);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    count += 1;
    queue.push(...canonicalChildren(tree, { type: 'node', id: cur.id }));
  }
  return count;
}

/** Build a canonical tree from server snapshot nodes (doc 06 §8). */
export function snapshotToTree(
  nodes: Array<{ id: string; type: string; title: string; url?: string; parent: ParentRefWire; position: number }>,
): CanonicalTree {
  const changes: ChangeWire[] = nodes.map((n, i) => ({
    revision: i + 1,
    type: 'create' as const,
    node_id: n.id,
    payload: {
      type: n.type as NodeType,
      title: n.title,
      url: n.url ?? '',
      parent: n.parent,
      position: n.position,
    },
  }));
  return replayChanges(changes);
}
