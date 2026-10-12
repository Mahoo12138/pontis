// Full Resync / Recovery tests (doc 06 §7-§11).
//
// The engine under test is the pairing of ResyncService (what a stuck binding
// does) with InitialReconciler (how it converges): a full resync is a
// server-driven reconciliation against a frozen canonical snapshot, so the
// regression cases here are the ones the watermark re-anchor used to fail —
// a node the client can no longer be *told* about by the journal.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, type BindingRecord, type PendingOpRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { SyncCoordinator } from './syncCoordinator';
import { ReplicaVerifier } from './verifyReplica';
import { ResyncService } from './resync';
import { InitialReconciler } from './initialReconcile';
import { FakeServerTransport } from '../../testing/fakeServer';
import { ApiError, type ReconciliationTransport } from '../transport/client';
import { BootstrapStore } from '../store/bootstrap';
import type {
  ApplyStepWire,
  ClientSnapshotWire,
  ParentRefWire,
  ReconciliationEnvelopeWire,
  ReconciliationPhase,
  ReconciliationType,
  ServerSnapshotPageWire,
  ServerSnapshotWire,
  StepsWire,
} from '../protocol/types';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let server: FakeServerTransport;
let coordinator: SyncCoordinator;
let verifier: ReplicaVerifier;
let engine: FakeReconciliation;
let reconciler: InitialReconciler;
let resync: ResyncService;

const bindingId = 'binding-1';
const ROOT: ParentRefWire = { type: 'root', key: 'main' };

async function seedBinding(over: Partial<BindingRecord> = {}): Promise<BindingRecord> {
  const binding: BindingRecord = {
    id: bindingId,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: 'partial',
    state: 'active',
    epoch: 1,
    appliedRevision: 1,
    receivedRevision: 1,
    clientSeq: 1,
    mount: { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
    ...over,
  };
  await db.bindings.put(binding);
  return binding;
}

const seedServerNode = (id: string, title: string, url: string, parent: ParentRefWire = ROOT) =>
  server.seed({ type: 'create', node_id: id, payload: { type: url ? 'bookmark' : 'folder', title, url, parent, position: server.journal.length } });

const seedIntent = async (over: Partial<PendingOpRecord> = {}): Promise<PendingOpRecord> => {
  const op: PendingOpRecord = {
    opId: 'op-intent',
    bindingId,
    clientSeq: 1,
    baseRevision: 1,
    status: 'QUEUED',
    type: 'create',
    nodeId: '',
    nodeType: 'bookmark',
    title: 'Intent',
    url: 'https://intent.example.com',
    parent: ROOT,
    beforeId: null,
    createdAt: Date.now(),
    ...over,
  };
  await db.pendingOps.add(op);
  return op;
};

const memoryKV = (): BootstrapStore => {
  let data: Record<string, unknown> = { bootstrap: { serverUrl: 'http://x', deviceToken: 'tok' } };
  return new BootstrapStore({
    get: async (k: string) => data[k],
    set: async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    },
    remove: async (keys: string[]) => {
      for (const k of keys) delete data[k];
    },
  });
};

/**
 * The server's session machine, reduced to what a resync exercises: it walks
 * the phases in order, hands back the steps the test scripted, and answers
 * `complete` with the binding the lifecycle is supposed to adopt.
 */
class FakeReconciliation implements ReconciliationTransport {
  calls: string[] = [];
  phase: ReconciliationPhase = 'collecting';
  type: ReconciliationType | null = null;
  snapshot: ClientSnapshotWire | null = null;
  /** Every snapshot this session was asked to plan on. */
  snapshots: ClientSnapshotWire[] = [];
  steps: ApplyStepWire[] = [];
  /** The revision the space was at when the server froze its snapshot. */
  baselineRevision = 1;
  epoch = 1;
  /** Set to refuse the session the way a binding that owes an initialization does. */
  createError: ApiError | null = null;
  /** Set to refuse the snapshot the way a mapping the server cannot accept is. */
  submitError: ApiError | null = null;
  completeError: ApiError | null = null;
  /** How many sessions the server has been asked to open. */
  sessionsCreated = 0;
  openSession = true;
  /** The kind the open session reports when it is not the one asked for. */
  activeType: ReconciliationType | null = null;

  private envelope(): ReconciliationEnvelopeWire {
    const completed = this.phase === 'committed' && !this.openSession;
    return {
      session: {
        id: 'srv-session',
        binding_id: bindingId,
        space_id: 'space-1',
        type: this.type ?? 'full_resync',
        reason: 'history expired',
        state: completed ? 'completed' : this.openSession ? 'running' : 'failed',
        phase: completed ? undefined : this.phase,
        source_epoch: 1,
        source_revision: 1,
        target_epoch: this.epoch,
        target_revision: this.baselineRevision,
        plan_hash: 'plan-1',
        server_committed: this.phase === 'committed',
        commit_revision: this.phase === 'committed' ? this.baselineRevision : 0,
        created_at: '',
        updated_at: '',
      },
      issues: [],
      binding: {
        id: bindingId,
        device_id: 'device-1',
        space_id: 'space-1',
        state: 'active',
        epoch: this.epoch,
        applied_revision: this.baselineRevision,
        received_revision: this.baselineRevision,
        max_client_seq: 0,
      },
    };
  }

  createReconciliation(_id: string, type: ReconciliationType): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('create');
    this.type = type;
    this.sessionsCreated += 1;
    if (this.createError) {
      const err = this.createError;
      this.createError = null;
      return Promise.reject(err);
    }
    return Promise.resolve(this.envelope());
  }

  getActiveReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('active-session');
    const env = this.envelope();
    if (this.activeType) env.session.type = this.activeType;
    return Promise.resolve(env);
  }

  submitClientSnapshot(_id: string, snapshot: ClientSnapshotWire): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('client-snapshot');
    this.snapshot = snapshot;
    this.snapshots.push(snapshot);
    if (this.submitError) {
      const err = this.submitError;
      this.submitError = null;
      return Promise.reject(err);
    }
    this.phase = 'snapshot_ready';
    return Promise.resolve(this.envelope());
  }

  createServerSnapshot(): Promise<ServerSnapshotWire> {
    this.calls.push('server-snapshot');
    this.phase = 'server_ready';
    return Promise.resolve({
      snapshot_id: 'snap-1',
      binding_id: bindingId,
      space_id: 'space-1',
      epoch: this.epoch,
      revision: this.baselineRevision,
      node_count: 0,
      checksum: 'sha256:0',
      expires_at: '',
      created_at: '',
    });
  }

  listServerSnapshotNodes(): Promise<ServerSnapshotPageWire> {
    return Promise.resolve({ nodes: [], total: 0, next_cursor: '' });
  }

  getReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('get');
    return Promise.resolve(this.envelope());
  }

  planReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('plan');
    this.phase = 'planned';
    return Promise.resolve(this.envelope());
  }

  decideReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('decide');
    return Promise.resolve(this.envelope());
  }

  commitReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('commit');
    this.phase = 'committed';
    return Promise.resolve(this.envelope());
  }

  fetchSteps(): Promise<StepsWire> {
    this.calls.push('steps');
    return Promise.resolve({ plan_hash: 'plan-1', steps: this.steps });
  }

  completeReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('complete');
    if (this.completeError) return Promise.reject(this.completeError);
    this.openSession = false;
    return Promise.resolve(this.envelope());
  }
}

const createStep = (canonicalId: string, title: string, url: string): ApplyStepWire => ({
  kind: 'create',
  canonical_id: canonicalId,
  type: 'bookmark',
  title,
  url,
  parent: ROOT,
});

beforeEach(() => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  server = new FakeServerTransport();
  coordinator = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), server);
  verifier = new ReplicaVerifier(db, adapter, coordinator);
  engine = new FakeReconciliation();
  reconciler = new InitialReconciler(db, adapter, engine);
  resync = new ResyncService(db, memoryKV(), reconciler, verifier);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
  seedServerNode('n1', 'Docs', ''); // revision 1
});

/** Mirror the one node the seeded journal revision created. */
async function mirrorNode(browserId: string, canonicalId: string, title: string): Promise<void> {
  adapter.seed({ id: browserId, parentId: 'f1', title });
  await db.localNodes.put({
    bindingId,
    browserId,
    canonicalId,
    type: 'folder',
    title,
    url: null,
    parentBrowserId: 'f1',
    position: 0,
  });
}

const stall = () =>
  seedBinding({
    state: 'needs_recovery',
    recovery: { code: 'EPOCH_MISMATCH', message: 'epoch changed' },
  });

describe('recovery intent review (doc 06 §10/§11)', () => {
  it('creates a brand-new op for a kept intent (fresh op_id / client_seq)', async () => {
    const op = await seedIntent();
    await stall();
    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');
    expect((await db.bindings.get(bindingId))?.state).toBe('waiting_user');

    // The reconciliation cannot start, so the review's fresh op is still there
    // to be inspected when the resync gives up.
    engine.createError = new ApiError(0, 'NETWORK_ERROR', 'no route to the server');
    const outcome = await resync.resolveIntents(bindingId, [{ opId: op.opId, decision: 'apply' }]);

    expect(outcome).toBe('waiting');
    const ops = await db.pendingOps.toArray();
    expect(ops).toHaveLength(1);
    const fresh = ops[0]!;
    expect(fresh.opId).not.toBe(op.opId);
    expect(fresh.clientSeq).toBe(2); // allocated after the old op's seq
    expect(fresh.title).toBe('Intent');
    expect(fresh.status).toBe('QUEUED');
    expect((await db.bindings.get(bindingId))?.state).toBe('needs_recovery');
    // The emergency snapshot is what makes a failed review re-runnable (doc 06 §9).
    expect(await db.emergencySnapshots.count()).toBeGreaterThan(0);
  });

  it('rejects resolveIntents outside the intent review state', async () => {
    await seedBinding();
    await expect(resync.resolveIntents(bindingId, [])).rejects.toThrow();
  });

  it('replays a kept CREATE against the new baseline and converges to active', async () => {
    const op = await seedIntent();
    await stall();
    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');
    engine.epoch = 2;
    server.epoch = 2;

    const outcome = await resync.resolveIntents(bindingId, [{ opId: op.opId, decision: 'apply' }]);

    expect(outcome).toBe('resynced');
    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('active');
    expect(binding?.epoch).toBe(2);
    // The intent was uploaded once, against the baseline the resync adopted.
    expect(
      server.journal.some((c) => c.type === 'create' && (c.payload as { title?: string }).title === 'Intent'),
    ).toBe(true);
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.some((m) => m.canonicalId === 'srv-2')).toBe(true);
    expect((await db.pendingOps.toArray()).every((o) => o.status === 'RESOLVED')).toBe(true);
    // The emergency snapshot has served its purpose (doc 06 §9).
    expect(await db.emergencySnapshots.count()).toBe(0);
  });

  it('discarded DELETE lets the server win (no delete op uploaded)', async () => {
    await stall();
    await mirrorNode('b1', 'n1', 'Docs');
    const op = await seedIntent({ type: 'delete', nodeId: 'n1', title: undefined, url: undefined });
    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');

    const outcome = await resync.resolveIntents(bindingId, [{ opId: op.opId, decision: 'discard' }]);

    expect(outcome).toBe('resynced');
    expect(server.journal.some((c) => c.type === 'delete' && c.node_id === 'n1')).toBe(false);
    expect(await adapter.getChildren('f1')).toHaveLength(1);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });

  it('discarding every intent converges with nothing uploaded', async () => {
    const op = await seedIntent();
    await stall();
    await resync.attemptRecovery(bindingId);

    const outcome = await resync.resolveIntents(bindingId, [{ opId: op.opId, decision: 'discard' }]);

    expect(outcome).toBe('resynced');
    expect(server.journal).toHaveLength(1);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
    expect(await db.emergencySnapshots.count()).toBe(0);
  });
});

describe('full resync against the canonical snapshot (doc 06 §7/§8)', () => {
  it('is a noop for a healthy binding', async () => {
    await seedBinding();
    expect(await resync.attemptRecovery(bindingId)).toBe('noop');
    expect(engine.calls).toEqual([]);
  });

  it('asks for a full_resync session and declares the mapping it still trusts', async () => {
    await stall();
    await mirrorNode('fd', 'n1', 'Docs');

    expect(await resync.attemptRecovery(bindingId)).toBe('resynced');
    expect(engine.type).toBe('full_resync');
    // Without the declared canonical ids the server could only guess at
    // identity, and the browser node would be created a second time.
    expect(engine.snapshot?.nodes.map((n) => n.canonical_id)).toEqual(['n1']);
  });

  it('brings back a bookmark whose CREATE has already been garbage collected', async () => {
    // The shape the journal re-anchor could not repair: 'Server-only' was
    // created while this device was offline, its CREATE has been pruned below
    // the floor, and nothing after it mentions it. The journal the client can
    // still pull holds only n1.
    await seedBinding({ state: 'needs_recovery', appliedRevision: 0, receivedRevision: 0 });
    server.floor = 42;
    server.epoch = 3;
    await mirrorNode('fd', 'n1', 'Docs');
    engine.baselineRevision = 42;
    engine.epoch = 3;
    engine.steps = [createStep('n9', 'Server-only', 'https://srv-only.example')];

    expect(await resync.attemptRecovery(bindingId)).toBe('resynced');

    // The browser holds it — which is the acceptance criterion, not the state.
    const created = (await adapter.getChildren('f1')).find((c) => c.title === 'Server-only');
    expect(created).toBeTruthy();
    const mirror = await db.localNodes.get([bindingId, created!.id]);
    expect(mirror?.canonicalId).toBe('n9');
    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('active');
    expect(binding?.appliedRevision).toBe(42);
    expect(binding?.epoch).toBe(3);
    // …and it never came from the change stream the client could replay.
    expect(server.journal.filter((c) => c.node_id === 'n9')).toHaveLength(0);
  });

  it('does not report success when a planned node never lands', async () => {
    await stall();
    await mirrorNode('fd', 'n1', 'Docs');
    // A step that cannot be applied: its parent belongs to no mapping this
    // replica has, so the plan is not satisfied and must not be completed.
    engine.steps = [{ ...createStep('n9', 'Lost', 'https://lost.example'), parent: { type: 'node', id: 'nope' } }];

    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');
    const binding = await db.bindings.get(bindingId);
    expect(binding?.state).toBe('needs_recovery');
    expect(engine.calls).not.toContain('complete');
  });

  it('leaves the binding asking for its first reconciliation when the server refuses a resync', async () => {
    // After a backup restore the binding is pending_initial server-side, and
    // no resync can be opened against it.
    await stall();
    engine.createError = new ApiError(409, 'BINDING_NOT_ELIGIBLE', 'the binding state does not allow this type');

    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');
    expect((await db.bindings.get(bindingId))?.state).toBe('pending_initial');
    // The dead session is not left open to block the one that can work.
    expect(await db.reconSessions.filter((s) => s.state !== 'COMPLETED' && s.state !== 'FAILED').count()).toBe(0);
  });

  it('adopts the session a lost create response left orphaned (doc 08 §11)', async () => {
    await stall();
    await mirrorNode('fd', 'n1', 'Docs');
    // The server opened the session and its answer never came back; every
    // later create is then refused by the binding's own orphan.
    engine.createError = new ApiError(409, 'RECONCILIATION_IN_PROGRESS', 'this binding already runs one');

    expect(await resync.attemptRecovery(bindingId)).toBe('resynced');
    expect(engine.sessionsCreated).toBe(1);
    expect(engine.calls.slice(0, 2)).toEqual(['create', 'active-session']);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });

  it('refuses to carry on inside a session of a different kind', async () => {
    await stall();
    engine.createError = new ApiError(409, 'RECONCILIATION_IN_PROGRESS', 'this binding already runs one');
    engine.activeType = 'initial';

    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');
    expect(engine.calls).not.toContain('client-snapshot');
    expect((await db.bindings.get(bindingId))?.state).toBe('needs_recovery');
  });

  it('re-matches from scratch when the server refuses the mapping it declared', async () => {
    // Two browser nodes claiming one canonical id is a mapping the resync
    // cannot be run on, and it is the reason the mapping-lost path exists: the
    // retry declares nothing and lets the server match the tree again.
    await stall();
    await mirrorNode('fd', 'n1', 'Docs');
    engine.submitError = new ApiError(400, 'CLIENT_SNAPSHOT_INVALID', 'duplicate canonical id n1');

    expect(await resync.attemptRecovery(bindingId)).toBe('resynced');

    expect(engine.snapshots[0]!.nodes.map((n) => n.canonical_id)).toEqual(['n1']);
    expect(engine.type).toBe('recovery');
    expect(engine.snapshots[1]!.nodes.every((n) => n.canonical_id === undefined)).toBe(true);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });

  it('is re-entrant: a second trigger resumes the session the first one opened', async () => {
    await stall();
    await mirrorNode('fd', 'n1', 'Docs');
    // Stop the lifecycle after the client snapshot, the way a worker kill does.
    engine.phase = 'snapshot_ready';
    engine.completeError = new ApiError(0, 'NETWORK_ERROR', 'worker came down');

    expect(await resync.attemptRecovery(bindingId)).toBe('waiting');
    expect(engine.sessionsCreated).toBe(1);
    engine.completeError = null;

    expect(await resync.attemptRecovery(bindingId)).toBe('resynced');
    expect(engine.sessionsCreated).toBe(1);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });
});
