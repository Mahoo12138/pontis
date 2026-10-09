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

function stubServer(routes: Record<string, [unknown, number?]>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      urls.push(String(input));
      const path = new URL(String(input)).pathname;
      const route = routes[path];
      if (!route) return new Response('', { status: 404 });
      const [body, status = 200] = route;
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const paired: Record<string, [unknown, number?]> = {
  '/api/v1/meta': [
    { instance_id: 'inst-1', product_version: '0.1.0', api_version: 'v1', sync_protocol_versions: [1] },
  ],
  '/api/v1/auth/login': [
    { token: 'session-1', expires_at: 'later', user: { id: 'u1', username: 'alpha', display_name: 'A' } },
  ],
  '/api/v1/devices': [{ device: { id: 'dev-1', name: 'Alpha Chrome' }, token: 'device-secret' }],
};

beforeEach(() => {
  kv = new MemoryKV();
  urls = [];
  db = new PontisDB(`pairing-${Math.random()}`);
  pairing = new PairingService(new ApiClient(async () => ({ serverUrl: '' })), new BootstrapStore(kv), db);
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
      'http://127.0.0.1:8080/api/v1/meta',
      'http://127.0.0.1:8080/api/v1/auth/login',
      'http://127.0.0.1:8080/api/v1/devices',
    ]);
    const stored = (kv.data['bootstrap'] ?? {}) as BootstrapData;
    expect(stored.deviceToken).toBe('device-secret');
    expect(stored.serverUrl).toBe('http://127.0.0.1:8080');
    expect(stored.instanceId).toBe('inst-1');
  });

  it('keeps a trailing slash from producing a doubled path', async () => {
    stubServer(paired);

    await pairing.pair({ ...params, serverUrl: 'http://127.0.0.1:8080/' });

    expect(urls[0]).toBe('http://127.0.0.1:8080/api/v1/meta');
    expect(((kv.data['bootstrap'] ?? {}) as BootstrapData).serverUrl).toBe('http://127.0.0.1:8080');
  });

  it('stores nothing when the server rejects the credentials', async () => {
    stubServer({
      '/api/v1/meta': paired['/api/v1/meta']!,
      '/api/v1/auth/login': [{ error: { code: 'INVALID_CREDENTIALS', message: 'wrong password' } }, 401],
    });

    await expect(pairing.pair(params)).rejects.toThrow(/INVALID_CREDENTIALS/);
    expect(kv.data['bootstrap']).toBeUndefined();
  });

  it('refuses a paired call when the device token is gone', async () => {
    await expect(pairing.listSpaces()).rejects.toThrow('not paired');
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
