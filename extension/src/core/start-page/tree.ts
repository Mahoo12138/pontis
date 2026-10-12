// The source subtree as the page sees it: current level, breadcrumb, and a
// search over the whole source.
//
// This mirrors web/src/features/start-page/tree.ts. The two live apart for now
// because the extension imports nothing from the workspace packages — its wire
// types and theme are hand-ported too — and a shared start-page package should
// be extracted once there is a third consumer, not before (start-page doc §17).

import type { StartPageSnapshotNodeWire } from './wire';

export interface SourceTree {
  sourceId: string;
  sourceTitle: string;
  byId: Map<string, StartPageSnapshotNodeWire>;
  childrenOf(id: string): StartPageSnapshotNodeWire[];
  orderOf(id: string): number;
  contains(id: string): boolean;
  pathOf(id: string): StartPageSnapshotNodeWire[];
}

export interface SourceShape {
  sourceId: string;
  sourceTitle: string;
  nodes: StartPageSnapshotNodeWire[];
}

const bySiblingOrder = (a: StartPageSnapshotNodeWire, b: StartPageSnapshotNodeWire) => {
  // A duplicate position is an anomaly on the server side; the node id keeps
  // the display stable instead of letting row order depend on arrival order.
  // Nothing here writes a position back (§6.2).
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function buildSourceTree(source: SourceShape): SourceTree {
  const byId = new Map<string, StartPageSnapshotNodeWire>();
  const children = new Map<string, StartPageSnapshotNodeWire[]>();

  byId.set(source.sourceId, {
    id: source.sourceId,
    type: 'folder',
    parent_id: '',
    title: source.sourceTitle,
    position: -1,
    updated_at: '',
  });
  for (const node of source.nodes) {
    byId.set(node.id, node);
    const list = children.get(node.parent_id) ?? [];
    list.push(node);
    children.set(node.parent_id, list);
  }
  for (const list of children.values()) list.sort(bySiblingOrder);

  // Pre-order from the source: an id this walk does not reach is not inside
  // the source, which is also how a folder that moved out is detected.
  const order = new Map<string, number>();
  const walk = (id: string) => {
    order.set(id, order.size);
    for (const child of children.get(id) ?? []) walk(child.id);
  };
  walk(source.sourceId);

  const contains = (id: string) => order.has(id);
  const parentOf = (id: string) => byId.get(byId.get(id)?.parent_id ?? '') ?? null;

  return {
    sourceId: source.sourceId,
    sourceTitle: source.sourceTitle,
    byId,
    childrenOf: (id) => (contains(id) ? (children.get(id) ?? []) : []),
    orderOf: (id) => order.get(id) ?? Number.MAX_SAFE_INTEGER,
    contains,
    pathOf: (id) => {
      const chain: StartPageSnapshotNodeWire[] = [];
      for (let at = parentOf(id); at && at.id !== source.sourceId; at = parentOf(at.id)) {
        chain.unshift(at);
        if (chain.length > byId.size) break;
      }
      chain.unshift(byId.get(source.sourceId)!);
      return chain.filter(Boolean);
    },
  };
}

/**
 * Where the reader is after a refresh.
 *
 * A drill-down position is this tab's state, not a preference; what has to
 * survive a refresh is that it still exists. A folder deleted or moved out of
 * the source comes back to the source, and the caller says so. A source that
 * itself disappeared is never rescued this way — falling back to the space
 * would widen what is displayed (§6.5).
 */
export function resolveCurrentFolder(tree: SourceTree, folderId: string): { id: string; lost: boolean } {
  if (folderId === tree.sourceId || tree.contains(folderId)) return { id: folderId, lost: false };
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
  node: StartPageSnapshotNodeWire;
  tier: SearchResultKind;
  /** Titles of the folders above the hit, relative to the source: what tells
   * two same-named items apart (§7.3). */
  trail: string[];
}

/** Search the whole source subtree, never only the level on screen, and never
 * past the source. Case folding decides matches only; the stored title and URL
 * are what get rendered and opened. */
export function searchSource(tree: SourceTree, query: string, limit = 100): StartPageSearchHit[] {
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
      // Within a tier the tree's own traversal order decides, so two renders
      // of one snapshot list the same matches the same way.
      return tree.orderOf(a.node.id) - tree.orderOf(b.node.id);
    })
    .slice(0, limit);
}
