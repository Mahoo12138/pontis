// Full Resync / Recovery entry (doc 06 §7, §9-§11): invoked when a
// binding sits in needs_recovery after a protocol failure.
//
//   - Unsynced local intent → protect it (emergency snapshot, doc 06 §9)
//     and wait for user review; old-epoch ops are only Recovery Intent,
//     never replayed as-is (doc 06 §10). Per-op review UI is Phase 3.
//   - No unsynced intent → Full Resync: keep the (still trusted)
//     Canonical ↔ Browser mapping, re-anchor the watermarks to the
//     server's journal floor / current epoch, and replay — ensure-state
//     idempotency converges the browser without duplicates.
//
// A pruned journal with a stale epoch cannot be re-anchored client-side;
// that stays waiting_user until the server grows a snapshot endpoint.

import type { ApiClient } from '../transport/client';
import type { BootstrapStore } from '../store/bootstrap';
import {
  emptyReconProgress,
  logDiagnostic,
  type BindingRecord,
  type PontisDB,
  type ReconSessionRecord,
} from '../store/db';
import { isQuiescent, type InitialSyncEngine } from './initialSync';
import type { SyncCoordinator } from './syncCoordinator';

const MAX_QUIESCE_ROUNDS = 64;

export type RecoveryOutcome = 'resynced' | 'waiting' | 'noop';

export class ResyncService {
  constructor(
    private db: PontisDB,
    private client: ApiClient,
    private bootstrap: BootstrapStore,
    private coordinator: SyncCoordinator,
    private engine: InitialSyncEngine,
  ) {}

  /** Idempotent: safe to call on every alarm for every stuck binding. */
  async attemptRecovery(bindingId: string): Promise<RecoveryOutcome> {
    const binding = await this.db.bindings.get(bindingId);
    if (!binding || binding.state !== 'needs_recovery') return 'noop';

    // Recovery Intent policy (doc 06 §11): new data auto-protect, stale
    // destructive intent requires explicit review (Phase 3 UI).
    const queued = await this.db.pendingOps
      .where('[bindingId+status]')
      .equals([bindingId, 'QUEUED'])
      .count();
    if (queued > 0) {
      await this.writeEmergencySnapshot(binding, 'unsynced intent pending recovery review');
      await this.db.bindings.update(bindingId, { state: 'waiting_user' });
      await this.recordSession(bindingId, {
        state: 'WAITING_USER',
        phase: 'wait_user',
        error: 'recovery intent requires review; pending ops preserved (Phase 3 UI)',
      });
      await logDiagnostic(this.db, 'warn', 'resync', 'needs_recovery with unsynced intent; waiting for user', {
        bindingId,
        queued,
      });
      return 'waiting';
    }

    await this.writeEmergencySnapshot(binding, 'full resync');
    const { deviceToken } = await this.bootstrap.get();
    if (!deviceToken) {
      await logDiagnostic(this.db, 'warn', 'resync', 'cannot resync: device token missing', { bindingId });
      return 'waiting';
    }
    const { spaces } = await this.client.deviceSpaces(deviceToken);
    const space = spaces.find((s) => s.id === binding.spaceId);
    if (!space) {
      await this.recordSession(bindingId, {
        state: 'FAILED',
        phase: 'prepare',
        error: 'space not found for resync',
      });
      return 'waiting';
    }

    // Re-anchor: fresh epoch + journal floor baseline. The mapping stays;
    // replaying the journal from the floor is a no-op for already-applied
    // nodes (ensure-state) and repairs anything that drifted.
    const baseline = Math.max(0, space.journal_floor_revision);
    await this.db.transaction(
      'rw',
      [this.db.bindings, this.db.pendingOps, this.db.expectedMutations, this.db.remoteChanges],
      async () => {
        const b = await this.db.bindings.get(bindingId);
        if (!b) return;
        b.epoch = space.epoch;
        b.appliedRevision = baseline;
        b.receivedRevision = baseline;
        b.state = 'resyncing';
        b.recovery = null;
        await this.db.bindings.put(b);
        await this.db.pendingOps.where('bindingId').equals(bindingId).delete();
        await this.db.expectedMutations.where('bindingId').equals(bindingId).delete();
        await this.db.remoteChanges.where('bindingId').equals(bindingId).delete();
      },
    );
    const session = await this.recordSession(bindingId, { state: 'RUNNING', phase: 'apply' });

    for (let i = 0; i < MAX_QUIESCE_ROUNDS; i++) {
      await this.coordinator.syncBinding(bindingId);
      if (await isQuiescent(this.db, bindingId)) break;
    }

    // Verify is mandatory before returning to ACTIVE (doc 06 §14).
    const report = await this.engine.verifyAndRepair(bindingId);
    if (!report.ok) {
      session.state = 'FAILED';
      session.error = `verify failed: ${report.problems.map((p) => p.kind).join(',')}`;
      await this.touch(session);
      await this.db.bindings.update(bindingId, {
        state: 'needs_recovery',
        recovery: { code: 'VERIFY_FAILED', message: session.error ?? 'verify failed' },
      });
      await logDiagnostic(this.db, 'error', 'resync', 'full resync verification failed', {
        bindingId,
        problems: report.problems,
      });
      return 'waiting';
    }

    session.state = 'COMPLETED';
    session.phase = 'done';
    await this.touch(session);
    await this.db.bindings.update(bindingId, { state: 'active', lastSyncAt: Date.now() });
    await logDiagnostic(this.db, 'info', 'resync', 'full resync completed', {
      bindingId,
      baseline,
      epoch: space.epoch,
    });
    return 'resynced';
  }

  // --- helpers ---

  private async writeEmergencySnapshot(binding: BindingRecord, reason: string): Promise<void> {
    const mirrors = await this.db.localNodes.where('bindingId').equals(binding.id).toArray();
    const pending = await this.db.pendingOps.where('bindingId').equals(binding.id).toArray();
    await this.db.emergencySnapshots.add({
      bindingId: binding.id,
      ts: Date.now(),
      reason,
      data: {
        mirrors,
        pending,
        epoch: binding.epoch,
        appliedRevision: binding.appliedRevision,
        receivedRevision: binding.receivedRevision,
        clientSeq: binding.clientSeq,
      },
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
