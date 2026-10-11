import { describe, expect, it } from 'vitest';

import { createChromiumAdapter } from './chromium';
import { countScopeBookmarks, scopeRootIds } from './scopeCount';
import { createFakeChromeApi } from '../../testing/fakeChromeBookmarks';
import type { BindingMount } from '../store/db';

function apiWith(seed: Array<{ id: string; parentId?: string; title: string; url?: string; folderType?: string; unmodifiable?: boolean }>) {
  const chrome = createFakeChromeApi();
  chrome.seedNode({ id: '0', title: '' });
  chrome.seedNode({ id: '1', parentId: '0', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' });
  for (const node of seed) chrome.seedNode(node);
  return createChromiumAdapter(chrome);
}

const partial = (folderBrowserId: string): BindingMount => ({
  mode: 'partial',
  folderBrowserId,
  rootKey: 'main',
});

describe('countScopeBookmarks', () => {
  it('counts bookmarks at every depth and never a folder', async () => {
    const adapter = apiWith([
      { id: 'f1', parentId: '1', title: 'Reading' },
      { id: 'b1', parentId: '1', title: 'One', url: 'https://one.example' },
      { id: 'b2', parentId: 'f1', title: 'Two', url: 'https://two.example' },
      { id: 'f2', parentId: 'f1', title: 'Deeper' },
      { id: 'b3', parentId: 'f2', title: 'Three', url: 'https://three.example' },
    ]);
    expect(await countScopeBookmarks(adapter, partial('1'))).toBe(3);
  });

  it('counts only inside the mounted folder', async () => {
    const adapter = apiWith([
      { id: 'f1', parentId: '1', title: 'Synced' },
      { id: 'b1', parentId: 'f1', title: 'In', url: 'https://in.example' },
      { id: 'b2', parentId: '1', title: 'Out', url: 'https://out.example' },
    ]);
    expect(await countScopeBookmarks(adapter, partial('f1'))).toBe(1);
  });

  it('sums every root of a full mount', async () => {
    const adapter = apiWith([
      { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other' },
      { id: 'b1', parentId: '1', title: 'Bar', url: 'https://bar.example' },
      { id: 'b2', parentId: '2', title: 'Other', url: 'https://other.example' },
      { id: 'b3', parentId: '2', title: 'Other too', url: 'https://two.example' },
    ]);
    const mount: BindingMount = { mode: 'full', rootKey: 'main', roots: { main: '1', extra: '2' } };
    expect(scopeRootIds(mount).sort()).toEqual(['1', '2']);
    expect(await countScopeBookmarks(adapter, mount)).toBe(3);
  });

  it('leaves a policy-managed folder out of the count', async () => {
    // The adapter hides children of an unmodifiable folder because nothing in
    // it can be synced; a count that included them would promise more than the
    // binding can deliver.
    const adapter = apiWith([
      { id: 'm1', parentId: '1', title: 'Managed', folderType: 'managed', unmodifiable: true },
      { id: 'b1', parentId: 'm1', title: 'Forced', url: 'https://forced.example' },
      { id: 'b2', parentId: '1', title: 'Mine', url: 'https://mine.example' },
    ]);
    expect(await countScopeBookmarks(adapter, partial('1'))).toBe(1);
  });

  it('says there is no count when the mount folder is gone', async () => {
    const adapter = apiWith([]);
    expect(await countScopeBookmarks(adapter, partial('deleted'))).toBeNull();
  });

  it('says there is no count for a binding that mounts nothing', async () => {
    const adapter = apiWith([]);
    expect(await countScopeBookmarks(adapter, { mode: 'partial', rootKey: 'main' })).toBeNull();
    expect(await countScopeBookmarks(adapter, { mode: 'full', rootKey: 'main' })).toBeNull();
  });

  it('reports zero for an empty mounted folder rather than nothing', async () => {
    const adapter = apiWith([{ id: 'f1', parentId: '1', title: 'Empty' }]);
    expect(await countScopeBookmarks(adapter, partial('f1'))).toBe(0);
  });
});
