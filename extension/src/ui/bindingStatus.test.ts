// The badge is the only place most users see what a binding is doing. "同步中"
// on a connection that has nothing to do reads as a sync that never finishes,
// and a switched-off binding must not look healthy. These pin those words.

import { describe, expect, it } from 'vitest';

import type { BindingRecord } from '../core/store/db';
import { bindingStatus } from './bindingStatus';

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

describe('bindingStatus', () => {
  it('calls an idle active binding 监测中, not 同步中', () => {
    expect(bindingStatus(record({ appliedRevision: 1402, receivedRevision: 1402 }))).toMatchObject({
      label: '监测中',
      color: 'healthyGreen',
    });
  });

  it('says 同步中 only while remote revisions are unapplied', () => {
    const st = bindingStatus(record({ appliedRevision: 1402, receivedRevision: 1405 }));
    expect(st.label).toBe('同步中');
    expect(st.pending).toBe(3);
  });

  it('never reports a negative gap for a watermark ahead of the server', () => {
    expect(bindingStatus(record({ appliedRevision: 9, receivedRevision: 4 })).pending).toBe(0);
  });

  it('shows a switched-off binding as paused whatever its state says', () => {
    const st = bindingStatus(record({ state: 'active', enabled: false }));
    expect(st).toMatchObject({ label: '已暂停', color: 'coolGray', disabled: true });
  });

  it('treats a binding written before the switch existed as enabled', () => {
    expect(bindingStatus(record({})).disabled).toBe(false);
  });

  it('keeps the states that need a person', () => {
    expect(bindingStatus(record({ state: 'waiting_user' })).label).toBe('等待确认');
    expect(bindingStatus(record({ state: 'needs_recovery' })).label).toBe('需要恢复');
    expect(bindingStatus(record({ state: 'mount_missing' })).label).toBe('目录缺失');
  });
});
