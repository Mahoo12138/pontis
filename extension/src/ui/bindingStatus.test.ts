// The badge is the only place most users see what a binding is doing. "同步中"
// on a connection that has nothing to do reads as a sync that never finishes,
// and a switched-off binding must not look healthy. These pin those words.

import { describe, expect, it } from 'vitest';

import type { BindingRecord } from '../core/store/db';
import { bindingStatus, recoveryNote, relTime, sortBindings } from './bindingStatus';

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

describe('sortBindings', () => {
  it('puts bindings that cannot continue alone first and a switched-off one last', () => {
    const rows = [
      record({ id: 'quiet', spaceName: '甲' }),
      record({ id: 'off', spaceName: '乙', enabled: false }),
      record({ id: 'recover', spaceName: '丙', state: 'needs_recovery' }),
      record({ id: 'behind', spaceName: '丁', appliedRevision: 3, receivedRevision: 9 }),
      record({ id: 'init', spaceName: '戊', state: 'pending_initial' }),
    ];
    expect(sortBindings(rows).map((b) => b.id)).toEqual([
      'recover', // something a person must act on
      'init', // still becoming usable
      'behind', // catching up on its own
      'quiet',
      'off', // off on purpose, so nothing about it is urgent
    ]);
  });

  it('breaks ties by the order the bindings were made', () => {
    const rows = [
      record({ id: 'third', createdAt: 300 }),
      record({ id: 'first', createdAt: 100 }),
      record({ id: 'second', createdAt: 200 }),
    ];
    expect(sortBindings(rows).map((b) => b.id)).toEqual(['first', 'second', 'third']);
  });

  it('leaves the caller\'s array alone', () => {
    const rows = [record({ id: 'x', state: 'active' }), record({ id: 'y', state: 'needs_recovery' })];
    sortBindings(rows);
    expect(rows.map((r) => r.id)).toEqual(['x', 'y']);
  });
});

describe('recoveryNote', () => {
  it('says what happened in words, not the code the badge already carries', () => {
    expect(
      recoveryNote(
        record({
          state: 'mount_missing',
          recovery: { code: 'MOUNT_MISSING', message: '挂载目录已被删除，需要重新选择目录' },
        }),
      ),
    ).toBe('挂载目录已被删除，需要重新选择目录');
  });

  it('falls back to the code when there is no message', () => {
    expect(recoveryNote(record({ recovery: { code: 'EPOCH_MISMATCH', message: '' } }))).toBe(
      'EPOCH_MISMATCH',
    );
  });

  it('is empty when nothing is wrong', () => {
    expect(recoveryNote(record({}))).toBe('');
  });
});

describe('relTime', () => {
  const ago = (ms: number) => Date.now() - ms;

  it('counts up in the unit a person would actually say', () => {
    expect(relTime(null)).toBe('从未同步');
    expect(relTime(ago(2_000))).toBe('刚刚');
    expect(relTime(ago(45_000))).toBe('45 秒前');
    expect(relTime(ago(9 * 60_000))).toBe('9 分钟前');
    expect(relTime(ago(3 * 3_600_000))).toBe('3 小时前');
    expect(relTime(ago(26 * 3_600_000))).toBe('1 天前');
    expect(relTime(ago(9 * 86_400_000))).toBe('9 天前');
  });

  it('switches to a zh-CN date once the number stops telling anything', () => {
    // Bare toLocaleDateString() rendered this as "10/11/2026" — the same
    // digits for two different days, depending on who reads them.
    expect(relTime(ago(60 * 86_400_000))).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}$/);
  });
});
