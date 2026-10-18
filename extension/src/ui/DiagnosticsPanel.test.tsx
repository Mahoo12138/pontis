// @vitest-environment jsdom
// The extension's first component-level seam. Until now `vitest.config.ts` only
// collected `.ts`, so nothing in the options page could be rendered in a test —
// which is how a thousand-line file with three heading patterns stayed that way.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import type { DiagnosticEvent } from '../core/store/db';

const event = (over: Partial<DiagnosticEvent>): DiagnosticEvent => ({
  ts: Date.parse('2026-10-16T04:57:36Z'),
  level: 'info',
  scope: 'coordinator',
  message: '另一轮正在处理该绑定，本轮跳过',
  data: { bindingId: 'b-1' },
  ...over,
});

const render_ = (diagnostics: DiagnosticEvent[]) =>
  render(
    <MantineProvider>
      <DiagnosticsPanel diagnostics={diagnostics} />
    </MantineProvider>,
  );

describe('DiagnosticsPanel', () => {
  it('says so when there is nothing to show', () => {
    render_([]);
    expect(screen.getByText('暂无记录。')).toBeTruthy();
  });

  it('turns the stored english ids into the display labels', () => {
    render_([event({})]);
    expect(screen.getByText('同步调度')).toBeTruthy();
    expect(screen.getByText('信息')).toBeTruthy();
    expect(screen.getByText('另一轮正在处理该绑定，本轮跳过')).toBeTruthy();
  });

  it('raises the error badge only for an error row', () => {
    const { unmount } = render_([event({})]);
    expect(screen.queryByText('有错误记录')).toBeNull();
    unmount();

    render_([event({ id: 2, level: 'error', message: '该副本无法同步此绑定，需要恢复' })]);
    expect(screen.getByText('有错误记录')).toBeTruthy();
  });

  it('keeps the one section-heading shape', () => {
    const { container } = render_([event({})]);
    const titles = container.querySelectorAll('.pontis-sectionTitle');
    expect(titles).toHaveLength(1);
    expect(titles[0]?.textContent).toBe('诊断事件（本地）');
    expect(container.querySelector('.mantine-Divider-root')).toBeNull();
  });
});
