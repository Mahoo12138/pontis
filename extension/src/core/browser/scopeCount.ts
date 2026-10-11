// How many bookmarks this binding's scope actually holds in the browser.
//
// The journal watermarks a device reports are revisions, not things: they say
// "I have applied 1402 changes", which is neither how many bookmarks exist nor
// a number anyone can check against their bookmark bar. This counts the real
// tree through the adapter, so the same rule about policy-managed folders
// applies — a container the browser froze is not ours to sync, so its contents
// are not ours to count.

import type { BrowserAdapter } from './types';
import type { BindingMount } from '../store/db';

/** The browser ids a binding's scope starts at. Empty means nothing is mounted. */
export function scopeRootIds(mount: BindingMount): string[] {
  if (mount.mode === 'partial') return mount.folderBrowserId ? [mount.folderBrowserId] : [];
  return Object.values(mount.roots ?? {});
}

/**
 * Bookmarks under the mounted roots, or null when the scope cannot be read —
 * a mount folder the user deleted has no count to report.
 */
export async function countScopeBookmarks(
  adapter: BrowserAdapter,
  mount: BindingMount,
): Promise<number | null> {
  let level = scopeRootIds(mount);
  if (level.length === 0) return null;
  let total = 0;
  try {
    while (level.length > 0) {
      // One batch per depth: a tree with a thousand bookmarks has a couple of
      // hundred folders, and a sequential walk would pay a round trip each.
      const groups = await Promise.all(level.map((id) => adapter.getChildren(id)));
      const next: string[] = [];
      for (const children of groups) {
        for (const child of children) {
          if (child.type === 'bookmark') total += 1;
          else next.push(child.id);
        }
      }
      level = next;
    }
  } catch {
    return null;
  }
  return total;
}
