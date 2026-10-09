// Runtime validation for protocol responses. `json as T` only silences the
// type checker, so a server that sends `operation_results: null` would reach
// a for-of loop undetected. Validate at the HTTP boundary instead.

import type {
  ReconciliationEnvelopeWire,
  ServerSnapshotPageWire,
  ServerSnapshotWire,
  SnapshotWire,
  StepsWire,
  SyncResponseWire,
} from './types';

export class ProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolShapeError';
  }
}

function requireArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new ProtocolShapeError(`sync response field "${field}" must be an array, got ${JSON.stringify(value)}`);
  }
}

function requireNumber(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolShapeError(`sync response field "${field}" must be a number, got ${JSON.stringify(value)}`);
  }
}

/**
 * Assert a parsed /sync body is consumable. Throws before any watermark can
 * advance, so a malformed round cannot half-apply.
 */
export function parseSyncResponse(json: unknown): SyncResponseWire {
  if (json == null || typeof json !== 'object') {
    throw new ProtocolShapeError(`sync response must be an object, got ${JSON.stringify(json)}`);
  }
  const resp = json as Record<string, unknown>;
  requireNumber(resp.protocol_version, 'protocol_version');
  requireNumber(resp.epoch, 'epoch');
  requireNumber(resp.from_revision, 'from_revision');
  requireNumber(resp.through_revision, 'through_revision');
  requireNumber(resp.server_revision, 'server_revision');
  if (typeof resp.has_more !== 'boolean') {
    throw new ProtocolShapeError(`sync response field "has_more" must be a boolean`);
  }
  requireArray(resp.operation_results, 'operation_results');
  requireArray(resp.changes, 'changes');
  for (const c of resp.changes as unknown[]) {
    if (c == null || typeof c !== 'object') {
      throw new ProtocolShapeError('sync response contains a non-object change');
    }
  }
  return json as SyncResponseWire;
}

/** Assert a parsed snapshot body carries a node array. */
export function parseSnapshotResponse(json: unknown): SnapshotWire {
  if (json == null || typeof json !== 'object') {
    throw new ProtocolShapeError(`snapshot response must be an object, got ${JSON.stringify(json)}`);
  }
  const resp = json as Record<string, unknown>;
  requireNumber(resp.epoch, 'epoch');
  requireNumber(resp.snapshot_revision, 'snapshot_revision');
  if (!Array.isArray(resp.nodes)) {
    throw new ProtocolShapeError(`snapshot response field "nodes" must be an array`);
  }
  return json as SnapshotWire;
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new ProtocolShapeError(`field "${field}" must be a string, got ${JSON.stringify(value)}`);
  }
}

/** A field the server may leave out entirely: checked only when present. */
function optionalString(value: unknown, field: string): void {
  if (value !== undefined) requireString(value, field);
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    throw new ProtocolShapeError(`field "${field}" must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Assert a lifecycle answer carries the session and an iterable issue list.
 * The engine resumes on `session.phase`, so a body without a session cannot
 * be trusted to place a crash-resumed reconciliation.
 */
export function parseReconciliationEnvelope(json: unknown): ReconciliationEnvelopeWire {
  const body = objectAt(json, 'reconciliation response');
  const session = objectAt(body.session, 'session');
  requireString(session.id, 'session.id');
  requireString(session.state, 'session.state');
  // A terminal session reports no phase (doc 08 §11); the client branches on
  // state first, so an absent phase is a valid answer, a wrong type is not.
  optionalString(session.phase, 'session.phase');
  requireNumber(session.commit_revision, 'session.commit_revision');
  requireArray(body.issues, 'issues');
  for (const raw of body.issues as unknown[]) {
    const issue = objectAt(raw, 'issue');
    requireString(issue.id, 'issue.id');
    const payload = objectAt(issue.payload, 'issue.payload');
    requireString(payload.source_ref, 'issue.payload.source_ref');
    requireArray(payload.candidates, 'issue.payload.candidates');
  }
  if (body.plan !== undefined) {
    const plan = objectAt(body.plan, 'plan');
    requireString(plan.plan_hash, 'plan.plan_hash');
    requireNumber(objectAt(plan.stats, 'plan.stats').creates, 'plan.stats.creates');
    requireArray(plan.warnings, 'plan.warnings');
  }
  return json as ReconciliationEnvelopeWire;
}

/** Assert the apply-step list is iterable and every step is named. */
export function parseSteps(json: unknown): StepsWire {
  const body = objectAt(json, 'steps response');
  requireString(body.plan_hash, 'plan_hash');
  requireArray(body.steps, 'steps');
  for (const raw of body.steps as unknown[]) {
    const step = objectAt(raw, 'step');
    requireString(step.kind, 'step.kind');
  }
  return json as StepsWire;
}

/** Assert a frozen snapshot's metadata, and page by page its rows. */
export function parseServerSnapshot(json: unknown): ServerSnapshotWire {
  const body = objectAt(json, 'server snapshot');
  requireString(body.snapshot_id, 'snapshot_id');
  requireNumber(body.node_count, 'node_count');
  requireString(body.checksum, 'checksum');
  return json as ServerSnapshotWire;
}

/**
 * A page is only finished when the cursor comes back empty, so the paging
 * loop needs `next_cursor` present: a body that omits it entirely cannot be
 * told apart from the last page.
 */
export function parseServerSnapshotPage(json: unknown): ServerSnapshotPageWire {
  const body = objectAt(json, 'server snapshot page');
  requireNumber(body.total, 'total');
  requireString(body.next_cursor, 'next_cursor');
  requireArray(body.nodes, 'nodes');
  for (const raw of body.nodes as unknown[]) {
    const node = objectAt(raw, 'node');
    requireString(node.node_ref, 'node_ref');
    requireString(node.type, 'type');
  }
  return json as ServerSnapshotPageWire;
}
