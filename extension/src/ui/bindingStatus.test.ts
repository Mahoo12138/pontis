// The binding line is the only place a user sees the sync watermarks, and the
// two numbers are revisions rather than a count of bookmarks — deleting a
// bookmark advances them just like adding one. These pin the phrasing that makes
// that readable.

import { describe, expect, it } from 'vitest';

import type { BindingRecord } from '../core/store/db';
import { bindingStatus, syncProgress } from './bindingStatus';

const record = (over: Partial<BindingRecord>): BindingRecord => ({
  id: 'b1',
  spaceId: 's1',
  spaceName: 'Personal',
  mode: 'partial',
  state: 'active',
  epoch: 1,
  appliedRevision: 0,
  receivedRevision: 0,
  clientSeq: 0,
  mount: { mode: 'partial', folderBrowserId: '1', rootKey: 'main' },
  lastSyncAt: null,
  recovery: null,
  createdAt: 0,
  ...over,
});

describe('syncProgress', () => {
  it('says nothing was synced rather than showing 0 / 0', () => {
    expect(syncProgress(record({}))).toBe('还没有同步过');
  });

  it('names a caught-up binding by the revision it reached', () => {
    expect(syncProgress(record({ appliedRevision: 1402, receivedRevision: 1402 })))
      .toBe('已同步到修订 1402');
  });

  it('counts what is still outstanding when the browser is behind', () => {
    expect(syncProgress(record({ appliedRevision: 1402, receivedRevision: 1405 })))
      .toBe('已同步到修订 1402，还有 3 项待应用');
  });

  it('never reports a negative gap for a watermark ahead of the server', () => {
    expect(syncProgress(record({ appliedRevision: 9, receivedRevision: 4 })))
      .toBe('已同步到修订 9');
  });
});

describe('bindingStatus', () => {
  it('exposes the outstanding revisions for the unbind warning', () => {
    expect(bindingStatus(record({ appliedRevision: 3, receivedRevision: 7 })).pending).toBe(4);
  });
});
