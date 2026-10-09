// Runtime validation for protocol responses. `json as T` only silences the
// type checker, so a server that sends `operation_results: null` would reach
// a for-of loop undetected. Validate at the HTTP boundary instead.

import type { SnapshotWire, SyncResponseWire } from './types';

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
