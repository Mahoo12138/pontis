// The point of this function is that three different failures must not render
// as the same sentence. Before it, every query error collapsed into 发生错误.

import { describe, expect, it } from 'vitest';
import { ApiError, ContractViolation } from '@pontis/api';
import { describeError } from './errors';

describe('describeError', () => {
  it('keeps the server code on a client-side rejection', () => {
    const error = new ApiError(404, 'SPACE_NOT_FOUND', 'unknown space', 'req_1');
    expect(describeError(error)).toBe('[SPACE_NOT_FOUND] unknown space');
  });

  it('names the request for a 5xx, because that is the only way to find it', () => {
    // The client only ever gets a generic "internal error" from the server; the
    // request id is what ties it to a line in the server log.
    const text = describeError(new ApiError(500, 'INTERNAL', 'internal error', 'req_7f3'));
    expect(text).toContain('req_7f3');
    expect(text).toContain('INTERNAL');
  });

  it('passes a contract violation through unchanged', () => {
    const error = new ContractViolation('body.nodes[0].position', 'a number', '0');
    expect(describeError(error)).toBe(
      'API contract violated at body.nodes[0].position: expected a number, received "0"',
    );
  });

  it('says something for a request that never arrived, and nothing for no error', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toBe('Failed to fetch');
    expect(describeError(undefined)).toBeUndefined();
    expect(describeError(null)).toBeUndefined();
    expect(describeError('a string')).toBeUndefined();
    expect(describeError(new Error(''))).toBeUndefined();
  });
});
