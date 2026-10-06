import { execSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeBrowserAdapter, InitialReconciler, ProtocolError, ReplicaDB, ReplicaStore, ServerClient, SyncCoordinator, EventCapture } from '../src';
import { projection } from '../src/testing';

// End-to-end against the real Go server (doc 21 §10: real protocol
// truth; the fake-server tier only exercises client paths).

const serverDir = path.resolve(__dirname, '../../server');

interface RunningServer {
  baseUrl: string;
  dataDir: string;
  close: () => Promise<void>;
}

let running: RunningServer;
let sessionToken: string;
let spaceId: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startServer(): Promise<RunningServer> {
  const bin = path.join(tmpdir(), `pontis-it-${Date.now()}`);
  execSync('go build -o ' + JSON.stringify(bin) + ' ./cmd/server', { cwd: serverDir, stdio: 'pipe' });
  const port = await freePort();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pontis-it-data-'));
  const child = spawn(bin, [], {
    env: { ...process.env, PONTIS_LISTEN: `127.0.0.1:${port}`, PONTIS_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  // Wait for /healthz.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) {
        return {
          baseUrl,
          dataDir,
          close: () =>
            new Promise((resolve) => {
              child.once('exit', () => resolve());
              child.kill('SIGTERM');
            }),
        };
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error('integration server did not come up');
}

interface SessionUser {
  deviceToken: string;
  bindingId: string;
  adapter: FakeBrowserAdapter;
  store: ReplicaStore;
  capture: EventCapture;
  coordinator: SyncCoordinator;
  client: ServerClient;
  rootId: string;
  bindingBrowserId: string;
}

async function bootstrapDevice(browserName: string): Promise<SessionUser> {
  const auth = { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' };
  const res = await fetch(`${running.baseUrl}/api/v1/devices`, { method: 'POST', headers: auth, body: JSON.stringify({ name: browserName, browser: 'sim' }) });
  const { token } = (await res.json()) as { token: string };
  const client = new ServerClient(running.baseUrl, token);

  const bindRes = await fetch(`${running.baseUrl}/api/v1/device/bindings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ space_id: spaceId }),
  });
  const binding = (await bindRes.json()) as { id: string };

  const adapter = new FakeBrowserAdapter([`${browserName} Bar`]);
  const store = new ReplicaStore(new ReplicaDB(`it-${browserName}`));
  const rootId = (await adapter.listRoots())[0]!.id;
  await store.ensureBinding({
    bindingId: binding.id,
    spaceId,
    deviceId: 'device-' + browserName,
    deviceName: browserName,
    rootMap: { main: rootId },
  });
  const capture = new EventCapture(store, adapter, binding.id);
  capture.start();
  const coordinator = new SyncCoordinator(store, adapter, client, binding.id);
  return { deviceToken: token, bindingId: binding.id, adapter, store, capture, coordinator, client, rootId, bindingBrowserId: rootId };
}

beforeAll(async () => {
  running = await startServer();

  // Bootstrap: admin user, session, one space.
  const setup = await fetch(`${running.baseUrl}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password123' }),
  });
  expect(setup.status).toBe(201);
  const login = await fetch(`${running.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password123' }),
  });
  const loginBody = (await login.json()) as { token: string };
  sessionToken = loginBody.token;

  const space = await fetch(`${running.baseUrl}/api/v1/spaces`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Integration' }),
  });
  spaceId = ((await space.json()) as { id: string }).id;
});

afterAll(async () => {
  await running?.close();
});

describe('extension engine against the real server', () => {
  it('runs initial reconciliation, syncs edits, and converges', async () => {
    const a = await bootstrapDevice('Edge');

    // Pre-existing browser content: the server is empty, so initial
    // reconciliation imports it (doc 06 §5).
    const folder = await a.adapter.create(a.rootId, 'folder', 'Development');
    await a.adapter.create(folder.id, 'bookmark', 'GitHub', 'https://github.com');
    await a.adapter.create(a.rootId, 'bookmark', 'Notes', 'https://notes.example');

    const reconciler = new InitialReconciler(a.store, a.adapter, a.client, a.bindingId);
    const { commitRevision } = await reconciler.run();
    expect(commitRevision).toBeGreaterThanOrEqual(3);

    // The binding is active now: a plain sync round succeeds.
    await a.coordinator.drain();
    expect(await a.store.pendingCount(a.bindingId)).toBe(0);

    // Local edits flow up.
    const notes = (await a.adapter.getChildren(a.rootId)).find((n) => n.title === 'Notes')!;
    await a.adapter.update(notes.id, { title: 'Notes v2' });
    await a.coordinator.drain();

    // Cross-check: an observer device with an empty browser initializes
    // against the server ("server non-empty + browser empty", doc 06 §5);
    // its browser state is then the canonical truth.
    const observer = await bootstrapDevice('Observer');
    await new InitialReconciler(observer.store, observer.adapter, observer.client, observer.bindingId).run();
    await observer.coordinator.drain();

    const aProjection = await projection(a);
    const truth = await projection(observer);
    expect(aProjection.nodes.size).toBe(truth.nodes.size);
    for (const [cid, info] of truth.nodes) {
      const local = aProjection.nodes.get(cid);
      expect(local, `node ${cid} missing from A's projection`).toBeDefined();
      expect(local!.title).toBe(info.title);
      expect(local!.url ?? undefined).toBe(info.url ?? undefined);
      expect(local!.parent).toBe(info.parent);
    }
    // The canonical tree carries the merged edit.
    const titles = [...truth.nodes.values()].map((n) => n.title);
    expect(titles).toContain('Notes v2');

    // Protocol errors surface with their stable codes.
    const raw = await fetch(`${running.baseUrl}/api/v1/sync/bindings/${a.bindingId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.deviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol_version: 1, epoch: 99, applied_revision: 0, received_revision: 0, operations: [], max_changes: 100 }),
    });
    const body = (await raw.json()) as { error?: { code: string } };
    expect(body.error?.code).toBe('EPOCH_MISMATCH');
  });

  it('converges two devices editing concurrently', async () => {
    const a = await bootstrapDevice('Chrome');
    const b = await bootstrapDevice('Firefox');

    // A imports content; B joins against the non-empty server.
    const folder = await a.adapter.create(a.rootId, 'folder', 'Shared');
    const bookmark = await a.adapter.create(folder.id, 'bookmark', 'Doc', 'https://doc.example');
    await new InitialReconciler(a.store, a.adapter, a.client, a.bindingId).run();
    await new InitialReconciler(b.store, b.adapter, b.client, b.bindingId).run();
    await a.coordinator.drain();
    await b.coordinator.drain();

    // Different-field concurrency merges; same-field conflicts settle.
    const aDoc = (await a.store.getMirrorByBrowser(a.bindingId, bookmark.id))!.canonicalId;
    const bDoc = (await b.store.getMirrorByCanonical(b.bindingId, aDoc))!.browserId;
    await a.adapter.update(bookmark.id, { title: 'Doc v2' });
    await b.adapter.update(bDoc, { url: 'https://doc-v2.example' });

    await a.coordinator.drain();
    await b.coordinator.drain();
    await a.coordinator.drain();
    await b.coordinator.drain();

    // Both replicas hold the merged state.
    const bNode = await b.adapter.getNode(bDoc);
    expect(bNode!.title).toBe('Doc v2');
    expect(bNode!.url).toBe('https://doc-v2.example');
    const aNode = await a.adapter.getNode(bookmark.id);
    expect(aNode!.title).toBe('Doc v2');
  });
});
