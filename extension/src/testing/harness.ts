import { SyncRequest, SyncResponse } from '@pontis/protocol';

import { BrowserAdapter } from '../adapter/types';
import { FakeBrowserAdapter } from '../adapter/fake';
import { ReplicaDB } from '../store/db';
import { ReplicaStore } from '../store/replica';
import { EventCapture } from '../engine/capture';
import { SyncCoordinator } from '../engine/coordinator';
import { SyncTransport } from '../engine/client';
import { FakeSyncServer } from './fakeServer';

export { FakeSyncServer } from './fakeServer';
export { FakeBrowserAdapter } from '../adapter/fake';

/** Adapts the in-memory server to the engine's sync transport. */
export function fakeTransport(server: FakeSyncServer): SyncTransport {
  return {
    sync: (bindingId: string, req: SyncRequest) => Promise.resolve(server.sync(bindingId, req)),
  };
}

export interface ReplicaHandle {
  name: string;
  bindingId: string;
  adapter: FakeBrowserAdapter;
  db: ReplicaDB;
  store: ReplicaStore;
  capture: EventCapture;
  coordinator: SyncCoordinator;
  /** Browser id of the "main" root container. */
  rootId: string;
  /** Transport wrapper for fault injection. */
  transport: FlakyTransport;
}

/**
 * Fault-injecting transport wrapper (doc 21 §7): drop a response after
 * the server processed it, or replay a request verbatim.
 */
export class FlakyTransport implements SyncTransport {
  private dropResponseNext = false;
  private duplicateNext = false;
  private delayNext = false;

  constructor(private inner: SyncTransport) {}

  armResponseLoss(): void {
    this.dropResponseNext = true;
  }

  armDuplicate(): void {
    this.duplicateNext = true;
  }

  async sync(bindingId: string, req: SyncRequest): Promise<SyncResponse> {
    if (this.dropResponseNext) {
      this.dropResponseNext = false;
      await this.inner.sync(bindingId, req); // committed server-side
      throw new Error('simulated: response lost');
    }
    if (this.duplicateNext) {
      this.duplicateNext = false;
      await this.inner.sync(bindingId, req);
    }
    return this.inner.sync(bindingId, req);
  }
}

/**
 * Wires one fake replica against a fake server: adapter, Dexie store
 * (fake-indexeddb), event capture and coordinator.
 */
export async function createTestReplica(server: FakeSyncServer, opts: { name: string; dbName?: string; rootKey?: string }): Promise<ReplicaHandle> {
  const rootKey = opts.rootKey ?? 'main';
  const adapter = new FakeBrowserAdapter([`${opts.name} Bar`]);
  const db = new ReplicaDB(opts.dbName ?? `replica-${opts.name}-${Math.random().toString(36).slice(2)}`);
  const store = new ReplicaStore(db);
  const rootId = (await adapter.listRoots())[0]!.id;
  const bindingId = `binding-${opts.name}`;
  await store.ensureBinding({
    bindingId,
    spaceId: 's1',
    deviceId: `device-${opts.name}`,
    deviceName: opts.name,
    rootMap: { [rootKey]: rootId },
  });
  const transport = new FlakyTransport(fakeTransport(server));
  const capture = new EventCapture(store, adapter, bindingId);
  capture.start();
  const coordinator = new SyncCoordinator(store, adapter, transport, bindingId);
  return { name: opts.name, bindingId, adapter, db, store, capture, coordinator, rootId, transport };
}

/**
 * Renders the browser's actual state in canonical identity space — the
 * projection convergence compares against (doc 21 §8).
 */
export async function projection(handle: { store: ReplicaStore; adapter: BrowserAdapter; bindingId: string }): Promise<{ order: Map<string, string[]>; nodes: Map<string, { parent: string; type: string; title: string; url?: string }> }> {
  const order = new Map<string, string[]>();
  const nodes = new Map<string, { parent: string; type: string; title: string; url?: string }>();
  const binding = await handle.store.getBinding(handle.bindingId);
  if (!binding) {
    throw new Error('projection: unknown binding');
  }
  const containerIds = new Set(Object.values(binding.rootMap));
  const walk = async (browserId: string, container: string): Promise<void> => {
    const children = await handle.adapter.getChildren(browserId);
    const canonical: string[] = [];
    for (const child of children) {
      if (containerIds.has(child.id)) {
        continue; // projected root containers are structure, not data
      }
      const mirror = await handle.store.getMirrorByBrowser(handle.bindingId, child.id);
      if (!mirror) {
        throw new Error(`projection: unmapped browser node ${child.id} in managed scope`);
      }
      canonical.push(mirror.canonicalId);
      nodes.set(mirror.canonicalId, { parent: container, type: child.type, title: child.title, url: child.url });
      if (child.type === 'folder') {
        await walk(child.id, mirror.canonicalId);
      }
    }
    order.set(container, canonical);
  };
  for (const [rootKey, browserRootId] of Object.entries(binding.rootMap)) {
    await walk(browserRootId, `root:${rootKey}`);
  }
  return { order, nodes };
}

/** Asserts browser projection == server tree for every replica. */
export async function assertConverged(server: FakeSyncServer, handles: ReplicaHandle[]): Promise<void> {
  const want = server.tree();
  for (const handle of handles) {
    const got = await projection(handle);
    for (const [container, ids] of want.order) {
      const browserIds = got.order.get(container) ?? [];
      if (JSON.stringify(browserIds) !== JSON.stringify(ids)) {
        throw new Error(`${handle.name}: container ${container} order\n got ${JSON.stringify(browserIds)}\nwant ${JSON.stringify(ids)}`);
      }
    }
    for (const [id, info] of want.nodes) {
      const browserInfo = got.nodes.get(id);
      if (!browserInfo) {
        throw new Error(`${handle.name}: node ${id} missing from projection`);
      }
      if (browserInfo.parent !== info.parent || browserInfo.title !== info.title || (browserInfo.url ?? undefined) !== (info.url ?? undefined)) {
        throw new Error(`${handle.name}: node ${id} mismatch ${JSON.stringify(browserInfo)} vs ${JSON.stringify(info)}`);
      }
    }
    if (got.nodes.size !== want.nodes.size) {
      throw new Error(`${handle.name}: projection holds ${got.nodes.size} nodes, server has ${want.nodes.size}`);
    }
    const pending = await handle.store.pendingCount(handle.bindingId);
    if (pending !== 0) {
      throw new Error(`${handle.name}: ${pending} operations never settled`);
    }
    const unapplied = await handle.store.unappliedCount(handle.bindingId);
    if (unapplied !== 0) {
      throw new Error(`${handle.name}: ${unapplied} inbox changes left unapplied`);
    }
    const binding = await handle.store.getBinding(handle.bindingId);
    const head = server.getHead();
    if (binding!.appliedRevision !== head || binding!.receivedRevision !== head) {
      throw new Error(`${handle.name}: watermarks applied=${binding!.appliedRevision} received=${binding!.receivedRevision}, head=${head}`);
    }
  }
}
