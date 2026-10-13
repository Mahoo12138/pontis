// The mount-directory picker's data source: every browser folder a space could
// be mounted on, as the tree the picker shows.

import type { BrowserAdapter } from '../core/browser/types';
import { buildFolderTreeFromEntries, type FolderTreeEntry, type FolderTreeNode } from './folderTree';

/**
 * Depth-first over the real bookmark tree.
 *
 * '0' is the hidden root every browser profile has; its children are the
 * permanent containers (bookmark bar, other bookmarks, mobile) plus whatever
 * the user made under them, so walking from it lists every mountable folder.
 * A folder the browser froze by policy never appears here — the adapter hides
 * its children, and mounting a space onto something nothing can be written to
 * would leave the binding unable to sync a single node.
 */
export async function mountFolderTree(adapter: BrowserAdapter): Promise<FolderTreeNode[]> {
  const entries: FolderTreeEntry[] = [];

  const walk = async (id: string, title: string, parent: string | null) => {
    const children = await adapter.getChildren(id);
    const folders = children.filter((n) => n.type === 'folder');
    entries.push({ id, title, parent, bookmarks: children.length - folders.length });
    for (const child of folders) await walk(child.id, child.title, id);
  };

  const root = await adapter.getChildren('0');
  for (const child of root.filter((n) => n.type === 'folder')) {
    await walk(child.id, child.title, null);
  }
  return buildFolderTreeFromEntries(entries);
}
