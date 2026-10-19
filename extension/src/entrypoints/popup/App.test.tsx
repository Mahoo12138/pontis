// @vitest-environment jsdom
// Click the real popup button: testing the message handler alone cannot catch
// a JSX callback that references manualSync without actually calling it.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { BindingRecord } from '../../core/store/db';
import { pontisTheme } from '../../theme/pontisTheme';
import { App } from './App';

const fixture = vi.hoisted(() => ({
  bindings: [] as BindingRecord[],
  sendMessage: vi.fn(),
  countBookmarks: vi.fn(),
}));

vi.mock('../../core/store/db', () => ({
  PontisDB: class {
    bindings = { toArray: async () => fixture.bindings };
  },
}));
vi.mock('../../core/browser/chromium', () => ({ createChromiumAdapter: () => ({}) }));
vi.mock('../../core/browser/scopeCount', () => ({
  countScopeBookmarks: fixture.countBookmarks,
}));
vi.mock('../../runtime/chromeApi', () => ({
  chromeApi: () => ({
    bookmarks: {},
    runtime: {
      sendMessage: fixture.sendMessage,
      getURL: (path: string) => `chrome-extension://pontis-test/${path}`,
    },
  }),
}));

const binding = (over: Partial<BindingRecord> = {}): BindingRecord => ({
  id: 'binding-1',
  spaceId: 'space-1',
  spaceName: '工作书签',
  mode: 'partial',
  state: 'active',
  epoch: 1,
  appliedRevision: 3,
  receivedRevision: 3,
  clientSeq: 1,
  mount: { mode: 'partial', rootKey: 'main', folderBrowserId: 'folder-1' },
  lastSyncAt: Date.now(),
  recovery: null,
  createdAt: 1,
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function renderPopup() {
  render(<MantineProvider theme={pontisTheme}><App /></MantineProvider>);
  // Wait for the binding read and initial browser count before clicking.
  await screen.findAllByText('2 个书签');
  return screen.getByRole<HTMLButtonElement>('button', { name: '立即同步' });
}

describe('popup 手动同步', () => {
  beforeEach(() => {
    fixture.bindings = [binding()];
    fixture.sendMessage.mockReset().mockResolvedValue({ ok: true });
    fixture.countBookmarks.mockReset().mockResolvedValue(2);
  });

  it('点击按钮发送 worker 消息，完成后刷新浏览器书签计数', async () => {
    const response = deferred<{ ok: boolean }>();
    fixture.sendMessage.mockReturnValue(response.promise);
    const button = await renderPopup();

    fireEvent.click(button);

    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.sendMessage).toHaveBeenCalledWith({ type: 'pontis/manual-sync' });
    fixture.countBookmarks.mockResolvedValue(4);
    await act(async () => response.resolve({ ok: true }));
    await screen.findByText('4 个书签');
    expect(button.disabled).toBe(false);
  });

  it('一轮未完成时重复点击不重复发送，完成后可以再次同步', async () => {
    const response = deferred<{ ok: boolean }>();
    fixture.sendMessage.mockReturnValueOnce(response.promise);
    const button = await renderPopup();

    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => response.resolve({ ok: true }));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('显示 worker 拒绝原因，下一次尝试清除旧错误并恢复可操作状态', async () => {
    fixture.sendMessage.mockResolvedValueOnce({ ok: false, error: '服务器暂时不可用' });
    const button = await renderPopup();

    fireEvent.click(button);
    await screen.findByText('服务器暂时不可用');
    expect(button.disabled).toBe(false);

    const retry = deferred<{ ok: boolean }>();
    fixture.sendMessage.mockReturnValueOnce(retry.promise);
    fireEvent.click(button);
    expect(screen.queryByText('服务器暂时不可用')).toBeNull();
    expect(button.disabled).toBe(true);
    await act(async () => retry.resolve({ ok: true }));
    expect(button.disabled).toBe(false);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('运行时发送失败后显示错误，按钮恢复可用', async () => {
    fixture.sendMessage.mockRejectedValueOnce(new Error('连接到扩展后台失败'));
    const button = await renderPopup();

    fireEvent.click(button);

    await screen.findByText('Error: 连接到扩展后台失败');
    expect(button.disabled).toBe(false);
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('全部绑定暂停时禁用按钮且不发送同步消息', async () => {
    fixture.bindings = [
      binding({ enabled: false }),
      binding({ id: 'binding-2', spaceId: 'space-2', spaceName: '个人书签', enabled: false }),
    ];
    const button = await renderPopup();

    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(fixture.sendMessage).not.toHaveBeenCalled();
  });

  it('部分绑定暂停时仍允许触发同步，旧数据缺少 enabled 字段视为启用', async () => {
    fixture.bindings = [
      binding({ enabled: false }),
      binding({ id: 'binding-2', spaceId: 'space-2', spaceName: '个人书签' }),
    ];
    const button = await renderPopup();

    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
    expect(fixture.sendMessage).toHaveBeenCalledWith({ type: 'pontis/manual-sync' });
  });
});
