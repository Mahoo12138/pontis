// Server-driven initial reconciliation (doc 08 §11-§13). The extension owns
// no planner here: these tests pin the client's side of the handshake — the
// snapshot it submits, the phase it resumes from after an MV3 kill, and the
// baseline it adopts when the server says the plan is committed.

import { beforeEach, describe, expect, it } from 'vitest';
import { PontisDB, emptyReconProgress, type BindingRecord, type ReconSessionRecord } from '../store/db';
import { FakeBrowserAdapter } from '../browser/fakeAdapter';
import { RemoteChangeApplier } from './remoteChangeApplier';
import { SyncCoordinator } from './syncCoordinator';
import { InitialReconciler, buildClientSnapshot } from './initialReconcile';
import { ApiError, type ReconciliationTransport } from '../transport/client';
import type {
  ApplyStepWire,
  ClientSnapshotWire,
  ReconciliationEnvelopeWire,
  ReconciliationIssueWire,
  ReconciliationPhase,
  ReconciliationState,
  ServerSnapshotPageWire,
  ServerSnapshotWire,
  StepsWire,
} from '../protocol/types';
import type { SyncTransport } from '../transport/client';

let db: PontisDB;
let adapter: FakeBrowserAdapter;
let lifecycle: FakeLifecycle;
let reconciler: InitialReconciler;

const bindingId = 'binding-1';

async function seedBinding(over: Partial<BindingRecord> = {}): Promise<BindingRecord> {
  const binding: BindingRecord = {
    id: bindingId,
    spaceId: 'space-1',
    spaceName: 'Personal',
    mode: 'partial',
    state: 'pending_initial',
    epoch: 1,
    appliedRevision: 0,
    receivedRevision: 0,
    clientSeq: 0,
    mount: { mode: 'partial', folderBrowserId: 'f1', rootKey: 'main' },
    lastSyncAt: null,
    recovery: null,
    createdAt: Date.now(),
    ...over,
  };
  await db.bindings.put(binding);
  return binding;
}

/**
 * A stand-in for the server's session state machine: it accepts a lifecycle
 * call only when the session has actually reached the phase that call needs,
 * so an engine that skipped or repeated a phase would get an envelope back
 * that it could not progress from.
 */
class FakeLifecycle implements ReconciliationTransport {
  calls: string[] = [];
  phase: ReconciliationPhase = 'collecting';
  state: ReconciliationState = 'running';
  commitRevision = 121;
  issues: ReconciliationIssueWire[] = [];
  steps: ApplyStepWire[] = [];
  submitted: ClientSnapshotWire | null = null;
  decisions: Array<Record<string, string>> = [];
  /** Errors the commit endpoint raises before it accepts the plan. */
  commitErrors: ApiError[] = [];

  private envelope(): ReconciliationEnvelopeWire {
    const committed = this.phase === 'committed';
    return {
      session: {
        id: 'srv-1',
        binding_id: bindingId,
        space_id: 'space-1',
        type: 'initial',
        reason: 'first synchronization',
        state: this.state,
        phase: this.state === 'completed' ? undefined : this.phase,
        source_epoch: 1,
        source_revision: 0,
        target_epoch: 1,
        target_revision: 120,
        plan_hash: committed || this.phase === 'planned' ? 'plan-1' : undefined,
        server_committed: committed,
        commit_revision: committed ? this.commitRevision : 0,
        created_at: '',
        updated_at: '',
      },
      issues: this.issues,
      binding:
        this.state === 'completed'
          ? {
              id: bindingId,
              device_id: 'device-1',
              space_id: 'space-1',
              state: 'active',
              epoch: 1,
              applied_revision: this.commitRevision,
              received_revision: this.commitRevision,
              max_client_seq: 0,
            }
          : undefined,
    };
  }

  createReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('create');
    return Promise.resolve(this.envelope());
  }

  submitClientSnapshot(_bindingId: string, snapshot: ClientSnapshotWire): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('client-snapshot');
    this.submitted = snapshot;
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
      epoch: 1,
      revision: 120,
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
    if (this.issues.length > 0) this.state = 'waiting_user';
    return Promise.resolve(this.envelope());
  }

  decideReconciliation(_sessionId: string, decisions: Record<string, string>): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('decide');
    this.decisions.push(decisions);
    this.state = 'running';
    this.issues = [];
    return Promise.resolve(this.envelope());
  }

  commitReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('commit');
    const err = this.commitErrors.shift();
    if (err) return Promise.reject(err);
    this.phase = 'committed';
    return Promise.resolve(this.envelope());
  }

  fetchSteps(): Promise<StepsWire> {
    this.calls.push('steps');
    return Promise.resolve({ plan_hash: 'plan-1', steps: this.steps });
  }

  completeReconciliation(): Promise<ReconciliationEnvelopeWire> {
    this.calls.push('complete');
    this.state = 'completed';
    return Promise.resolve(this.envelope());
  }
}

/** The session the engine persisted during a run. */
async function savedSession(): Promise<ReconSessionRecord> {
  const rows = await db.reconSessions.where('bindingId').equals(bindingId).toArray();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

beforeEach(async () => {
  db = new PontisDB(`test-${Math.random()}`);
  adapter = new FakeBrowserAdapter();
  lifecycle = new FakeLifecycle();
  reconciler = new InitialReconciler(db, adapter, lifecycle);
  adapter.seed({ id: 'f1', parentId: '0', title: 'Sync' });
  adapter.seed({ id: 'b1', parentId: 'f1', title: 'Home', url: 'https://home.example.com' });
  adapter.seed({ id: 'b2', parentId: 'f1', title: 'Docs', url: 'https://docs.example.com' });
});

describe('initial reconciliation lifecycle', () => {
  it('walks the server phases once and activates the binding at its baseline', async () => {
    const binding = await seedBinding();
    lifecycle.steps = [
      { kind: 'assign_identity', local_ref: 'l_2', canonical_id: 'n1' },
      { kind: 'assign_identity', local_ref: 'l_3', canonical_id: 'n2' },
    ];

    expect(await reconciler.runBinding(binding.id)).toBe('completed');

    expect(lifecycle.calls).toEqual([
      'create',
      'client-snapshot',
      'get',
      'server-snapshot',
      'get',
      'plan',
      'get',
      'commit',
      'get',
      'steps',
      'complete',
    ]);
    const fresh = await db.bindings.get(bindingId);
    expect(fresh?.state).toBe('active');
    // Both watermarks move to the revision the server committed the plan at,
    // so the next ordinary round carries only what changed after it.
    expect(fresh?.appliedRevision).toBe(121);
    expect(fresh?.receivedRevision).toBe(121);
    expect((await savedSession()).state).toBe('COMPLETED');
    // The browser already held these nodes, so the steps only mapped them.
    const mirrors = await db.localNodes.toArray();
    expect(mirrors.map((m) => [m.browserId, m.canonicalId])).toEqual([
      ['b1', 'n1'],
      ['b2', 'n2'],
    ]);
    expect(adapter.calls).toEqual([]);
    // The order the steps left behind in the browser becomes the mirror's
    // canonical order, so the next round's indexes are computed from it.
    expect(mirrors.map((m) => m.position)).toEqual([0, 1]);
  });

  it('submits the mounted tree with session-local refs and no canonical ids', async () => {
    const binding = await seedBinding();
    adapter.seed({ id: 'f3', parentId: 'f1', title: 'Nested' });
    adapter.seed({ id: 'b3', parentId: 'f3', title: 'Deep', url: 'https://deep.example.com' });

    await reconciler.runBinding(binding.id);

    const snap = lifecycle.submitted!;
    expect(snap.roots).toEqual([{ local_ref: 'l_1', root_key: 'main', title: 'Sync' }]);
    // Breadth-first: a parent's ref exists before any child names it, and the
    // mount's own children are numbered before the level below them.
    expect(snap.nodes.map((n) => [n.local_ref, n.parent_local_ref, n.title])).toEqual([
      ['l_2', 'l_1', 'Home'],
      ['l_3', 'l_1', 'Docs'],
      ['l_4', 'l_1', 'Nested'],
      ['l_5', 'l_4', 'Deep'],
    ]);
    expect(snap.nodes.every((n) => !('canonical_id' in n))).toBe(true);
  });

  it('stops for the user and resumes the same server session on the answer', async () => {
    const binding = await seedBinding();
    lifecycle.issues = [
      {
        id: 'i1',
        type: 'ambiguous_identity',
        payload: { source_ref: 'l_2', title: 'Home', url: 'https://home.example.com', candidates: ['n1', 'n2'] },
        default_choice: '',
      },
    ];
    lifecycle.steps = [{ kind: 'assign_identity', local_ref: 'l_2', canonical_id: 'n1' }];

    expect(await reconciler.runBinding(binding.id)).toBe('waiting_user');
    expect((await db.bindings.get(bindingId))?.state).toBe('waiting_user');
    const waiting = await savedSession();
    expect(waiting.serverSessionId).toBe('srv-1');
    expect(waiting.issues?.map((i) => i.id)).toEqual(['i1']);
    // The ref map survives the wait: the plan will name l_2, and only the
    // snapshot's map says which browser node that was.
    expect(waiting.localRefs).toEqual({ l_1: 'f1', l_2: 'b1', l_3: 'b2' });

    expect(await reconciler.answer(bindingId, { i1: 'n2' })).toBe('completed');
    expect(lifecycle.decisions).toEqual([{ i1: 'n2' }]);
    // One session for the whole exchange, not one per trigger.
    expect(lifecycle.calls.filter((c) => c === 'create')).toHaveLength(1);
    expect((await db.localNodes.get([bindingId, 'b1']))?.canonicalId).toBe('n1');
  });

  it('replans instead of committing a plan the server already invalidated', async () => {
    const binding = await seedBinding();
    lifecycle.commitErrors = [new ApiError(409, 'PLAN_STALE', 'canonical head moved')];

    expect(await reconciler.runBinding(binding.id)).toBe('completed');

    expect(lifecycle.calls.filter((c) => c === 'plan')).toHaveLength(2);
    expect(lifecycle.calls.filter((c) => c === 'commit')).toHaveLength(2);
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });

  it('resumes from the server phase after the worker was killed', async () => {
    const binding = await seedBinding();
    // The state an interrupted run leaves behind: the plan is committed
    // server-side, the steps never reached the browser.
    await db.reconSessions.put({
      id: 'sess-1',
      bindingId,
      type: 'INITIAL',
      state: 'RUNNING',
      phase: 'prepare',
      journalFloor: 0,
      serverRevision: 0,
      progress: emptyReconProgress(),
      serverSessionId: 'srv-1',
      serverPhase: 'committed',
      commitRevision: 121,
      localRefs: { l_1: 'f1', l_2: 'b1', l_3: 'b2' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db.bindings.update(bindingId, { state: 'initializing' });
    lifecycle.phase = 'committed';
    lifecycle.steps = [
      { kind: 'assign_identity', local_ref: 'l_2', canonical_id: 'n1' },
      { kind: 'assign_identity', local_ref: 'l_3', canonical_id: 'n2' },
    ];

    expect(await reconciler.runBinding(bindingId)).toBe('completed');

    // No snapshot was re-submitted and no second session opened: the restart
    // picked up at the apply step and resolved refs from the persisted map.
    expect(lifecycle.calls).toEqual(['get', 'steps', 'complete']);
    expect((await db.bindings.get(bindingId))?.appliedRevision).toBe(121);
  });

  it('resumes a lifecycle round that failed before the server opened a session', async () => {
    // The exact state a crashed first round leaves: our own session, but no
    // server session id yet. Refusing to pick it up would strand the binding
    // in 'initializing' forever, with no engine willing to run it.
    await seedBinding({ state: 'initializing' });
    await db.reconSessions.put({
      id: 'sess-2',
      bindingId,
      type: 'INITIAL',
      state: 'RUNNING',
      phase: 'prepare',
      driver: 'server',
      journalFloor: 0,
      serverRevision: 0,
      progress: emptyReconProgress(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(await reconciler.runBinding(bindingId)).toBe('completed');
    expect(lifecycle.calls[0]).toBe('create');
    expect((await db.bindings.get(bindingId))?.state).toBe('active');
  });

  it('leaves a binding the lifecycle already finished alone', async () => {
    await seedBinding({ state: 'active', appliedRevision: 121, receivedRevision: 121 });

    expect(await reconciler.runBinding(bindingId)).toBe('idle');
    expect(lifecycle.calls).toEqual([]);
  });

  it('leaves a legacy client-side initializing session to its own engine', async () => {
    await seedBinding({ state: 'initializing' });
    await db.reconSessions.put({
      id: 'sess-legacy',
      bindingId,
      type: 'INITIAL',
      state: 'RUNNING',
      phase: 'analyze',
      journalFloor: 0,
      serverRevision: 0,
      progress: emptyReconProgress(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(await reconciler.runBinding(bindingId)).toBe('idle');
    expect(lifecycle.calls).toEqual([]);
    expect((await db.bindings.get(bindingId))?.state).toBe('initializing');
  });

  it('refuses to run an ordinary sync round for a pending binding', async () => {
    await seedBinding();
    const forbidden: SyncTransport = {
      sync: () => Promise.reject(new Error('/sync must not run before the first reconciliation')),
    };
    const coordinator = new SyncCoordinator(db, new RemoteChangeApplier(db, adapter), forbidden);

    expect(await coordinator.syncBinding(bindingId)).toBe('inactive');
  });
});

describe('client snapshot build', () => {
  it('reads the mount as the only root the partial binding owns', async () => {
    const binding = await seedBinding();

    const { snapshot, refs } = await buildClientSnapshot(adapter, binding, 1, 0);

    expect(snapshot.epoch).toBe(1);
    expect(snapshot.revision).toBe(0);
    expect(refs['l_1']).toBe('f1');
    expect(Object.keys(refs)).toHaveLength(3);
  });

  it('fails rather than submitting a snapshot through a vanished mount', async () => {
    const binding = await seedBinding();
    await adapter.removeSubtree('f1');

    await expect(buildClientSnapshot(adapter, binding, 1, 0)).rejects.toThrow('mount root f1 not found');
  });
});
