// Pairing is the one flow that runs BEFORE anything is stored: the server URL
// only exists in the form the user just typed. Resolving it from bootstrap
// instead sent the first /meta request to a relative path, which a real
// browser resolved against the extension's own origin.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../transport/client';
import { BootstrapStore, type BootstrapData, type KVArea } from '../store/bootstrap';
import { PontisDB } from '../store/db';
import { PairingService, originPatternFor } from './pairing';

class MemoryKV implements KVArea {
  data: Record<string, unknown> = {};
  async get(key: string) {
    return this.data[key];
  }
  async set(items: Record<string, unknown>) {
    Object.assign(this.data, items);
  }
  async remove(keys: string[]) {
    for (const k of keys) delete this.data[k];
  }
}

let kv: MemoryKV;
let db: PontisDB;
let urls: string[];
let pairing: PairingService;

/** Routes keyed by "METHOD /path", the shape that actually gets called. */
function stubServer(routes: Record<string, [unknown, number?]>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      urls.push(`${method} ${new URL(url).pathname}`);
      const route = routes[`${method} ${new URL(url).pathname}`];
      if (!route) return new Response('', { status: 404 });
      const [body, status = 200] = route;
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function bindingWire(state: string) {
  return {
    id: 'binding-1',
    device_id: 'dev-1',
    space_id: 'space-1',
    state,
    epoch: 1,
    applied_revision: 0,
    received_revision: 0,
    max_client_seq: 0,
  };
}

const paired: Record<string, [unknown, number?]> = {
  'GET /api/v1/meta': [
    { instance_id: 'inst-1', product_version: '0.1.0', api_version: 'v1', sync_protocol_versions: [1] },
  ],
  'POST /api/v1/auth/login': [
    { token: 'session-1', expires_at: 'later', user: { id: 'u1', username: 'alpha', display_name: 'A' } },
  ],
  'POST /api/v1/devices': [{ device: { id: 'dev-1', name: 'Alpha Chrome' }, token: 'device-secret' }],
  'POST /api/v1/device/bindings': [bindingWire('pending_initial')],
  'DELETE /api/v1/device/bindings/binding-1': [bindingWire('pending_initial')],
};

beforeEach(() => {
  kv = new MemoryKV();
  urls = [];
  db = new PontisDB(`pairing-${Math.random()}`);
  const bootstrap = new BootstrapStore(kv);
  // The real client resolves its config from stored bootstrap on every call:
  // before pairing that is empty, which is exactly the case that used to send
  // the first request to a relative path.
  const client = new ApiClient(async () => {
    const b = await bootstrap.get();
    return { serverUrl: b.serverUrl ?? '', token: b.deviceToken };
  });
  pairing = new PairingService(client, bootstrap, db);
});

afterEach(() => vi.unstubAllGlobals());

const params = {
  serverUrl: 'http://127.0.0.1:8080',
  username: 'alpha',
  password: 'alpha-pass-1',
  deviceName: 'Alpha Chrome',
  browser: 'chromium',
  platform: 'mac',
};

describe('PairingService', () => {
  it('sends the pre-pairing calls to the URL the user typed', async () => {
    stubServer(paired);

    const result = await pairing.pair(params);

    expect(result).toEqual({ deviceId: 'dev-1', instanceId: 'inst-1' });
    expect(urls).toEqual([
      'GET /api/v1/meta',
      'POST /api/v1/auth/login',
      'POST /api/v1/devices',
    ]);
    const stored = (kv.data['bootstrap'] ?? {}) as BootstrapData;
    expect(stored.deviceToken).toBe('device-secret');
    expect(stored.serverUrl).toBe('http://127.0.0.1:8080');
    expect(stored.instanceId).toBe('inst-1');
  });

  it('keeps a trailing slash from producing a doubled path', async () => {
    stubServer(paired);

    await pairing.pair({ ...params, serverUrl: 'http://127.0.0.1:8080/' });

    expect(urls[0]).toBe('GET /api/v1/meta');
    expect(((kv.data['bootstrap'] ?? {}) as BootstrapData).serverUrl).toBe('http://127.0.0.1:8080');
  });

  it('stores nothing when the server rejects the credentials', async () => {
    stubServer({
      'GET /api/v1/meta': paired['GET /api/v1/meta']!,
      'POST /api/v1/auth/login': [{ error: { code: 'INVALID_CREDENTIALS', message: 'wrong password' } }, 401],
    });

    await expect(pairing.pair(params)).rejects.toThrow(/INVALID_CREDENTIALS/);
    expect(kv.data['bootstrap']).toBeUndefined();
  });

  it('refuses a paired call when the device token is gone', async () => {
    await expect(pairing.listSpaces()).rejects.toThrow('not paired');
  });

  it('binds a space as pending_initial, not as an already-synced one', async () => {
    stubServer(paired);
    await pairing.pair(params);

    const record = await pairing.bindSpace('space-1', 'Alpha Bookmarks', 'f1');

    // Activating it locally is what let incremental sync run against a tree
    // with no mapping at all; only the initial reconciliation may activate it.
    expect(record.state).toBe('pending_initial');
    expect(await db.bindings.get('binding-1')).toMatchObject({ state: 'pending_initial', mode: 'partial' });
  });

  it('revokes the server binding and drops the replica it leave behind', async () => {
    stubServer(paired);
    await pairing.pair(params);
    await pairing.bindSpace('space-1', 'Alpha Bookmarks', 'f1');
    // Replica state the initial reconciliation built for this binding.
    await db.localNodes.put({
      bindingId: 'binding-1',
      browserId: 'b1',
      canonicalId: 'n1',
      type: 'bookmark',
      title: 'Example',
      url: 'https://example.com',
      parentBrowserId: 'f1',
      position: 0,
    });
    await db.pendingOps.add({
      opId: 'op-1',
      bindingId: 'binding-1',
      clientSeq: 1,
      baseRevision: 0,
      status: 'QUEUED',
      type: 'create',
      nodeId: '018f-client-assigned',
      nodeType: 'bookmark',
      title: 'Later',
      parent: { type: 'root', key: 'main' },
      beforeId: null,
      browserId: 'b2',
      createdAt: Date.now(),
    });

    await pairing.unbind('binding-1');

    expect(urls).toContain('DELETE /api/v1/device/bindings/binding-1');
    expect(await db.bindings.get('binding-1')).toBeUndefined();
    // Stale mappings would be adopted by the next initial reconciliation,
    // which is how one canonical id ends up owning two browser nodes.
    expect(await db.localNodes.count()).toBe(0);
    expect(await db.pendingOps.count()).toBe(0);
  });
});

describe('originPatternFor', () => {
  it('covers the whole origin of the server the user typed', () => {
    expect(originPatternFor('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/*');
    expect(originPatternFor('http://localhost:8080/')).toBe('http://localhost:8080/*');
    // The default port is not part of a match pattern.
    expect(originPatternFor('https://pontis.example.com')).toBe('https://pontis.example.com/*');
    // A deeper base path is still one origin: the permission covers the API.
    expect(originPatternFor('https://pontis.example.com:8443/pontis')).toBe('https://pontis.example.com:8443/*');
  });

  it('refuses an address the browser cannot grant access to', () => {
    expect(() => originPatternFor('ftp://pontis.example.com')).toThrow(/unsupported server scheme/);
    // Missing scheme would otherwise be resolved against the extension origin.
    expect(() => originPatternFor('pontis.example.com')).toThrow();
  });
});
