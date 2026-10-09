// Server-driven initial reconciliation (doc 08 §11-§13).
//
// A freshly paired binding is `pending_initial`: incremental sync must not
// run for it, and completing an `initial` reconciliation is the only way it
// becomes active. The engine here is deliberately thin — the browser tree is
// submitted as a snapshot, the server matches, plans and decides, and the
// client only applies the steps it hands back (doc 08 §13: no second planner).
//
// Progress lives on the SERVER session, so an MV3 worker kill resumes by
// reading `session.phase` and continuing from there. Everything the client
// needs across a restart is persisted on the local session record: the server
// session id, the frozen snapshot id, and the snapshot's local_ref → browser
// id map, which is what makes a step's `local_ref` resolvable after a restart.

import type { BrowserAdapter } from '../browser/types';
import {
  acquireRunLock,
  activeReconSession,
  emptyReconProgress,
  logDiagnostic,
  releaseRunLock,
  type BindingRecord,
  type PontisDB,
  type ReconSessionRecord,
} from '../store/db';
import type {
  ClientSnapshotWire,
  ReconciliationEnvelopeWire,
  ReconciliationType,
} from '../protocol/types';
import { ApiError, type ReconciliationTransport } from '../transport/client';
import { uuidv7 } from '../util/ids';
import { applyReconcileSteps, verifyAppliedSteps, type StepScope } from './reconcileSteps';

/** Round budget for one run(); each round advances exactly one server phase. */
const MAX_LIFECYCLE_ROUNDS = 16;

export type LifecycleOutcome = 'waiting_user' | 'completed';

/** The mount as a root-slot → browser-root map (doc 03). */
export function mountRoots(binding: BindingRecord): Record<string, string> {
  if (binding.mount.mode === 'partial') {
    const folder = binding.mount.folderBrowserId;
    if (!folder) throw new Error('initialReconcile: partial binding has no mount folder');
    return { [binding.mount.rootKey]: folder };
  }
  return { ...(binding.mount.roots ?? {}) };
}

/**
 * Flatten the mounted browser tree into a client snapshot (doc 08 §10).
 * Refs are session-local (`l_1` is the first root) and a first-time device
 * declares no canonical ids — the server refuses them for a pending binding,
 * because it has nothing to check the claim against.
 */
export async function buildClientSnapshot(
  adapter: BrowserAdapter,
  binding: BindingRecord,
  epoch: number,
  revision: number,
): Promise<{ snapshot: ClientSnapshotWire; refs: Record<string, string> }> {
  const roots: ClientSnapshotWire['roots'] = [];
  const nodes: ClientSnapshotWire['nodes'] = [];
  const refs: Record<string, string> = {};
  let next = 1;
  const ref = (browserId: string): string => {
    const known = Object.keys(refs).find((r) => refs[r] === browserId);
    if (known) return known;
    const created = `l_${next++}`;
    refs[created] = browserId;
    return created;
  };

  for (const [rootKey, browserId] of Object.entries(mountRoots(binding))) {
    const root = await adapter.getNode(browserId);
    if (!root) throw new Error(`initialReconcile: mount root ${browserId} not found`);
    const localRef = ref(browserId);
    if (!roots.some((r) => r.root_key === rootKey)) {
      roots.push({ local_ref: localRef, root_key: rootKey, title: root.title });
    }
    // Breadth-first, so a parent's ref is always assigned before its child's.
    const level = (await adapter.getChildren(browserId)).map((c) => ({ node: c, parentRef: localRef }));
    while (level.length > 0) {
      const { node, parentRef } = level.shift()!;
      const localRef = ref(node.id);
      nodes.push({
        local_ref: localRef,
        parent_local_ref: parentRef,
        type: node.type,
        title: node.title,
        url: node.url ?? '',
      });
      if (node.type === 'folder') {
        for (const child of await adapter.getChildren(node.id)) {
          level.push({ node: child, parentRef: localRef });
        }
      }
    }
  }
  return { snapshot: { epoch, revision, roots, nodes }, refs };
}

export class InitialReconciler {
  constructor(
    private db: PontisDB,
    private adapter: BrowserAdapter,
    private transport: ReconciliationTransport,
  ) {}

  /**
   * Drive the binding's server session as far as it goes. It stops at
   * `waiting_user` when the plan carries issues the user must answer, and
   * returns `completed` once the steps have been applied and closed out.
   */
  async run(binding: BindingRecord, session: ReconSessionRecord): Promise<LifecycleOutcome> {
    for (let round = 0; round < MAX_LIFECYCLE_ROUNDS; round++) {
      const env = await this.ensureSession(binding, session);
      const sess = env.session;
      session.serverSessionId = sess.id;
      session.serverPhase = sess.phase;
      if (sess.plan_hash) session.planHash = sess.plan_hash;
      if (sess.commit_revision) session.commitRevision = sess.commit_revision;
      await this.touch(session);

      if (sess.state === 'completed') return this.finish(binding, session, env);
      if (sess.state === 'failed') {
        throw new Error(`initialReconcile: server session ${sess.id} failed`);
      }
      if (sess.state === 'waiting_user') {
        session.state = 'WAITING_USER';
        session.issues = env.issues;
        session.progress = { ...session.progress, ambiguous: env.issues.length };
        await this.touch(session);
        await this.db.bindings.update(binding.id, { state: 'waiting_user' });
        await logDiagnostic(this.db, 'info', 'initial-reconcile', 'server plan needs an answer', {
          bindingId: binding.id,
          sessionId: sess.id,
          issues: env.issues.map((i) => i.id),
        });
        return 'waiting_user';
      }

      switch (sess.phase) {
        case 'collecting':
          await this.submitBrowserSnapshot(binding, session);
          break;
        case 'snapshot_ready':
          await this.transport.createServerSnapshot(binding.id);
          break;
        case 'server_ready':
          await this.transport.planReconciliation(sess.id);
          break;
        case 'planned':
          await this.commit(binding, session, sess.id);
          break;
        case 'committed':
          return this.applyStepsAndComplete(binding, session);
        default:
          throw new Error(`initialReconcile: session ${sess.id} reports no resumable phase`);
      }
    }
    throw new Error('initialReconcile: lifecycle did not converge within the round budget');
  }

  /**
   * Create-or-resume entry for the background driver: every pending binding
   * gets one call per trigger. A session that already names a server session
   * resumes from the phase the server reported, which is what makes an MV3
   * kill in the middle of the lifecycle harmless.
   */
  async runBinding(bindingId: string): Promise<LifecycleOutcome | 'idle'> {
    const token = uuidv7();
    if (!(await acquireRunLock(this.db, bindingId, token))) return 'idle';
    try {
      return await this.driveBinding(bindingId);
    } finally {
      await releaseRunLock(this.db, bindingId, token);
    }
  }

  private async driveBinding(bindingId: string): Promise<LifecycleOutcome | 'idle'> {
    const binding = await this.mustGetBinding(bindingId);
    // A waiting_user session is driven by `answer`, not by a sync trigger: the
    // server will not move until the user picks a candidate.
    if (binding.state !== 'pending_initial' && binding.state !== 'initializing') return 'idle';
    const found = await activeReconSession(this.db, bindingId);
    // 'initializing' is shared with the client-side engines. A session that
    // this lifecycle did not open stays theirs — but one it opened stays ours
    // even when the first server call failed before an id came back.
    if (found && found.driver !== 'server' && !found.serverSessionId) return 'idle';
    const session = found ?? (await this.openSession(binding));
    await this.db.bindings.update(binding.id, { state: 'initializing' });
    return this.run(binding, session);
  }

  private async openSession(binding: BindingRecord): Promise<ReconSessionRecord> {
    const now = Date.now();
    const session: ReconSessionRecord = {
      id: uuidv7(),
      bindingId: binding.id,
      type: 'INITIAL',
      state: 'RUNNING',
      phase: 'prepare',
      driver: 'server',
      journalFloor: 0,
      serverRevision: 0,
      progress: emptyReconProgress(),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.reconSessions.put(session);
    return session;
  }

  /**
   * Record the user's answers on the open issues (issue id → a candidate the
   * plan offered; an empty value keeps the server's safe default) and carry on.
   */
  async answer(bindingId: string, decisions: Record<string, string>): Promise<LifecycleOutcome> {
    const session = await activeReconSession(this.db, bindingId);
    if (!session?.serverSessionId) {
      throw new Error('initialReconcile: session has no server reconciliation to answer');
    }
    const binding = await this.mustGetBinding(bindingId);
    // The decisions call drives the rest of the lifecycle, so it holds the
    // same lock a sync trigger would take.
    const token = uuidv7();
    if (!(await acquireRunLock(this.db, bindingId, token))) {
      throw new Error('initialReconcile: another round is holding this binding');
    }
    try {
      return await this.decideAndRun(binding, session, decisions);
    } finally {
      await releaseRunLock(this.db, bindingId, token);
    }
  }

  private async decideAndRun(
    binding: BindingRecord,
    session: ReconSessionRecord,
    decisions: Record<string, string>,
  ): Promise<LifecycleOutcome> {
    await this.transport.decideReconciliation(session.serverSessionId!, decisions);
    session.state = 'RUNNING';
    session.issues = undefined;
    await this.touch(session);
    await this.db.bindings.update(binding.id, { state: 'initializing' });
    return this.run(binding, session);
  }

  // --- phases ---

  /** The binding's server session: read it when one exists, else open one. */
  private async ensureSession(
    binding: BindingRecord,
    session: ReconSessionRecord,
  ): Promise<ReconciliationEnvelopeWire> {
    if (session.serverSessionId) return this.transport.getReconciliation(session.serverSessionId);
    const type: ReconciliationType = session.type === 'INITIAL' ? 'initial' : 'recovery';
    const env = await this.transport.createReconciliation(binding.id, type, 'first synchronization');
    session.serverSessionId = env.session.id;
    await this.touch(session);
    return env;
  }

  /**
   * The local_ref map is persisted BEFORE the snapshot is submitted: a resume
   * at a later phase must still resolve the steps' `local_ref`s against the
   * snapshot the server actually planned on, not a freshly built one.
   */
  private async submitBrowserSnapshot(
    binding: BindingRecord,
    session: ReconSessionRecord,
  ): Promise<void> {
    const { snapshot, refs } = await buildClientSnapshot(
      this.adapter,
      binding,
      binding.epoch,
      binding.appliedRevision,
    );
    session.localRefs = refs;
    session.progress.localOnly = snapshot.nodes.length;
    await this.touch(session);
    await this.transport.submitClientSnapshot(binding.id, snapshot);
  }

  /**
   * Commit the plan. A stale plan (the canonical head moved since the
   * preview) is re-planned and retried by the next round: the server
   * re-freezes its snapshot against the new head (doc 08 §12).
   */
  private async commit(binding: BindingRecord, session: ReconSessionRecord, sessionId: string): Promise<void> {
    try {
      await this.transport.commitReconciliation(sessionId);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PLAN_STALE') {
        await logDiagnostic(this.db, 'info', 'initial-reconcile', 'plan went stale, previewing the new target', {
          bindingId: binding.id,
          sessionId,
        });
        await this.transport.planReconciliation(sessionId);
        return;
      }
      throw err;
    }
  }

  private async applyStepsAndComplete(
    binding: BindingRecord,
    session: ReconSessionRecord,
  ): Promise<LifecycleOutcome> {
    const sessionId = session.serverSessionId!;
    const { steps } = await this.transport.fetchSteps(sessionId);
    const scope: StepScope = {
      bindingId: binding.id,
      localRefs: session.localRefs ?? {},
      roots: mountRoots(binding),
    };
    await applyReconcileSteps(this.db, this.adapter, scope, steps);
    // Do not ask the server to close out a plan the browser does not hold:
    // completing adopts the commit revision as the new baseline, which would
    // hide every node that never landed.
    const problems = await verifyAppliedSteps(this.db, this.adapter, binding.id, steps);
    if (problems.length > 0) {
      await logDiagnostic(this.db, 'error', 'initial-reconcile', 'applied plan is not satisfied, retrying next round', {
        bindingId: binding.id,
        sessionId,
        problems: problems.slice(0, 10),
        problemCount: problems.length,
      });
      session.error = `${problems.length} planned node(s) are not in the browser`;
      await this.touch(session);
      throw new Error(`initialReconcile: plan not satisfied after apply (${problems[0]})`);
    }
    session.progress.applied = session.commitRevision ?? session.progress.applied;
    session.progress.serverOnly = 0;
    session.serverPhase = 'committed';
    session.error = undefined;
    await this.touch(session);
    const done = await this.transport.completeReconciliation(sessionId);
    return this.finish(binding, session, done);
  }

  /**
   * Write the server's answer back into the replica baseline (doc 06 §8):
   * both watermarks sit at the commit revision, so the next /sync round
   * carries only what changed after the reconciliation.
   */
  private async finish(
    binding: BindingRecord,
    session: ReconSessionRecord,
    env: ReconciliationEnvelopeWire,
  ): Promise<LifecycleOutcome> {
    const revision = env.binding?.applied_revision ?? session.commitRevision;
    if (revision == null) {
      throw new Error('initialReconcile: completed without a baseline revision to adopt');
    }
    const epoch = env.binding?.epoch ?? binding.epoch;
    await this.db.bindings.update(binding.id, {
      state: 'active',
      epoch,
      appliedRevision: revision,
      receivedRevision: revision,
      lastSyncAt: Date.now(),
      recovery: null,
    });
    session.state = 'COMPLETED';
    session.phase = 'done';
    session.issues = undefined;
    session.serverPhase = env.session.phase;
    await this.touch(session);
    await logDiagnostic(this.db, 'info', 'initial-reconcile', 'initial reconciliation completed', {
      bindingId: binding.id,
      sessionId: env.session.id,
      baselineRevision: revision,
    });
    return 'completed';
  }

  private async touch(session: ReconSessionRecord): Promise<void> {
    session.updatedAt = Date.now();
    await this.db.reconSessions.put(session);
  }

  private async mustGetBinding(bindingId: string): Promise<BindingRecord> {
    const b = await this.db.bindings.get(bindingId);
    if (!b) throw new Error(`initialReconcile: binding ${bindingId} vanished`);
    return b;
  }
}
