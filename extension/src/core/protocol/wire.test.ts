// Wire fixture tests (doc 21 §9): the TS protocol types must encode to
// exactly the JSON shape the Go server produces/consumes, so a drift in
// either side fails here first.

import { describe, expect, it } from 'vitest';
import type { ChangeWire, OperationWire, SyncRequestWire, SyncResponseWire } from './types';
import { SYNC_PROTOCOL_VERSION } from './types';

describe('sync protocol wire shape', () => {
  it('encodes a sync request with snake_case fields', () => {
    const op: OperationWire = {
      op_id: '018f0000-0000-7000-8000-000000000001',
      client_seq: 382,
      base_revision: 18230,
      type: 'move',
      node_id: 'n1',
      parent: { type: 'node', id: 'n2' },
      before_id: null,
    };
    const req: SyncRequestWire = {
      protocol_version: SYNC_PROTOCOL_VERSION,
      epoch: 3,
      applied_revision: 18230,
      received_revision: 18300,
      operations: [op],
      max_changes: 500,
    };
    const json = JSON.parse(JSON.stringify(req));
    expect(Object.keys(json).sort()).toEqual([
      'applied_revision',
      'epoch',
      'max_changes',
      'operations',
      'protocol_version',
      'received_revision',
    ]);
    expect(Object.keys(json.operations[0]).sort()).toEqual([
      'base_revision',
      'before_id',
      'client_seq',
      'node_id',
      'op_id',
      'parent',
      'type',
    ]);
    expect(json.operations[0].parent).toEqual({ type: 'node', id: 'n2' });
  });

  it('decodes a server-shaped sync response with journal payloads', () => {
    const raw = {
      protocol_version: 1,
      epoch: 3,
      journal_floor_revision: 12000,
      from_revision: 18301,
      through_revision: 18302,
      server_revision: 18412,
      has_more: false,
      operation_results: [
        {
          op_id: 'op-1',
          client_seq: 51,
          status: 'APPLIED',
          reason: '',
          result_revision: 18301,
          settle_after_revision: 18301,
        },
      ],
      changes: [
        {
          revision: 18301,
          type: 'create',
          node_id: 'n-new',
          payload: {
            type: 'bookmark',
            title: 'GitHub',
            url: 'https://github.com',
            parent: { type: 'root', key: 'main' },
            position: 1,
          },
        },
        {
          revision: 18302,
          type: 'move',
          node_id: 'n-old',
          payload: { parent: { type: 'node', id: 'n-parent' }, position: 0 },
        },
      ],
    } as unknown as SyncResponseWire;
    expect(raw.changes[0]!.payload).toHaveProperty('parent.key', 'main');
    const createChange: ChangeWire = raw.changes[0]!;
    expect(createChange.type).toBe('create');
    expect(raw.operation_results[0]!.status).toBe('APPLIED');
    expect(raw.operation_results[0]!.settle_after_revision).toBe(18301);
  });

  it('classifies protocol error codes', async () => {
    const { isProtocolErrorCode } = await import('./types');
    expect(isProtocolErrorCode('EPOCH_MISMATCH')).toBe(true);
    expect(isProtocolErrorCode('OPERATION_HISTORY_EXPIRED')).toBe(true);
    expect(isProtocolErrorCode('NOT_A_PROTOCOL_ERROR')).toBe(false);
  });
});
