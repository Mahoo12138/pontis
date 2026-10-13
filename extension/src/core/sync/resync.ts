// Full Resync / Recovery entry (doc 06 §7, §9-§11): invoked when a
// binding sits in needs_recovery after a protocol failure.
//
//   - Unsynced local intent → protect it (emergency snapshot, doc 06 §9)
//     and wait for user review; old-epoch ops are only Recovery Intent,
//     never replayed as-is (doc 06 §10). resolveIntents() executes the
//     per-op review: apply → a brand-new op against the current baseline.
//   - No unsynced intent (or intents already reviewed) → Full Resync: keep
//     the (still trusted) Canonical ↔ Browser mapping and converge the
//     browser onto the server's whole canonical projection, then take that
//     projection's revision as the new baseline (doc 06 §7/§8).
//
// The projection comes from the server as a reconciliation, not from the
// journal. Re-anchoring the watermarks to the journal floor instead — the way
// this used to work — silently accepts the retained history as the whole tree:
// a node whose CREATE was garbage collected is in no page the client will ever
// be served again, and a scan of browser-vs-mirror cannot see what neither
// holds. So the missing bookmark stayed missing, and recovery still reported
// success.

import { uuidv7 } from '../util/ids';
import type { BootstrapStore } from '../store/bootstrap';
import {
  activeReconSession,
  emptyReconProgress,
  isUnsettledOp,
  logDiagnostic,
  writeEmergencySnapshot,
  type PontisDB,
  type ReconSessionRecord,
} from '../store/db';
import type { ReplicaVerifier } from './verifyReplica';

/** The part of the reconciliation engine a full resync drives. */
export interface FullResyncDriver {
  resyncFromServer(bindingId: string): Promise<'waiting_user' | 'completed' | 'idle'>;
}

/** One user decision from the intent review UI (doc 06 §11). */
export interface IntentDecision {
  opId: string;
  decision: 'apply' | 'discard';
}

export type RecoveryOutcome = 'resynced' | 'waiting' | 'noop';

export class ResyncService {
  constructor(
    private db: PontisDB,
    private bootstrap: BootstrapStore,
    private reconciler: FullResyncDriver,
    private verifier: ReplicaVerifier,
  ) {}

  /** Idempotent: safe to call on every alarm for every stuck binding. */
  async attemptRecovery(bindingId: string): Promise<RecoveryOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || binding.state !== 'needs_recovery') return 'noop';

    // Recovery Intent policy (doc 06 §11): new data auto-protect, stale
    // destructive intent requires explicit review. Once the review is
    // done (resolveIntents), the re-created ops converge through resync.
    const session = await activeReconSession(this.db, bindingId);
    if (session?.intentReviewed) {
      return this.runFullResync(bindingId, true);
    }

    // Anything the server has not answered for is still the user's unsent
    // intent, whether it ever left the device or not (doc 06 §11).
    const queued = await this.db.pendingOps
      .where('bindingId')
      .equals(bindingId)
      .filter(isUnsettledOp)
      .count();
    if (queued > 0) {
      await writeEmergencySnapshot(this.db, binding, 'unsynced intent pending recovery review');
      await this.db.bindings.update(bindingId, { state: 'waiting_user' });
      await this.recordSession(bindingId, {
        state: 'WAITING_USER',
        phase: 'wait_user',
        error: 'recovery intent requires review; pending ops preserved',
      });
      await logDiagnostic(this.db, 'warn', 'resync', '处于待恢复且有未同步意图，等待用户处理', {
        bindingId,
        queued,
      });
      return 'waiting';
    }

    return this.runFullResync(bindingId, false);
  }

  /**
   * Execute the intent review decisions (doc 06 §10/§11): every kept
   * intent becomes a brand-new pending op (fresh op_id / client_seq) — the
   * old op is never replayed as-is. Then the binding returns to
   * needs_recovery and the normal resync path converges it.
   */
  async resolveIntents(bindingId: string, decisions: IntentDecision[]): Promise<RecoveryOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || binding.state !== 'waiting_user') {
      throw new Error('resolveIntents: binding is not waiting for user review');
    }
    const session = await activeReconSession(this.db, bindingId);
    if (!session || session.type !== 'FULL_RESYNC' || session.state !== 'WAITING_USER') {
      throw new Error('resolveIntents: no intent review session is active');
    }

    const oldOps = await this.db.pendingOps.where('bindingId').equals(bindingId).toArray();
    const byId = new Map(oldOps.map((o) => [o.opId, o]));
    let applied = 0;
    let discarded = 0;

    await this.db.transaction('rw', [this.db.bindings, this.db.pendingOps], async () => {
      const b = await this.db.bindings.get(bindingId);
      if (!b) return;
      await this.db.pendingOps.where('bindingId').equals(bindingId).delete();
      for (const d of decisions) {
        const old = byId.get(d.opId);
        if (!old) continue;
        if (d.decision !== 'apply') {
          discarded += 1;
          continue;
        }
        applied += 1;
        b.clientSeq += 1;
        await this.db.pendingOps.add({
          opId: uuidv7(),
          bindingId,
          clientSeq: b.clientSeq,
          // Re-based to the new baseline once the resync has one (below).
          baseRevision: 0,
          status: 'QUEUED',
          type: old.type,
          nodeId: old.nodeId,
          nodeType: old.nodeType,
          title: old.title,
          url: old.url,
          parent: old.parent,
          beforeId: old.beforeId,
          browserId: old.browserId,
          createdAt: Date.now(),
        });
      }
      b.state = 'needs_recovery';
      b.recovery = null;
      await this.db.bindings.put(b);
    });

    // Reviewed: attemptRecovery may now bypass the intent guard.
    session.intentReviewed = true;
    session.state = 'RUNNING';
    session.phase = 'commit';
    session.error = undefined;
    await this.touch(session);
    await logDiagnostic(this.db, 'info', 'resync', '恢复意图已全部落定', {
      bindingId,
      applied,
      discarded,
    });

    return this.attemptRecovery(bindingId);
  }

  private async runFullResync(bindingId: string, keepIntent: boolean): Promise<RecoveryOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding) return 'noop';

    await writeEmergencySnapshot(this.db, binding, keepIntent ? 'resync after intent review' : 'full resync');
    const { deviceToken } = await this.bootstrap.get();
    if (!deviceToken) {
      await logDiagnostic(this.db, 'warn', 'resync', '无法重新同步：缺少设备令牌', { bindingId });
      return 'waiting';
    }

    // Close the stale review session so exactly one active session remains.
    // A lifecycle session is not stale: it is the same resync, and a worker
    // that came back mid-flight is meant to resume it.
    const stale = await activeReconSession(this.db, bindingId);
    if (stale && stale.driver !== 'server') {
      stale.state = 'COMPLETED';
      stale.phase = 'done';
      await this.touch(stale);
    }

    let outcome: 'waiting_user' | 'completed' | 'idle';
    try {
      outcome = await this.reconciler.resyncFromServer(bindingId);
    } catch (err) {
      await this.db.bindings.update(bindingId, {
        state: 'needs_recovery',
        recovery: { code: 'RESYNC_FAILED', message: String(err) },
      });
      await logDiagnostic(this.db, 'warn', 'resync', '完全重新同步失败，稍后重试', {
        bindingId,
        error: String(err),
      });
      return 'waiting';
    }
    // The server wants an answer before it commits anything (the binding is
    // parked at waiting_user by the lifecycle itself), or the baseline moved
    // out from under us and a first reconciliation is now owed.
    if (outcome !== 'completed') return 'waiting';

    // Reviewed intents are fresh ops against the *new* baseline (doc 06 §10):
    // one they were written against no longer exists.
    if (keepIntent) await this.rebaseIntents(bindingId);

    // Verify is mandatory before returning to ACTIVE (doc 06 §14).
    const report = await this.verifier.verifyAndRepair(bindingId);
    if (!report.ok) {
      await this.db.bindings.update(bindingId, {
        state: 'needs_recovery',
        recovery: { code: 'VERIFY_FAILED', message: report.problems.map((p) => p.kind).join(',') },
      });
      await logDiagnostic(this.db, 'error', 'resync', '完全重新同步校验失败', {
        bindingId,
        problems: report.problems,
      });
      return 'waiting';
    }

    const settled = await this.db.bindings.get(bindingId);
    await this.db.emergencySnapshots.where('bindingId').equals(bindingId).delete();
    await logDiagnostic(this.db, 'info', 'resync', '已按服务端快照完成完全重新同步', {
      bindingId,
      epoch: settled?.epoch ?? null,
      baselineRevision: settled?.appliedRevision ?? null,
    });
    return 'resynced';
  }

  // --- helpers ---

  /**
   * Stamp every unsent intent with the baseline the resync just adopted. An
   * op left at the old revision reads as an expired request the moment the
   * server sees it (doc 04 §12).
   */
  private async rebaseIntents(bindingId: string): Promise<void> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding) return;
    await this.db.transaction('rw', [this.db.pendingOps], async () => {
      const queued = await this.db.pendingOps
        .where('[bindingId+status]')
        .equals([bindingId, 'QUEUED'])
        .toArray();
      for (const op of queued) {
        op.baseRevision = binding.appliedRevision;
        await this.db.pendingOps.put(op);
      }
    });
  }

  private async recordSession(
    bindingId: string,
    patch: { state: ReconSessionRecord['state']; phase: ReconSessionRecord['phase']; error?: string },
  ): Promise<ReconSessionRecord> {
    const session: ReconSessionRecord = {
      id: `${bindingId}:resync:${Date.now()}`,
      bindingId,
      type: 'FULL_RESYNC',
      state: patch.state,
      phase: patch.phase,
      journalFloor: 0,
      serverRevision: 0,
      progress: emptyReconProgress(),
      error: patch.error,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.db.reconSessions.put(session);
    return session;
  }

  private async touch(session: ReconSessionRecord): Promise<void> {
    session.updatedAt = Date.now();
    await this.db.reconSessions.put(session);
  }
}
