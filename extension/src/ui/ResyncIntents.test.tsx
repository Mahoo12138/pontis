// @vitest-environment jsdom
// The sync tab's one interactive sub-tree had no coverage; this is the seam that
// lets the rest of the tab move without being flown blind.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ResyncIntents } from './ResyncIntents';
import type { PendingOpRecord } from '../core/store/db';

const op = (over: Partial<PendingOpRecord>): PendingOpRecord =>
  ({
    opId: 'op-1',
    bindingId: 'b-1',
    clientSeq: 1,
    baseRevision: 1,
    status: 'QUEUED',
    type: 'create',
    nodeId: '',
    nodeType: 'bookmark',
    title: 'Example',
    url: 'https://example.com',
    parent: { type: 'root', key: 'main' },
    createdAt: 1,
    ...over,
  }) as PendingOpRecord;

function show(intents: PendingOpRecord[], chosen: (op: PendingOpRecord) => 'apply' | 'discard' = () => 'apply') {
  const handlers = {
    chosen,
    onChoose: vi.fn(),
    onAll: vi.fn(),
    onSubmit: vi.fn(),
  };
  render(
    <MantineProvider>
      <ResyncIntents intents={intents} busy={false} {...handlers} />
    </MantineProvider>,
  );
  return handlers;
}

describe('ResyncIntents', () => {
  it('says there is nothing to review and disables the bulk actions', () => {
    show([]);
    expect(screen.getByText(/无待审操作/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '全部按建议' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '全部放弃' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists each operation with what it is and where it points', () => {
    show([op({}), op({ opId: 'op-2', type: 'delete', title: 'Gone', url: undefined })]);
    expect(screen.getByText('Example · https://example.com')).toBeTruthy();
    expect(screen.getByText('Gone')).toBeTruthy();
    expect(screen.getAllByText('delete')).toHaveLength(1);
  });

  it('falls back to a placeholder title rather than an empty row', () => {
    show([op({ title: '' })]);
    expect(screen.getByText(/无标题/)).toBeTruthy();
  });

  it('records a per-operation decision naming that operation', () => {
    const { onChoose } = show([op({})]);
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    expect(onChoose).toHaveBeenCalledWith('op-1', 'discard');
  });

  it('offers the server default and a blanket discard, then submits', () => {
    const { onAll, onSubmit } = show([op({})]);
    fireEvent.click(screen.getByRole('button', { name: '全部按建议' }));
    fireEvent.click(screen.getByRole('button', { name: '全部放弃' }));
    fireEvent.click(screen.getByRole('button', { name: '提交决策' }));
    expect(onAll).toHaveBeenNthCalledWith(1, 'default');
    expect(onAll).toHaveBeenNthCalledWith(2, 'discard');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
