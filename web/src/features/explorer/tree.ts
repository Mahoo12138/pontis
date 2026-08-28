import type { Node } from '@pontis/api';

/** A row currently visible in the explorer list, with its indent depth. */
export interface ExplorerRow {
  node: Node;
  depth: number;
  childCount: number;
}

/** Indexed view of the flat node list: parents, roots, lookup. */
export interface TreeIndex {
  byId: Map<string, Node>;
  parentOf: Map<string, Node | null>;
  roots: Node[];
  childrenOf: (id: string) => Node[];
}

/** Build parent/child indexes from the flat API list (sorted by position). */
export function buildTreeIndex(nodes: Node[]): TreeIndex {
  const byId = new Map<string, Node>();
  for (const node of nodes) byId.set(node.id, node);

  const children = new Map<string, Node[]>();
  const parentOf = new Map<string, Node | null>();
  const roots: Node[] = [];

  for (const node of nodes) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (node.parent_id && parent) {
      parentOf.set(node.id, parent);
      const list = children.get(parent.id) ?? [];
      list.push(node);
      children.set(parent.id, list);
    } else {
      parentOf.set(node.id, null);
      roots.push(node);
    }
  }

  const byPosition = (a: Node, b: Node) => a.position - b.position;
  roots.sort(byPosition);
  for (const list of children.values()) list.sort(byPosition);

  return {
    byId,
    parentOf,
    roots,
    childrenOf: (id) => children.get(id) ?? [],
  };
}

export type ExplorerFilter = 'all' | 'folders' | 'bookmarks';

/**
 * Flatten the tree into the visible row list.
 *
 * - all: folders gate their children behind `expanded`.
 * - folders: same walk, bookmark rows hidden.
 * - bookmarks: every bookmark at depth 0 (folder structure hidden),
 *   so the filter is useful without expanding everything first.
 */
export function flattenVisible(
  index: TreeIndex,
  expanded: ReadonlySet<string>,
  filter: ExplorerFilter,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];

  if (filter === 'bookmarks') {
    const walkAll = (items: Node[]) => {
      for (const node of items) {
        if (node.type === 'bookmark') rows.push({ node, depth: 0, childCount: 0 });
        walkAll(index.childrenOf(node.id));
      }
    };
    walkAll(index.roots);
    return rows;
  }

  const walk = (items: Node[], depth: number) => {
    for (const node of items) {
      const kids = index.childrenOf(node.id);
      if (node.type === 'folder') {
        rows.push({ node, depth, childCount: kids.length });
        if (expanded.has(node.id)) walk(kids, depth + 1);
      } else {
        rows.push({ node, depth, childCount: 0 });
      }
    }
  };
  walk(index.roots, 0);

  return rows;
}
