// @vitest-environment jsdom
// The options page kept showing 这台浏览器还没有配对 to a device that was
// already paired and syncing: the bootstrap read that answers `paired` lived
// inside the page's refresh(), and moving refresh into this hook dropped it, so
// `paired` could only ever turn true in the same page view that ran the pairing.
// These tests pin the identity to the read loop instead of the action.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => ({ row: {} as Record<string, unknown>, hangTree: false }));
const releaseRequest = vi.hoisted(() => vi.fn());

vi.mock('./optionsRuntime', () => ({
  runtime: {
    chrome: { runtime: { sendMessage: vi.fn(async () => ({ ok: true })), getManifest: () => ({ version: '0.1.0' }) } },
    client: { deviceExtensions: releaseRequest },
    db: {
      bindings: { toArray: async () => [] },
      reconSessions: { toArray: async () => [] },
      pendingOps: { filter: () => ({ toArray: async () => [] }) },
      diagnostics: {
        orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
      },
    },
    bootstrap: { get: async () => store.row },
    adapter: {},
    pairing: { listSpaces: async () => [] },
  },
}));

vi.mock('./mountFolders', () => ({
  mountFolderTree: () => (store.hangTree ? new Promise(() => undefined) : Promise.resolve([])),
}));
vi.mock('../core/browser/scopeCount', () => ({ countScopeBookmarks: async () => 0 }));

const { useSyncState } = await import('./useSyncState');
afterEach(() => { releaseRequest.mockReset(); vi.unstubAllGlobals(); });

describe('useSyncState 的设备身份', () => {
  it('把已配对的设备报成已配对，包括主机名和设备名', async () => {
    store.row = {
      serverUrl: 'https://pontis.example.com:8443',
      deviceToken: 'tok',
      deviceName: '我的笔记本',
    };
    const { result } = renderHook(() => useSyncState());
    await waitFor(() => expect(result.current.paired).toBe(true));
    expect(result.current.serverHost).toBe('pontis.example.com:8443');
    expect(result.current.deviceLabel).toBe('我的笔记本');
  });

  it('只有账号、没有设备令牌时仍然算未配对', async () => {
    store.row = { serverUrl: 'https://pontis.example.com' };
    const { result } = renderHook(() => useSyncState());
    await waitFor(() => expect(result.current.serverHost).toBe('pontis.example.com'));
    expect(result.current.paired).toBe(false);
  });

  it('主机名解析不了的 serverUrl 原样显示，不抛', async () => {
    store.row = { serverUrl: 'not-a-url', deviceToken: 'tok' };
    const { result } = renderHook(() => useSyncState());
    await waitFor(() => expect(result.current.paired).toBe(true));
    expect(result.current.serverHost).toBe('not-a-url');
  });

  // The bookmark tree is the one read here that can stall for a long time — it
  // walks the browser's own model. Identity must not queue behind it.
  it('书签目录读不出来（卡住）时，身份照样报出', async () => {
    store.hangTree = true;
    store.row = { serverUrl: 'https://pontis.example.com', deviceToken: 'tok', deviceName: '卡住的机器' };
    const { result } = renderHook(() => useSyncState());
    await waitFor(() => expect(result.current.paired).toBe(true));
    expect(result.current.deviceLabel).toBe('卡住的机器');
    store.hangTree = false;
  });
});

describe('useSyncState 更新提示与配对身份', () => {
  const release = (tag: string) => ({
    release: tag, artifacts: [{ platform: 'chromium', variant: 'sync', version: '0.1.0', sync_protocol_versions: [1] }],
  });
  it('配对后才检查更新；切换服务器时丢弃旧请求；解绑清除旧链接', async () => {
    vi.stubGlobal('__PONTIS_BUILD_METADATA__', { release: 'v0.1.0-alpha.2', commit: 'a'.repeat(40), dirty: false });
    store.row = {};
    const { result } = renderHook(() => useSyncState());
    await waitFor(() => expect(result.current.paired).toBe(false));
    expect(releaseRequest).not.toHaveBeenCalled();
    let finishFirst!: (value: unknown) => void;
    releaseRequest.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    store.row = { serverUrl: 'https://first.test', deviceToken: 'first' };
    await act(() => result.current.refresh());
    await waitFor(() => expect(releaseRequest).toHaveBeenCalledTimes(1));
    releaseRequest.mockResolvedValueOnce(release('v0.1.0-alpha.4'));
    store.row = { serverUrl: 'https://second.test', deviceToken: 'second' };
    await act(() => result.current.refresh());
    await waitFor(() => expect(result.current.update?.release).toBe('v0.1.0-alpha.4'));
    expect(result.current.installUrl).toBe('https://second.test/devices#install-extension');
    await act(async () => finishFirst(release('v0.1.0-alpha.99')));
    expect(result.current.update?.release).toBe('v0.1.0-alpha.4');
    await act(() => result.current.refresh());
    expect(releaseRequest).toHaveBeenCalledTimes(2);
    store.row = {};
    await act(() => result.current.refresh());
    expect(result.current.update).toBeNull();
    expect(result.current.installUrl).toBe('');
  });

  it('服务器离线或旧接口不可用时不保留上个身份的更新提示', async () => {
    vi.stubGlobal('__PONTIS_BUILD_METADATA__', { release: 'v0.1.0-alpha.2', commit: '', dirty: false });
    releaseRequest.mockResolvedValueOnce(release('v0.1.0-alpha.3'));
    store.row = { serverUrl: 'https://first.test', deviceToken: 'first' };
    const { result } = renderHook(() => useSyncState());
    await waitFor(() => expect(result.current.update?.release).toBe('v0.1.0-alpha.3'));
    releaseRequest.mockRejectedValueOnce(new Error('offline'));
    store.row = { serverUrl: 'https://first.test', deviceToken: 'replacement-identity' };
    await act(() => result.current.refresh());
    await waitFor(() => expect(releaseRequest).toHaveBeenCalledTimes(2));
    expect(result.current.update).toBeNull();
  });
});
