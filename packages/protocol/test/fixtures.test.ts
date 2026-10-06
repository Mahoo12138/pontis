import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { decodeChange, decodeServerSnapshot, decodeSession, decodeSnapshotNodes, decodeSyncResponse, expectError, ProtocolError } from '../src';

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

  it('decodes error-epoch-mismatch.json into a ProtocolError', () => {
    const err = expectError(golden('error-epoch-mismatch.json'));
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err!.code).toBe('EPOCH_MISMATCH');
  });

  it('decodes server snapshot metadata and node pages', () => {
    const snap = decodeServerSnapshot({
      snapshot_id: 's1',
      epoch: 1,
      revision: 7,
      node_count: 2,
      checksum: 'abc',
      expires_at: '2026-01-01T00:00:00Z',
    });
    expect(snap.snapshot_id).toBe('s1');

    const nodes = decodeSnapshotNodes({
      nodes: [
        { node_ref: 'root:main', parent_ref: '', type: 'root', title: 'Main', root_key: 'main', position: 0 },
        { node_ref: 'n1', parent_ref: 'root:main', type: 'bookmark', title: 'X', url: 'https://x', position: 0 },
      ],
    });
    expect(nodes).toHaveLength(2);
    expect(nodes[1]!.root_key).toBeUndefined();
  });

  it('decodes a reconciliation session with issues', () => {
    const sess = decodeSession({
      id: 'r1',
      state: 'waiting_user',
      phase: 'planned',
      target_epoch: 1,
      target_revision: 4,
      commit_revision: 0,
      issues: [
        {
          id: 'i1',
          type: 'ambiguous_identity',
          payload: { source_ref: 'l1', candidates: ['t1', 't2'] },
          default_choice: '',
        },
      ],
    });
    expect(sess.issues).toHaveLength(1);
    expect(sess.issues[0]!.payload.candidates).toEqual(['t1', 't2']);
  });
});
