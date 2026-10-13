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
  isUnsettledOp,
  logDiagnostic,
  releaseRunLock,
  writeEmergencySnapshot,
  type BindingRecord,
  type BindingState,
  type PontisDB,
  type ReconSessionRecord,
  type ReconType,
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

/** The server-side reconciliation kind a local session stands for (doc 08 §11). */
function sessionTypeOf(type: ReconSessionRecord['type']): ReconciliationType {
  if (type === 'INITIAL') return 'initial';
  if (type === 'FULL_RESYNC') return 'full_resync';
  return 'recovery';
}

/** Why the session exists, as the server records it (doc 06 §7/§12). */
function reasonFor(type: ReconSessionRecord['type']): string {
  if (type === 'INITIAL') return 'first synchronization';
  if (type === 'FULL_RESYNC') return 'history expired';
  return 'mapping lost';
}

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
 *
 * `canonicalIdOf` is what a full resync passes: its premise is a mapping the
 * device still trusts (doc 06 §7), and declaring it is how the server matches
 * the tree node by node instead of guessing.
 */
export async function buildClientSnapshot(
  adapter: BrowserAdapter,
  binding: BindingRecord,
  epoch: number,
  revision: number,
  canonicalIdOf?: (browserId: string) => Promise<string | undefined>,
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
      const canonicalId = canonicalIdOf ? await canonicalIdOf(node.id) : undefined;
      nodes.push({
        local_ref: localRef,
        parent_local_ref: parentRef,
        type: node.type,
        title: node.title,
        url: node.url ?? '',
        ...(canonicalId ? { canonical_id: canonicalId } : {}),
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
        // The server closed this session — a backup restore superseded the
        // baseline it was planned against, or the binding was revoked. Nothing
        // resumed from it can ever succeed, so the local record goes with it
        // and the binding asks for recovery, which opens a fresh session
        // against the baseline the server actually holds now.
        session.state = 'FAILED';
        session.error = 'the server closed this reconciliation';
        await this.touch(session);
        await this.db.bindings.update(binding.id, {
          state: 'needs_recovery',
          recovery: { code: 'RECONCILIATION_SUPERSEDED', message: 'the space baseline was replaced' },
        });
        await logDiagnostic(this.db, 'warn', 'initial-reconcile', '服务端会话已关闭，该绑定需要恢复', {
          bindingId: binding.id,
          sessionId: sess.id,
        });
        throw new Error(`initialReconcile: server session ${sess.id} failed`);
      }
      if (sess.state === 'waiting_user') {
        session.state = 'WAITING_USER';
        session.issues = env.issues;
        session.progress = { ...session.progress, ambiguous: env.issues.length };
        await this.touch(session);
        await this.db.bindings.update(binding.id, { state: 'waiting_user' });
        await logDiagnostic(this.db, 'info', 'initial-reconcile', '服务端方案需要作答', {
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

  /**
   * Mapping lost (doc 06 §12): the device no longer trusts its
   * Canonical ↔ Browser mapping, so it re-declares the browser tree with fresh
   * local refs and lets the server match it. The client plans nothing — a
   * recovery re-maps, it does not re-create, and content the browser holds
   * alone is protected through the op pipeline and the Recovery Intent review
   * (doc 06 §11).
   *
   * The session is opened while the binding is still `active` because that is
   * the state the server requires for a recovery; `initializing` comes after,
   * and it is what pauses the incremental loop meanwhile.
   */
  async recoverMapping(bindingId: string): Promise<LifecycleOutcome | 'idle'> {
    const binding = await this.mustGetBinding(bindingId);
    if (binding.state !== 'active') {
      throw new Error(`initialReconcile: mapping recovery needs an active binding, got ${binding.state}`);
    }
    return this.driveRecovery(bindingId, 'MAPPING_LOST');
  }

  /**
   * Open the binding's recovery session and drive it. Kept separate from the
   * eligibility checks above because a remount is a recovery too — with a
   * different reason and a different state in front of it.
   */
  private async driveRecovery(bindingId: string, type: ReconType): Promise<LifecycleOutcome | 'idle'> {
    // A session already open on this binding IS the recovery in progress — from
    // an earlier attempt of this same request, or from the worker before a
    // kill. Join it; asking the server for a second one is refused anyway, and
    // the state the binding sits in has nothing to do with which attempt is
    // allowed to finish the work.
    const resumed = await this.resumeRecovery(bindingId);
    if (resumed !== 'idle') return resumed;
    const binding = await this.mustGetBinding(bindingId);
    const session = await this.openSession(binding, type);
    await this.db.bindings.update(bindingId, { state: 'initializing' });
    return this.run({ ...binding, state: 'initializing' }, session);
  }

  /**
   * mount_missing recovery (doc 03 §5): re-point a partial binding at another
   * browser folder. The mapping belonged to the folder that is gone, so the
   * replica state goes with it and the tree is matched again from scratch.
   *
   * Nothing is destroyed before the new mount is proven to exist, and what is
   * destroyed is copied to an emergency snapshot first: a remount that fails
   * half way must not leave a binding with a new folder, no mapping and no
   * recovery running (doc 06 §9).
   */
  async remount(bindingId: string, folderBrowserId: string): Promise<LifecycleOutcome | 'idle'> {
    const binding = await this.mustGetBinding(bindingId);
    if (binding.mount.mode !== 'partial') {
      throw new Error('initialReconcile: remount only supported for partial bindings');
    }
    if (!folderBrowserId) throw new Error('initialReconcile: remount needs a mount folder');
    const target = await this.adapter.getNode(folderBrowserId);
    if (!target || target.type !== 'folder') {
      throw new Error(`initialReconcile: remount target ${folderBrowserId} is not a browser folder`);
    }

    await writeEmergencySnapshot(this.db, binding, 'remount: mapping replaced');
    await this.db.transaction(
      'rw',
      [this.db.bindings, this.db.localNodes, this.db.pendingOps, this.db.expectedMutations, this.db.remoteChanges],
      async () => {
        const b = await this.db.bindings.get(bindingId);
        if (!b) return;
        b.mount = { ...b.mount, folderBrowserId };
        b.recovery = null;
        await this.db.bindings.put(b);
        await this.db.localNodes.where('bindingId').equals(bindingId).delete();
        await this.db.pendingOps.where('bindingId').equals(bindingId).delete();
        await this.db.expectedMutations.where('bindingId').equals(bindingId).delete();
        await this.db.remoteChanges.where('bindingId').equals(bindingId).delete();
      },
    );
    await logDiagnostic(this.db, 'info', 'initial-reconcile', '挂载目录已重新挂载，映射已恢复', {
      bindingId,
      folderBrowserId,
    });
    return this.driveRecovery(bindingId, 'MAPPING_LOST');
  }

  /**
   * Full Resync entry (doc 06 §7): the Canonical ↔ Browser mapping is still
   * trusted, but the incremental history cannot be continued any more, so the
   * browser is converged onto the whole canonical projection and the baseline
   * moves to the revision that projection was taken at.
   *
   * This is a reconciliation, not a watermark edit. A node whose CREATE has
   * been garbage collected is in no journal the client will ever be served
   * again — only a full snapshot still carries it, and only a plan computed
   * against that snapshot can put it back.
   */
  async resyncFromServer(bindingId: string): Promise<LifecycleOutcome | 'idle'> {
    const binding = await this.mustGetBinding(bindingId);
    if (binding.state !== 'needs_recovery' && binding.state !== 'resyncing') {
      throw new Error(`initialReconcile: full resync needs a stalled binding, got ${binding.state}`);
    }
    const session = await this.openSession(binding, 'FULL_RESYNC');
    await this.db.bindings.update(bindingId, { state: 'resyncing' });
    try {
      return await this.run({ ...binding, state: 'resyncing' }, session);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CLIENT_SNAPSHOT_INVALID') {
        // The snapshot this resync declared carries a mapping the server cannot
        // accept — the same canonical id on two browser nodes is the usual
        // cause. That is not a resync any more: the mapping itself is what has
        // to be rebuilt, from a snapshot that claims nothing.
        session.state = 'FAILED';
        session.error = 'the declared mapping was refused; re-matching from scratch';
        await this.touch(session);
        await logDiagnostic(this.db, 'warn', 'initial-reconcile', '重新同步声明的映射被拒绝，改用重新匹配', {
          bindingId,
          message: err.message,
        });
        return this.driveRecovery(bindingId, 'MAPPING_LOST');
      }
      // A backup restore moved the space back to a fresh baseline: the server
      // will not run a resync against a binding that owes its first
      // reconciliation, and the session we just opened is dead with it.
      if (err instanceof ApiError && err.code === 'BINDING_NOT_ELIGIBLE') {
        session.state = 'FAILED';
        session.error = 'the binding owes a first reconciliation';
        await this.touch(session);
        await this.db.bindings.update(bindingId, { state: 'pending_initial' });
        await logDiagnostic(this.db, 'info', 'initial-reconcile', '重新同步推迟到首次对账', {
          bindingId,
        });
        return 'idle';
      }
      throw err;
    }
  }

  /**
   * Resume the reconciliation this binding is already running, if a trigger
   * can no longer reach it by name. Returns 'idle' when there is nothing to
   * pick up — no session, or one that belongs to a lifecycle the driver
   * entries above own. Never opens a session, so it is safe to call on every
   * trigger for every stalled binding.
   */
  async resumeRecovery(bindingId: string): Promise<LifecycleOutcome | 'idle'> {
    const binding = await this.mustGetBinding(bindingId);
    const session = await activeReconSession(this.db, bindingId);
    if (session?.driver !== 'server') return 'idle';
    if (session.state === 'WAITING_USER') return 'waiting_user';
    await logDiagnostic(this.db, 'info', 'initial-reconcile', '继续被中断的对账', {
      bindingId,
      sessionType: session.type,
      bindingState: binding.state,
    });
    // The binding follows the session, not the other way round: whatever parked
    // it, the reconciliation was mid-flight and only it can decide the state
    // this ends in.
    await this.db.bindings.update(bindingId, {
      state: session.type === 'FULL_RESYNC' ? 'resyncing' : 'initializing',
    });
    return this.run({ ...binding, state: session.type === 'FULL_RESYNC' ? 'resyncing' : 'initializing' }, session);
  }

  private async driveBinding(bindingId: string): Promise<LifecycleOutcome | 'idle'> {
    const binding = await this.mustGetBinding(bindingId);
    // A waiting_user session is driven by `answer`, not by a sync trigger: the
    // server will not move until the user picks a candidate.
    // 'resyncing' belongs in this list: it is the same lifecycle with a
    // different reason, and a worker killed in the middle of one has to be
    // picked up by the next trigger like any other session.
    if (binding.state !== 'pending_initial' && binding.state !== 'initializing' && binding.state !== 'resyncing') {
      return 'idle';
    }
    const found = await activeReconSession(this.db, bindingId);
    // A session this lifecycle did not open stays someone else's — but one it
    // opened stays ours even when the first server call failed before an id
    // came back.
    if (found && found.driver !== 'server' && !found.serverSessionId) return 'idle';
    const session = found ?? (await this.openSession(binding));
    await this.db.bindings.update(binding.id, { state: 'initializing' });
    return this.run(binding, session);
  }

  private async openSession(binding: BindingRecord, type: ReconType = 'INITIAL'): Promise<ReconSessionRecord> {
    const existing = await activeReconSession(this.db, binding.id);
    if (existing) {
      if (existing.driver === 'server') return existing;
      throw new Error(
        `initialReconcile: binding ${binding.id} already has a ${existing.type} session this lifecycle does not own`,
      );
    }
    const now = Date.now();
    const session: ReconSessionRecord = {
      id: uuidv7(),
      bindingId: binding.id,
      type,
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
    // The answer resumes whichever lifecycle asked the question: a resync
    // parks at 'resyncing', an initialization at 'initializing'.
    const state: BindingState = session.type === 'FULL_RESYNC' ? 'resyncing' : 'initializing';
    await this.db.bindings.update(binding.id, { state });
    return this.run({ ...binding, state }, session);
  }

  // --- phases ---

  /** The binding's server session: read it when one exists, else open one. */
  private async ensureSession(
    binding: BindingRecord,
    session: ReconSessionRecord,
  ): Promise<ReconciliationEnvelopeWire> {
    if (session.serverSessionId) return this.transport.getReconciliation(session.serverSessionId);
    // A pending binding can only be finished by an `initial` reconciliation;
    // anything else is a recovery against a binding the server still calls
    // active (doc 08 §11).
    const type: ReconciliationType = sessionTypeOf(session.type);
    const reason = reasonFor(session.type);
    let env: ReconciliationEnvelopeWire;
    try {
      env = await this.transport.createReconciliation(binding.id, type, reason);
    } catch (err) {
      // The session can exist server-side while its answer never arrived —
      // a lost response, or a worker killed before the id was stored. One
      // binding runs at most one reconciliation, so the refusal is the sound
      // of that orphan: pick it back up, or initialization never advances.
      if (!(err instanceof ApiError) || err.code !== 'RECONCILIATION_IN_PROGRESS') throw err;
      env = await this.transport.getActiveReconciliation(binding.id);
      if (env.session.type !== type) {
        // Not ours to resume: a different kind of session is open on this
        // binding, and silently joining it would re-plan someone else's work.
        throw new Error(
          `initialReconcile: binding ${binding.id} already runs a ${env.session.type} reconciliation, not a ${type}`,
        );
      }
      await logDiagnostic(this.db, 'warn', 'initial-reconcile', '接管了该绑定遗留的对账会话', {
        bindingId: binding.id,
        sessionId: env.session.id,
        type,
      });
    }
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
    // A full resync is the one lifecycle whose premise is a trusted mapping, so
    // it is the one that declares it: the server matches the tree by canonical
    // id and the client keeps its browser nodes instead of duplicating them.
    const declareIds = session.type === 'FULL_RESYNC';
    const { snapshot, refs } = await buildClientSnapshot(
      this.adapter,
      binding,
      binding.epoch,
      binding.appliedRevision,
      declareIds ? (browserId) => this.mappedCanonicalId(binding.id, browserId) : undefined,
    );
    session.localRefs = refs;
    session.progress.localOnly = snapshot.nodes.length;
    await this.touch(session);
    await this.transport.submitClientSnapshot(binding.id, snapshot);
  }

  private async mappedCanonicalId(bindingId: string, browserId: string): Promise<string | undefined> {
    const mirror = await this.db.localNodes.get([bindingId, browserId]);
    return mirror?.canonicalId ?? undefined;
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
        await logDiagnostic(this.db, 'info', 'initial-reconcile', '方案已过期，正在预览新的目标', {
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
      await logDiagnostic(this.db, 'error', 'initial-reconcile', '已应用的方案未达成，下一轮重试', {
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
    const settled = await this.db.transaction(
      'rw',
      [this.db.bindings, this.db.pendingOps, this.db.localNodes],
      async () => {
        await this.db.bindings.update(binding.id, {
          state: 'active',
          epoch,
          appliedRevision: revision,
          receivedRevision: revision,
          lastSyncAt: Date.now(),
          recovery: null,
        });
        return this.settleAdoptedCreates(binding.id);
      },
    );
    session.state = 'COMPLETED';
    session.phase = 'done';
    session.issues = undefined;
    session.serverPhase = env.session.phase;
    await this.touch(session);
    await logDiagnostic(this.db, 'info', 'initial-reconcile', '初始对账已完成', {
      bindingId: binding.id,
      sessionId: env.session.id,
      baselineRevision: revision,
      settledCreates: settled,
    });
    return 'completed';
  }

  /**
   * Drop queued creates the committed snapshot already accounts for.
   *
   * The snapshot describes the whole mounted scope, and the steps that ran
   * before this point mapped the browser nodes it carried. A create still
   * sitting in the outbox for a node that now has a canonical id is therefore
   * not pending work — it is one bookmark expressed twice, and replaying it
   * gives the user a duplicate of something they made once. That is the shape
   * of a restore: the binding falls back to pending_initial while the outbox
   * still holds edits made before it.
   */
  private async settleAdoptedCreates(bindingId: string): Promise<number> {
    const queued = await this.db.pendingOps
      .where('bindingId')
      .equals(bindingId)
      .filter((o) => o.type === 'create' && isUnsettledOp(o))
      .toArray();
    let settled = 0;
    for (const op of queued) {
      if (!op.browserId) continue;
      const mirror = await this.db.localNodes.get([bindingId, op.browserId]);
      // An ordinary ack deletes its own op, so a mapped mirror that still has
      // one queued means the reconciliation adopted this node instead.
      if (mirror?.canonicalId) {
        await this.db.pendingOps.delete(op.opId);
        settled += 1;
      }
    }
    return settled;
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
