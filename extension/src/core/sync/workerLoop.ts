// The worker loop (doc 05 §14/§15): what a sync trigger actually does.
//
// The MV3 entrypoint is wiring — chrome.* events in, messages out. The part
// that has to be ordered when an alarm, a manual click, a worker wake and a
// recovery attempt land on the same binding lives here, because a trigger
// sequence that only exists inside defineBackground() cannot be tested at all:
// PR-B1 asks for "no two rounds replaying one inbox", and that guarantee is
// assembled from these three steps, not from any single one of them.

import { integrityCheck, type IntegrityResult } from './integrity';
import { EventProcessor } from './eventProcessor';
import type { BrowserAdapter, BrowserEvent } from '../browser/types';
import { logDiagnostic, type PontisDB } from '../store/db';
import type { ReplicaVerifier } from './verifyReplica';
import type { ResyncService } from './resync';
import type { SyncCoordinator } from './syncCoordinator';

/** Debounce for a burst of browser events (doc 05 §15). */
const SYNC_DEBOUNCE_MS = 1500;

/**
 * The reconciler's two entry points, named as a seam so the loop can be tested
 * without standing up a whole fake server session machine. The real
 * InitialReconciler satisfies it.
 */
export interface ReconcileDriver {
  runBinding(bindingId: string): Promise<unknown>;
  recoverMapping(bindingId: string): Promise<unknown>;
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
        .anyOf(['pending_initial', 'initializing'])
        .toArray();
      for (const b of pending) {
        try {
          await reconciler.runBinding(b.id);
        } catch (err) {
          await logDiagnostic(db, 'warn', 'background', 'initial reconciliation round failed', {
            bindingId: b.id,
            error: String(err),
          });
        }
      }

      await coordinator.syncAll();

      const stuck = await db.bindings.where('state').equals('needs_recovery').toArray();
      for (const b of stuck) {
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
   * Capture a browser event (doc 05 §13). A round of reconciliation keeps
   * processing so user intent formed during it is not lost; a local op it
   * produces schedules the next sync rather than firing one per keystroke.
   */
  dispatch(event: BrowserEvent): Promise<void> {
    const { db, adapter } = this.deps;
    this.eventsSettled = this.eventsSettled
      .then(async () => {
        const bindings = await db.bindings.where('state').anyOf(['active', 'initializing']).toArray();
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
