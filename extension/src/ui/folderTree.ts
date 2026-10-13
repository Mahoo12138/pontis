// The folder tree behind the two folder pickers: the start page's source and a
// binding's mount directory. Folders only, because both choices have to land on
// a container — and one shape whether the folders came from the server's
// canonical snapshot or from this browser's own bookmark tree.

import type { SnapshotNodeWire } from '../core/protocol/types';

export interface FolderTreeNode {
  id: string;
  title: string;
  /** Direct bookmarks. Subfolders get their own rows, so counting them here
   * would report what is already on screen twice. */
  bookmarks: number;
  children: FolderTreeNode[];
}

/** One folder, wherever it came from. `parent` is the containing folder, or
 * null when nothing above it is a folder in this set. */
export interface FolderTreeEntry {
  id: string;
  title: string;
  parent: string | null;
  bookmarks?: number;
}

const TOP = '';

export function buildFolderTreeFromEntries(entries: FolderTreeEntry[]): FolderTreeNode[] {
  const known = new Set(entries.map((e) => e.id));
  const childEntries = new Map<string, FolderTreeEntry[]>();
  for (const entry of entries) {
    // A folder whose parent is not in this set goes to the top level instead of
    // vanishing: what a picker can list is what a reader can choose.
    const at = entry.parent && known.has(entry.parent) ? entry.parent : TOP;
    const list = childEntries.get(at) ?? [];
    list.push(entry);
    childEntries.set(at, list);
  }

  // A cycle in the stored parents would make its members unreachable from the
  // top; the visited set stops the recursion and the second pass below still
  // shows them.
  const visited = new Set<string>();
  const build = (entry: FolderTreeEntry): FolderTreeNode => {
    visited.add(entry.id);
    return {
      id: entry.id,
      title: entry.title || '(未命名)',
      bookmarks: entry.bookmarks ?? 0,
      children: (childEntries.get(entry.id) ?? []).filter((c) => !visited.has(c.id)).map(build),
    };
  };
  const from = (at: string) =>
    (childEntries.get(at) ?? []).filter((c) => !visited.has(c.id)).map(build);

  const roots = from(TOP);
  for (const entry of entries) {
    if (!visited.has(entry.id)) roots.push(build(entry));
  }
  return roots;
}

/** A duplicate position is a server-side anomaly; the id keeps the row order
 * stable rather than letting it depend on arrival order. */
const byPosition = (a: SnapshotNodeWire, b: SnapshotNodeWire) => {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** The canonical snapshot as a folder tree: bookmarks folded into their
 * folder's count, anything hanging off a root slot left on top. */
export function buildFolderTree(nodes: SnapshotNodeWire[]): FolderTreeNode[] {
  const folders = nodes.filter((n) => n.type === 'folder').sort(byPosition);
  const isFolder = new Set(folders.map((n) => n.id));
  const parentFolderOf = (n: SnapshotNodeWire) =>
    n.parent.type === 'node' && n.parent.id && isFolder.has(n.parent.id) ? n.parent.id : null;

  const bookmarks = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === 'folder') continue;
    const at = parentFolderOf(node);
    if (!at) continue;
    bookmarks.set(at, (bookmarks.get(at) ?? 0) + 1);
  }

  return buildFolderTreeFromEntries(
    folders.map((node) => ({
      id: node.id,
      title: node.title,
      parent: parentFolderOf(node),
      bookmarks: bookmarks.get(node.id) ?? 0,
    })),
  );
}

/** The chain of nodes from the top level down to `id`, inclusive. */
function findPath(roots: FolderTreeNode[], id: string): FolderTreeNode[] | null {
  if (!id) return null;
  let hit: FolderTreeNode[] | null = null;
  const walk = (nodes: FolderTreeNode[], path: FolderTreeNode[]): void => {
    for (const node of nodes) {
      if (hit) return;
      const next = [...path, node];
      if (node.id === id) {
        hit = next;
        return;
      }
      walk(node.children, next);
    }
  };
  walk(roots, []);
  return hit;
}

/** Ids from the top level down to but excluding `id`, for expanding a tree to
 * reveal what is already chosen. Empty when the folder is not in this tree. */
export function ancestorIdsOf(roots: FolderTreeNode[], id: string): string[] {
  return (findPath(roots, id) ?? []).slice(0, -1).map((n) => n.id);
}

/** Titles from the top level down to and including `id`, for the one line a
 * closed picker shows. Null when the folder is not in this tree. */
export function pathTitlesOf(roots: FolderTreeNode[], id: string): string[] | null {
  return findPath(roots, id)?.map((n) => n.title) ?? null;
}

/** Every folder in the tree, parents before their children. */
export function allFolders(roots: FolderTreeNode[]): FolderTreeNode[] {
  return roots.flatMap((node) => [node, ...allFolders(node.children)]);
}

/** Every folder id the tree holds, however deep — what tells a picker whether
 * a snapshot has any folder at all. */
export function countFolders(roots: FolderTreeNode[]): number {
  return roots.reduce((sum, node) => sum + 1 + countFolders(node.children), 0);
}
