// Periodic integrity check (doc 05 §14): on startup, daily, and on
// demand. A read-only scan classifies the drift first:
//   - none              → nothing to do
//   - minor (missing mirrors ≤30% of the managed scope) → targeted
//     repair ops via verifyAndRepair (PROCESS_DEFERRED_LOCAL_CHANGES,
//     doc 06 §13)
//   - major (>30%)      → the mapping itself is untrustworthy; hand the
//     binding to MAPPING_LOST reconciliation instead of mass-CREATEing.

import { logDiagnostic, type PontisDB } from '../store/db';
import { type InitialSyncEngine, type VerifyReport } from './initialSync';

export type IntegrityResult = 'ok' | 'repaired' | 'mapping_lost' | 'failed';

/** Missing-mirror ratio above which the mapping counts as lost. */
export const MAPPING_LOST_THRESHOLD = 0.3;

const serious = (r: VerifyReport) => r.problems.filter((p) => p.kind !== 'order_drift');

export async function integrityCheck(
  db: PontisDB,
  engine: InitialSyncEngine,
  bindingId: string,
): Promise<IntegrityResult> {
  const pre = await engine.verifyScan(bindingId);
  const missing = pre.problems.filter((p) => p.kind === 'missing_mirror').length;
  const scope = await db.localNodes.where('bindingId').equals(bindingId).count();
  const ratio = scope > 0 ? missing / scope : missing > 0 ? 1 : 0;

  if (serious(pre).length === 0) {
    await logDiagnostic(db, 'debug', 'integrity', 'integrity check passed', { bindingId, scope });
    return 'ok';
  }

  if (ratio > MAPPING_LOST_THRESHOLD) {
    await logDiagnostic(
      db,
      'warn',
      'integrity',
      'mapping loss exceeds threshold; entering MAPPING_LOST reconciliation',
      { bindingId, missing, scope, ratio },
    );
    // Rewind the watermarks so the reconciliation sees the FULL canonical
    // state (journal replay from zero, or the server snapshot when the
    // journal was pruned) — not just the post-watermark increment.
    await db.bindings.update(bindingId, { appliedRevision: 0, receivedRevision: 0 });
    await engine.start(bindingId, 'MAPPING_LOST');
    return 'mapping_lost';
  }

  // Minor drift: targeted repair ops, then re-verify (doc 06 §13).
  const post = await engine.verifyAndRepair(bindingId);
  const repaired = serious(post).length === 0;
  await logDiagnostic(
    db,
    repaired ? 'info' : 'error',
    'integrity',
    repaired ? 'minor drift repaired' : 'repair verification failed',
    { bindingId, pre: pre.problems, post: post.problems },
  );
  return repaired ? 'repaired' : 'failed';
}
