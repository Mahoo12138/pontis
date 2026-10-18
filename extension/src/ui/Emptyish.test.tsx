// @vitest-environment jsdom
// The new-tab surface had no test at all: `vitest` only collected `.ts`, and the
// e2e never opened the start page. This covers the empty-state shape both the
// unpaired and unconfigured branches render through.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Emptyish } from './Emptyish';

const show = (action?: React.ReactNode) =>
  render(
    <MantineProvider>
      <Emptyish
        icon={<svg data-testid="glyph" />}
        title="还没有选择要显示的文件夹"
        body="选择一个来源后，这里显示的就是工作台里已有的书签，不需要再导入一次。"
        action={action}
      />
    </MantineProvider>,
  );

describe('Emptyish', () => {
  it('shows what is missing and what to do about it', () => {
    show();
    expect(screen.getByText('还没有选择要显示的文件夹')).toBeTruthy();
    expect(screen.getByText(/不需要再导入一次/)).toBeTruthy();
    expect(screen.getByTestId('glyph')).toBeTruthy();
  });

  it('renders the action so the state is escapable', () => {
    show(
      <a href="/options.html" target="_blank">
        配置起始页来源
      </a>,
    );
    const link = screen.getByRole('link', { name: '配置起始页来源' });
    expect(link.getAttribute('href')).toBe('/options.html');
    // A new-tab page that opened its own settings in the same tab would replace
    // the page the person was leaving.
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('is fine without an action', () => {
    show();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
