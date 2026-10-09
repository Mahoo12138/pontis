// Reconciliation step applier (doc 08 §13). The server owns the tree plan:
// it computed which nodes merge, which are created and which move. This
// module only drives those steps into the browser, so the extension never
// re-implements a planner (doc 08 §13).
//
// Steps are ensure-state: applying one whose result is already visible is a
// no-op. That is what makes an MV3 kill in the middle of the apply phase
// recoverable by replaying the whole list, so no "last applied step" cursor
// has to be trusted.
//
// Local identity comes from the client snapshot the plan was built on: a
// step's `local_ref` is resolved through the ref → browser id map captured
// when the snapshot was submitted, and a canonical parent through the mirror
// the earlier assign_identity/create steps wrote.

import { removeByType, type BrowserAdapter } from '../browser/types';
import {
  collectSubtree,
  findMirrorByCanonical,
  logDiagnostic,
  type ExpectedMutationRecord,
  type LocalNodeRecord,
  type PontisDB,
} from '../store/db';
import type { ApplyStepWire, NodeType, ParentRefWire } from '../protocol/types';
import { syncMirrorPositions } from './remoteChangeApplier';

/** The mount + snapshot a step list is resolved against. */
export interface StepScope {
  bindingId: string;
  /** Client snapshot local_ref → browser node id. */
  localRefs: Record<string, string>;
  /** Canonical root slot key → browser root id. */
  roots: Record<string, string>;
}

/**
 * A step whose target or parent cannot be located in the replica. Silently
 * skipping it would leave the browser at a state the server believes it
 * reached, so the caller must fail the reconciliation instead.
 */
export class StepResolutionError extends Error {
  readonly code = 'STEP_UNRESOLVED';

  constructor(
    readonly kind: 'target' | 'parent',
    readonly ref: string,
  ) {
    super(`reconciliation step targets unresolvable ${kind} "${ref}"`);
    this.name = 'StepResolutionError';
  }
}

/** Steps carry no journal revision of their own. */
const STEP_REVISION = 0;

export async function applyReconcileSteps(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  steps: ApplyStepWire[],
): Promise<void> {
  for (const step of steps) {
    await applyStep(db, adapter, scope, step);
  }
  // The steps placed nodes among their siblings; adopt the browser's order
  // as the mirrored canonical order for the whole mounted tree.
  for (const rootId of Object.values(scope.roots)) {
    await adoptBrowserOrder(db, adapter, scope.bindingId, rootId);
  }
}

async function applyStep(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  step: ApplyStepWire,
): Promise<void> {
  switch (step.kind) {
    case 'assign_identity':
      return applyAssignIdentity(db, adapter, scope, step);
    case 'create':
      return applyCreate(db, adapter, scope, step);
    case 'update':
      return applyUpdate(db, adapter, scope, step);
    case 'move':
      return applyMove(db, adapter, scope, step);
    case 'delete':
      return applyDelete(db, adapter, scope, step);
  }
}

/**
 * The browser already holds this node; the step only teaches it the
 * canonical id. No browser API call, so no expectation either.
 */
async function applyAssignIdentity(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  step: ApplyStepWire,
): Promise<void> {
  const canonicalId = step.canonical_id ?? '';
  const browserId = scope.localRefs[step.local_ref ?? ''];
  if (!browserId || !canonicalId) {
    await logDiagnostic(db, 'error', 'reconcile-steps', 'identity step without a resolvable ref', { scope, step });
    throw new StepResolutionError('target', step.local_ref ?? canonicalId);
  }
  const existing = await findMirrorByCanonical(db, scope.bindingId, canonicalId);
  if (existing?.browserId === browserId) return; // already mapped (resume)
  if (existing) {
    // Two browser nodes claiming one canonical id is not a state this
    // applier may resolve by picking one.
    await logDiagnostic(db, 'error', 'reconcile-steps', 'canonical id already mapped to another browser node', {
      canonicalId,
      mappedBrowserId: existing.browserId,
      stepBrowserId: browserId,
    });
    throw new StepResolutionError('target', canonicalId);
  }
  const node = await adapter.getNode(browserId);
  if (!node) {
    await logDiagnostic(db, 'warn', 'reconcile-steps', 'identity step for a browser node that no longer exists', {
      browserId,
      canonicalId,
    });
    return;
  }
  await db.localNodes.put({
    bindingId: scope.bindingId,
    browserId: node.id,
    canonicalId,
    type: node.type,
    title: node.title,
    url: node.url,
    parentBrowserId: node.parentId,
    position: null,
  });
}

async function applyCreate(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  step: ApplyStepWire,
): Promise<void> {
  const canonicalId = step.canonical_id ?? '';
  if (!canonicalId) throw new StepResolutionError('target', step.local_ref ?? '');
  const existing = await findMirrorByCanonical(db, scope.bindingId, canonicalId);
  if (existing) return; // the create already landed (resume)
  const parentBrowserId = await resolveParent(db, scope, step.parent);
  const index = await indexForBefore(db, adapter, scope, parentBrowserId, step.before_id ?? '', null);

  const exp: ExpectedMutationRecord = {
    bindingId: scope.bindingId,
    revision: STEP_REVISION,
    kind: 'create',
    canonicalId,
    browserId: null,
    parentBrowserId,
    position: null,
    title: step.title ?? '',
    url: step.url ?? '',
    createdAt: Date.now(),
  };
  await db.expectedMutations.add(exp);
  const created = await adapter.create(parentBrowserId, {
    title: step.title ?? '',
    url: step.type === 'bookmark' ? step.url || undefined : undefined,
    index,
  });
  await db.transaction('rw', [db.localNodes, db.expectedMutations], async () => {
    // Left for the browser's onCreated echo to consume: deleting it here would
    // make the node this reconciliation created look like user intent and get
    // uploaded back as a second copy of the same canonical node.
    await db.expectedMutations.put({ ...exp, id: exp.id, browserId: created.id });
    await db.localNodes.put({
      bindingId: scope.bindingId,
      browserId: created.id,
      canonicalId,
      type: created.type,
      title: created.title,
      url: created.url,
      parentBrowserId: created.parentId,
      position: null,
    });
  });
}

async function applyUpdate(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  step: ApplyStepWire,
): Promise<void> {
  const browserId = await resolveTargetBrowserId(db, scope, step);
  const mirror = await db.localNodes.get([scope.bindingId, browserId]);
  if (!mirror) return;
  // One field per expected mutation: the event processor matches a change
  // event on the single field the expectation carries (doc 05 §8).
  if (step.title !== undefined && step.title !== mirror.title) {
    await mutateField(db, adapter, scope, mirror, 'update_title', { title: step.title });
  }
  const url = step.url === undefined ? undefined : step.url || null;
  const refreshed = await db.localNodes.get([scope.bindingId, browserId]);
  if (url !== undefined && refreshed && url !== refreshed.url) {
    await mutateField(db, adapter, scope, refreshed, 'update_url', { url });
  }
}

async function mutateField(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  mirror: LocalNodeRecord,
  kind: 'update_title' | 'update_url',
  changes: { title?: string; url?: string | null },
): Promise<void> {
  const exp: ExpectedMutationRecord = {
    bindingId: scope.bindingId,
    revision: STEP_REVISION,
    kind,
    canonicalId: mirror.canonicalId ?? '',
    browserId: mirror.browserId,
    title: changes.title,
    url: changes.url ?? undefined,
    createdAt: Date.now(),
  };
  await db.expectedMutations.add(exp);
  await adapter.update(mirror.browserId, changes.title !== undefined ? { title: changes.title } : { url: changes.url ?? '' });
  await db.transaction('rw', [db.localNodes, db.expectedMutations], async () => {
    // The onChanged echo consumes the expectation (doc 05 §8).
    const cur = await db.localNodes.get([scope.bindingId, mirror.browserId]);
    if (cur) await db.localNodes.put({ ...cur, ...(changes.title !== undefined ? { title: changes.title } : { url: changes.url ?? null }) });
  });
}

async function applyMove(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  step: ApplyStepWire,
): Promise<void> {
  const browserId = await resolveTargetBrowserId(db, scope, step);
  const node = await adapter.getNode(browserId);
  if (!node) return;
  const parentBrowserId = await resolveParent(db, scope, step.parent);
  // Ensure-state: same parent and the sibling the step places it before is
  // still directly above it (an append means it is last).
  if (await isPlaced(db, adapter, scope, parentBrowserId, browserId, step.before_id ?? '')) return;

  const mirror = await db.localNodes.get([scope.bindingId, browserId]);
  const index = await indexForBefore(db, adapter, scope, parentBrowserId, step.before_id ?? '', browserId);
  const exp: ExpectedMutationRecord = {
    bindingId: scope.bindingId,
    revision: STEP_REVISION,
    kind: 'move',
    canonicalId: mirror?.canonicalId ?? '',
    browserId,
    parentBrowserId,
    position: null,
    createdAt: Date.now(),
  };
  await db.expectedMutations.add(exp);
  await adapter.move(browserId, parentBrowserId, index);
  await db.transaction('rw', [db.localNodes, db.expectedMutations], async () => {
    // The onMoved echo consumes the expectation.
    const cur = await db.localNodes.get([scope.bindingId, browserId]);
    if (cur) await db.localNodes.put({ ...cur, parentBrowserId });
  });
}

async function applyDelete(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  step: ApplyStepWire,
): Promise<void> {
  const browserId = await resolveTargetBrowserId(db, scope, step);
  const node = await adapter.getNode(browserId);
  if (!node) {
    // Already absent locally: drop the stale mirror subtree, nothing for the
    // browser API to delete.
    const subtree = await collectSubtree(db, scope.bindingId, browserId);
    await db.localNodes.bulkDelete(subtree.map((r) => [scope.bindingId, r.browserId] as [string, string]));
    return;
  }
  const mirror = await db.localNodes.get([scope.bindingId, browserId]);
  const exp: ExpectedMutationRecord = {
    bindingId: scope.bindingId,
    revision: STEP_REVISION,
    kind: 'delete',
    canonicalId: mirror?.canonicalId ?? step.canonical_id ?? '',
    browserId,
    createdAt: Date.now(),
  };
  await db.expectedMutations.add(exp);
  await removeByType(adapter, { id: node.id, type: node.type });
  await db.transaction('rw', [db.localNodes, db.expectedMutations], async () => {
    await db.expectedMutations.delete(exp.id!);
    const subtree = await collectSubtree(db, scope.bindingId, browserId);
    await db.localNodes.bulkDelete(subtree.map((r) => [scope.bindingId, r.browserId] as [string, string]));
  });
}

// --- resolution helpers ---

/**
 * The browser node a step acts on: the snapshot ref first (it names the
 * node the plan was computed from), the canonical mapping as the fallback
 * for a step that targets a node the client created during this session.
 */
async function resolveTargetBrowserId(
  db: PontisDB,
  scope: StepScope,
  step: ApplyStepWire,
): Promise<string> {
  const byRef = step.local_ref ? scope.localRefs[step.local_ref] : undefined;
  if (byRef) return byRef;
  if (step.canonical_id) {
    const mirror = await findMirrorByCanonical(db, scope.bindingId, step.canonical_id);
    if (mirror) return mirror.browserId;
  }
  throw new StepResolutionError('target', step.local_ref || step.canonical_id || step.kind);
}

async function resolveParent(db: PontisDB, scope: StepScope, parent?: ParentRefWire): Promise<string> {
  if (!parent) throw new StepResolutionError('parent', '');
  if (parent.type === 'root') {
    const rootId = parent.key ? scope.roots[parent.key] : undefined;
    if (!rootId) throw new StepResolutionError('parent', `root:${parent.key ?? ''}`);
    return rootId;
  }
  const mirror = await findMirrorByCanonical(db, scope.bindingId, parent.id ?? '');
  if (!mirror) throw new StepResolutionError('parent', parent.id ?? '');
  return mirror.browserId;
}

/**
 * Browser insertion index for "directly before the node with this canonical
 * id"; an empty before_id appends. The moved node is excluded because the
 * browser removes it before re-inserting at the index.
 */
async function indexForBefore(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  parentBrowserId: string,
  beforeId: string,
  movedBrowserId: string | null,
): Promise<number> {
  const children = (await adapter.getChildren(parentBrowserId)).filter((c) => c.id !== movedBrowserId);
  if (!beforeId) return children.length;
  for (const child of children) {
    const m = await db.localNodes.get([scope.bindingId, child.id]);
    if (m?.canonicalId === beforeId) return children.indexOf(child);
  }
  return children.length;
}

async function isPlaced(
  db: PontisDB,
  adapter: BrowserAdapter,
  scope: StepScope,
  parentBrowserId: string,
  browserId: string,
  beforeId: string,
): Promise<boolean> {
  const children = await adapter.getChildren(parentBrowserId);
  const at = children.findIndex((c) => c.id === browserId);
  if (at < 0) return false;
  if (!beforeId) return at === children.length - 1;
  const above = children[at - 1];
  if (!above) return false;
  const m = await db.localNodes.get([scope.bindingId, above.id]);
  return m?.canonicalId === beforeId;
}

/**
 * Walk the mounted subtree and mirror the browser's sibling order. The
 * server's positions and the browser's order agree once the steps have run;
 * re-reading them keeps later index computations honest without a per-step
 * position the protocol does not carry.
 */
async function adoptBrowserOrder(
  db: PontisDB,
  adapter: BrowserAdapter,
  bindingId: string,
  rootBrowserId: string,
): Promise<void> {
  const queue = [rootBrowserId];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    await syncMirrorPositions(db, adapter, bindingId, parent);
    for (const child of await adapter.getChildren(parent)) {
      if (child.type === 'folder') queue.push(child.id);
    }
  }
}
