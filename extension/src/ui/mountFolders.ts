// The folder picker's data source: every browser folder a space could be
// mounted on, labelled by where it lives.

import type { BrowserAdapter } from '../core/browser/types';

export interface FolderOption {
  value: string;
  label: string;
}

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
export async function listMountFolders(adapter: BrowserAdapter): Promise<FolderOption[]> {
  const options: FolderOption[] = [];
  const walk = async (parentId: string, depth: number, prefix: string) => {
    const children = await adapter.getChildren(parentId);
    for (const child of children.filter((n) => n.type === 'folder')) {
      const label = child.title || '(未命名)';
      options.push({ value: child.id, label: `${'  '.repeat(depth)}${prefix}${label}` });
      await walk(child.id, depth + 1, `${label} / `);
    }
  };
  await walk('0', 0, '');
  return options;
}
