// Periodic integrity check (doc 05 §14): on startup, daily, and on
// demand. A read-only scan classifies the drift first:
//   - none              → nothing to do
//   - minor (missing mirrors ≤30% of the managed scope) → targeted
//     repair ops via verifyAndRepair (PROCESS_DEFERRED_LOCAL_CHANGES,
//     doc 06 §13)
//   - major (>30%)      → the mapping itself is untrustworthy: report it and
//     let the driver start a server-side recovery.
//
// This module detects; it no longer reconciles. Rewinding the watermarks by
// hand so the client planner could replay the whole journal was the old way of
// "finding the canonical state again"; under the server engine the recovery is
// planned against a frozen snapshot and hands back the baseline it matched at,
// so there is nothing to rewind (doc 06 §12).

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
      'mapping loss exceeds threshold; a recovery reconciliation is needed',
      { bindingId, missing, scope, ratio },
    );
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
