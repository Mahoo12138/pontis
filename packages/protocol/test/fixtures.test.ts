import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  decodeChange,
  decodePlan,
  decodeReconciliationSession,
  decodeServerSnapshot,
  decodeSessionEnvelope,
  decodeSnapshotNodePage,
  decodeSteps,
  decodeSyncResponse,
  expectError,
  ProtocolError,
} from '../src';

const fixtureDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../fixtures/protocol');

function golden(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), 'utf8'));
}

// The golden fixtures are generated from the Go wire DTOs; the extension
// codec must accept them unchanged (doc 21 §9).
describe('golden protocol fixtures', () => {
  it('decodes sync-response-v1.json', () => {
    const resp = decodeSyncResponse(golden('sync-response-v1.json'));
    expect(resp.protocol_version).toBe(1);
    expect(resp.server_revision).toBe(130);
    expect(resp.changes).toHaveLength(2);
    expect(resp.operation_results[0]!.status).toBe('APPLIED');

    const move = decodeChange({ ...resp.changes[1] });
    expect(move.type).toBe('move');
  });

  // A remote-only pull sends no operations, so the Go handler returns both
  // protocol arrays empty. Consumers iterate them, so `null` is not accepted.
  it('decodes sync-response-empty-v1.json into iterable arrays', () => {
    const body = golden('sync-response-empty-v1.json') as Record<string, unknown>;
    expect(Array.isArray(body.operation_results)).toBe(true);
    expect(Array.isArray(body.changes)).toBe(true);

    const resp = decodeSyncResponse(body);
    expect(resp.operation_results).toEqual([]);
    expect(resp.changes).toEqual([]);

    // The consumption pattern the coordinator uses must not throw.
    for (const r of resp.operation_results) expect(r.op_id).toBeTypeOf('string');
    for (const c of resp.changes) expect(c.revision).toBeTypeOf('number');
  });

  it('decodes error-epoch-mismatch.json into a ProtocolError', () => {
    const err = expectError(golden('error-epoch-mismatch.json'));
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err!.code).toBe('EPOCH_MISMATCH');
  });

  it('decodes the reconciliation snapshots and their node pages', () => {
    const snap = decodeServerSnapshot(golden('reconcile-server-snapshot-v1.json'));
    expect(snap.snapshot_id).toBe('0198c0de-7000-7000-8000-000000000100');
    expect(snap.node_count).toBe(4);

    const page = decodeSnapshotNodePage(golden('reconcile-snapshot-nodes-v1.json'));
    expect(page.total).toBe(4);
    expect(page.nodes).toHaveLength(2);
    expect(page.next_cursor).toBe('2');
  });

  it('decodes a planned session, its issues and its plan preview', () => {
    const body = decodeSessionEnvelope(golden('reconcile-session-planned-v1.json'));
    expect(body.session.state).toBe('waiting_user');
    expect(body.session.plan_hash).toBe('6f7e8d9c0b1a2f3e4d5c6b7a8990a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2');
    expect(body.issues[0]!.payload.candidates).toHaveLength(2);
    expect(body.plan!.stats.creates).toBe(1);
    expect(body.plan!.warnings).toEqual([]);
  });

  it('decodes the steps and the binding a completed session leaves behind', () => {
    const steps = decodeSteps(golden('reconcile-steps-v1.json'));
    expect(steps.steps.map((s) => s.kind)).toEqual(['assign_identity', 'create']);

    const done = decodeSessionEnvelope(golden('reconcile-session-completed-v1.json'));
    expect(done.session.commit_revision).toBe(121);
    expect(done.issues).toEqual([]);
    expect(done.binding!.state).toBe('active');
  });

  it('keeps a session answer that is not the envelope shape an error', () => {
    // The lifecycle never returns a bare session object; reading one would
    // silently produce an id-less session, so the decoder refuses it.
    expect(() => decodeReconciliationSession({ id: 'r1' })).toThrow();
    expect(() => decodePlan({ plan_hash: 'h' })).toThrow();
  });
});
