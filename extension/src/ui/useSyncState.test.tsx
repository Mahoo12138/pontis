// @vitest-environment jsdom
// The options page kept showing 这台浏览器还没有配对 to a device that was
// already paired and syncing: the bootstrap read that answers `paired` lived
// inside the page's refresh(), and moving refresh into this hook dropped it, so
// `paired` could only ever turn true in the same page view that ran the pairing.
// These tests pin the identity to the read loop instead of the action.

import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const store = vi.hoisted(() => ({ row: {} as Record<string, unknown>, hangTree: false }));

vi.mock('./optionsRuntime', () => ({
  runtime: {
    chrome: { runtime: { sendMessage: vi.fn(async () => ({ ok: true })) } },
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
