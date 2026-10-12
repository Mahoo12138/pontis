// The worker loop (doc 05 §14/§15): what a sync trigger actually does.
//
// The MV3 entrypoint is wiring — chrome.* events in, messages out. The part
// that has to be ordered when an alarm, a manual click, a worker wake and a
// recovery attempt land on the same binding lives here, because a trigger
// sequence that only exists inside defineBackground() cannot be tested at all:
// PR-B1 asks for "no two rounds replaying one inbox", and that guarantee is
// assembled from these three steps, not from any single one of them.

import { integrityCheck, type IntegrityResult } from './integrity';
import { capturesBindingEvents, EventProcessor } from './eventProcessor';
import type { BrowserAdapter, BrowserEvent } from '../browser/types';
import { isSyncEnabled, logDiagnostic, type PontisDB } from '../store/db';
import type { ReplicaVerifier } from './verifyReplica';
import type { ResyncService } from './resync';
import type { SyncCoordinator } from './syncCoordinator';

/** Debounce for a burst of browser events (doc 05 §15). */
const SYNC_DEBOUNCE_MS = 1500;
/** How long a round waits its turn when another holder is still inside it. */
const BUSY_RETRY_MS = 3000;

/**
 * The reconciler's two entry points, named as a seam so the loop can be tested
 * without standing up a whole fake server session machine. The real
 * InitialReconciler satisfies it.
 */
export interface ReconcileDriver {
  runBinding(bindingId: string): Promise<unknown>;
  recoverMapping(bindingId: string): Promise<unknown>;
  /**
   * Pick up a session the trigger ordering can otherwise strand: a worker
   * killed between "the binding is driving a reconciliation" and "the
   * reconciliation was resumed". It resumes the open session and never starts
   * one, so it stays idempotent however often a trigger lands.
   */
  resumeRecovery(bindingId: string): Promise<unknown>;
}

export interface WorkerDeps {
  db: PontisDB;
  adapter: BrowserAdapter;
  coordinator: SyncCoordinator;
  reconciler: ReconcileDriver;
  resync: ResyncService;
  verifier: ReplicaVerifier;
}

export class WorkerLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Event handling is serialized so per-binding transactions stay ordered,
   * while the adapter listener itself never waits. Tests await this chain.
   */
  eventsSettled: Promise<void> = Promise.resolve();

  constructor(private deps: WorkerDeps) {}

  /**
   * One pass over everything the worker knows to be behind.
   *
   * Order matters: a pending binding has no mapping yet, so the incremental
   * loop must not touch it — the server-driven reconciliation is the only
   * thing that makes it active (doc 08 §11). Recovery runs last and is
   * idempotent, so a stuck binding is retried on every trigger (doc 06 §7).
   */
  async runSync(trigger: string): Promise<void> {
    const { db, coordinator, reconciler, resync } = this.deps;
    try {
      const pending = await db.bindings
        .where('state')
        .anyOf(['pending_initial', 'initializing', 'resyncing'])
        .toArray();
      for (const b of pending) {
        if (!isSyncEnabled(b)) continue;
        try {
          await reconciler.runBinding(b.id);
        } catch (err) {
          await logDiagnostic(db, 'warn', 'background', 'reconciliation round failed', {
            bindingId: b.id,
            error: String(err),
          });
        }
      }

      // A binding parked by a failure can still hold the session that was
      // running when it failed — a mapping recovery interrupted by a worker
      // kill, or a resync that stopped answering. Nothing else in this sequence
      // picks those up: the round gate wants an active binding, the recovery
      // entry wants needs_recovery, and the lifecycle was already started. So
      // the session would sit open, blocking every later reconciliation on the
      // binding while its steps went unfinished.
      const stalled = await db.bindings.where('state').anyOf(['needs_recovery', 'mount_missing']).toArray();
      for (const b of stalled) {
        if (!isSyncEnabled(b)) continue;
        try {
          await reconciler.resumeRecovery(b.id);
        } catch (err) {
          await logDiagnostic(db, 'warn', 'background', 'interrupted reconciliation not resumed', {
            bindingId: b.id,
            error: String(err),
          });
        }
      }

      // A binding that lost the lock still wants this round: the change it
      // would have pulled is already on the server. Without a retry the next
      // chance is the periodic alarm, which is minutes away.
      if (await coordinator.syncAll()) this.scheduleSync(BUSY_RETRY_MS);

      const stuck = await db.bindings.where('state').equals('needs_recovery').toArray();
      for (const b of stuck) {
        if (!isSyncEnabled(b)) continue;
        try {
          await resync.attemptRecovery(b.id);
        } catch (err) {
          await logDiagnostic(db, 'warn', 'background', 'recovery attempt failed', {
            bindingId: b.id,
            error: String(err),
          });
        }
      }
    } catch (err) {
      await logDiagnostic(db, 'error', 'background', `sync (${trigger}) crashed`, { error: String(err) });
    }
  }

  /** Periodic drift scan (doc 05 §14). */
  async runIntegrity(trigger: string): Promise<void> {
    const { db } = this.deps;
    const actives = await db.bindings.where('state').equals('active').toArray();
    for (const b of actives) {
      // Off means off: no scan, no repair, nothing handed to the server. The
      // switch-back runs the same scan explicitly.
      if (!isSyncEnabled(b)) continue;
      try {
        await this.integrityFor(b.id);
      } catch (err) {
        await logDiagnostic(db, 'warn', 'background', `integrity check (${trigger}) failed`, {
          bindingId: b.id,
          error: String(err),
        });
      }
    }
  }

  /**
   * Scan one binding, and hand it to the server when the mapping itself is
   * what failed. Shared by the periodic scan and the on-demand message so the
   * two cannot drift apart on the recovery half.
   */
  integrityFor(bindingId: string): Promise<IntegrityResult> {
    const { db, verifier, reconciler } = this.deps;
    return integrityCheck(db, verifier, bindingId).then(async (result) => {
      // Mapping loss is not something a device may repair by guessing: the
      // server re-matches the tree it is handed (doc 06 §12).
      if (result === 'mapping_lost') await reconciler.recoverMapping(bindingId);
      return result;
    });
  }

  scheduleSync(delayMs = SYNC_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSync('debounce');
    }, delayMs);
  }

  /**
   * Capture a browser event (doc 05 §13). Nothing that pauses what a device
   * *sends* pauses what a person does: a move made while a recovery is running
   * has to be recorded, because no later scan can tell it ever happened. The
   * op it produces waits for the new baseline like any other intent.
   */
  dispatch(event: BrowserEvent): Promise<void> {
    const { db, adapter } = this.deps;
    this.eventsSettled = this.eventsSettled
      .then(async () => {
        const bindings = await db.bindings.filter((b) => capturesBindingEvents(b.state)).toArray();
        let producedLocalOp = false;
        for (const b of bindings) {
          const disposition = await new EventProcessor(db, adapter).handleEvent(b.id, event);
          if (disposition === 'local-op') producedLocalOp = true;
        }
        if (producedLocalOp) this.scheduleSync();
      })
      .catch(async (err) => {
        await logDiagnostic(db, 'error', 'background', 'event dispatch failed', { error: String(err), event });
      });
    return this.eventsSettled;
  }
}
