// The snapshot is a flat list of the source's descendants. Everything the page
// shows — the current level, the breadcrumb, a search result's location — is
// derived from that list here, so no component re-implements the tree and no
// component can wander above the source (§11.3).

import type { StartPageSnapshot, StartPageSnapshotNode } from '@pontis/api';

export interface SourceTree {
  sourceId: string;
  sourceTitle: string;
  /** The source folder plus every descendant, by id. */
  byId: Map<string, StartPageSnapshotNode>;
  /** Children of one folder in canonical sibling order (§6.2). */
  childrenOf(id: string): StartPageSnapshotNode[];
  /** Pre-order position: the traversal order a reader would walk the folder in. */
  orderOf(id: string): number;
  contains(id: string): boolean;
  /** The chain from the source down to this node's parent: the breadcrumb a
   * reader would follow, and the trail that tells two same-named items apart.
   * The source is the first entry; the node itself is not included. */
  pathOf(id: string): StartPageSnapshotNode[];
}

const bySiblingOrder = (a: StartPageSnapshotNode, b: StartPageSnapshotNode) => {
  // A duplicate position is a server-side anomaly; the node id keeps the
  // display stable for it rather than letting the row order depend on the
  // order the list arrived in. Nothing here writes the position back (§6.2).
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function buildSourceTree(snapshot: StartPageSnapshot): SourceTree {
  const sourceId = snapshot.source.folder_id;
  const byId = new Map<string, StartPageSnapshotNode>();
  const children = new Map<string, StartPageSnapshotNode[]>();

  byId.set(sourceId, {
    id: sourceId,
    type: 'folder',
    parent_id: '',
    title: snapshot.source.folder_title || snapshot.snapshot.source_title,
    position: -1,
    updated_at: snapshot.snapshot.captured_at,
  });
  for (const node of snapshot.nodes) {
    byId.set(node.id, node);
    const list = children.get(node.parent_id) ?? [];
    list.push(node);
    children.set(node.parent_id, list);
  }
  for (const list of children.values()) list.sort(bySiblingOrder);

  // Pre-order from the source. An id that is not reachable this way is not
  // inside the source, which is also how a moved-out current folder is caught.
  const order = new Map<string, number>();
  const walk = (id: string) => {
    order.set(id, order.size);
    for (const child of children.get(id) ?? []) walk(child.id);
  };
  walk(sourceId);

  const parentOf = (id: string) => byId.get(byId.get(id)?.parent_id ?? '') ?? null;
  const contains = (id: string) => order.has(id);

  return {
    sourceId,
    sourceTitle: byId.get(sourceId)?.title ?? '',
    byId,
    childrenOf: (id) => (contains(id) ? (children.get(id) ?? []) : []),
    orderOf: (id) => order.get(id) ?? Number.MAX_SAFE_INTEGER,
    contains,
    pathOf: (id) => {
      const chain: StartPageSnapshotNode[] = [];
      for (let at = parentOf(id); at && at.id !== sourceId; at = parentOf(at.id)) {
        chain.unshift(at);
        // A cycle in the stored parent chain would otherwise spin forever.
        if (chain.length > byId.size) break;
      }
      chain.unshift(byId.get(sourceId)!);
      return chain.filter(Boolean);
    },
  };
}

/**
 * Where the reader is after a refresh.
 *
 * The current folder is a browser-tab position, not a preference; what has to
 * survive a background refresh is that the position still exists. A folder
 * deleted or moved out of the source resolves back to the source, and the
 * caller says so — a source that itself disappeared must not be rescued this
 * way, because falling back to the space would widen what is displayed (§6.5).
 */
export function resolveCurrentFolder(tree: SourceTree, folderId: string): { id: string; lost: boolean } {
  if (folderId === tree.sourceId) return { id: tree.sourceId, lost: false };
  if (tree.contains(folderId)) return { id: folderId, lost: false };
  return { id: tree.sourceId, lost: true };
}

export type SearchResultKind = 'title-exact' | 'title-prefix' | 'title-contains' | 'url-contains';

const TIER: Record<SearchResultKind, number> = {
  'title-exact': 0,
  'title-prefix': 1,
  'title-contains': 2,
  'url-contains': 3,
};

export interface StartPageSearchHit {
  node: StartPageSnapshotNode;
  tier: SearchResultKind;
  /** Title of each folder between the source and this hit, for the line that
   * distinguishes two items with the same name (§7.3). */
  trail: string[];
}

/**
 * Search the whole source subtree, never just the folder on screen.
 *
 * Narrowing to the current level would make the result list depend on where
 * the reader happened to be, and widening past the source would read folders
 * the page was never shown (§7.3). Matching folds case for comparison only;
 * the stored title and URL are what get rendered and opened.
 */
export function searchSource(
  tree: SourceTree,
  query: string,
  limit = 100,
): StartPageSearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const hits: StartPageSearchHit[] = [];
  for (const node of tree.byId.values()) {
    if (node.id === tree.sourceId) continue;
    const title = node.title.toLocaleLowerCase();
    const url = (node.url ?? '').toLocaleLowerCase();
    let tier: SearchResultKind | null = null;
    if (title === needle) tier = 'title-exact';
    else if (title.startsWith(needle)) tier = 'title-prefix';
    else if (title.includes(needle)) tier = 'title-contains';
    else if (url.includes(needle)) tier = 'url-contains';
    if (!tier) continue;
    hits.push({ node, tier, trail: tree.pathOf(node.id).slice(1).map((f) => f.title) });
  }

  return hits
    .sort((a, b) => {
      const byTier = TIER[a.tier] - TIER[b.tier];
      if (byTier !== 0) return byTier;
      // Within one tier the tree's own traversal order decides: a ranking that
      // depended on Map iteration would reorder identical matches between two
      // renders of the same snapshot.
      return tree.orderOf(a.node.id) - tree.orderOf(b.node.id);
    })
    .slice(0, limit);
}
