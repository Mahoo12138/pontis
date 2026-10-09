// The HTTP boundary must reject a malformed response before the coordinator
// can persist it: a `null` protocol array would otherwise reach a for-of loop
// and stall the binding mid-transaction.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from './client';
import { ProtocolShapeError, parseSyncResponse } from '../protocol/validate';
import type { SyncRequestWire } from '../protocol/types';

const okBody = {
  protocol_version: 1,
  epoch: 1,
  journal_floor_revision: 0,
  from_revision: 120,
  through_revision: 120,
  server_revision: 120,
  has_more: false,
  operation_results: [],
  changes: [],
};

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(status === 204 ? '' : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

const request: SyncRequestWire = {
  protocol_version: 1,
  epoch: 1,
  applied_revision: 120,
  received_revision: 120,
  operations: [],
  max_changes: 500,
};

afterEach(() => vi.unstubAllGlobals());

describe('parseSyncResponse', () => {
  it('accepts the golden empty response', () => {
    expect(parseSyncResponse(okBody).operation_results).toEqual([]);
  });

  it('rejects null where an array is required', () => {
    expect(() => parseSyncResponse({ ...okBody, operation_results: null })).toThrow(ProtocolShapeError);
    expect(() => parseSyncResponse({ ...okBody, changes: null })).toThrow(ProtocolShapeError);
  });

  it('rejects a missing or non-numeric watermark', () => {
    const { through_revision, ...rest } = okBody;
    expect(() => parseSyncResponse(rest)).toThrow(ProtocolShapeError);
    expect(() => parseSyncResponse({ ...okBody, epoch: '1' })).toThrow(ProtocolShapeError);
  });
});

describe('ApiClient.sync', () => {
  it('throws instead of returning a response whose arrays are null', async () => {
    mockFetch({ ...okBody, operation_results: null });
    const client = new ApiClient(async () => ({ serverUrl: 'http://server.test', token: 'device-token' }));
    await expect(client.sync('b1', request)).rejects.toThrow(ProtocolShapeError);
  });

  it('passes a well-formed response through untouched', async () => {
    mockFetch(okBody);
    const client = new ApiClient(async () => ({ serverUrl: 'http://server.test', token: 'device-token' }));
    const resp = await client.sync('b1', request);
    expect(resp.operation_results).toEqual([]);
    expect(resp.changes).toEqual([]);
    expect(resp.through_revision).toBe(120);
  });

  it('still normalizes error envelopes into ApiError', async () => {
    mockFetch({ error: { code: 'EPOCH_MISMATCH', message: 'epoch changed' } }, 409);
    const client = new ApiClient(async () => ({ serverUrl: 'http://server.test', token: 'device-token' }));
    await expect(client.sync('b1', request)).rejects.toMatchObject({ code: 'EPOCH_MISMATCH' });
  });
});
