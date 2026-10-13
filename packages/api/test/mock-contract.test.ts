// The mock is a second producer of the same bodies. Nothing read the ten JSON
// files it used to ship — they were dead weight that only looked authoritative —
// so what is left here is the smaller, real question: does the mock answer with
// the shape the Go server answers with? A mock that drops or invents a field
// makes a screen look correct while the backend disagrees, which is the same
// failure the golden fixtures exist to catch.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mockMeta, mockLogin, mockStatus, mockUser } from '../src/mock/handlers';
import {
  checkAcknowledged,
  checkErrorEnvelope,
  checkLogin,
  checkMeta,
  checkSystemStatus,
  checkUser,
} from '../src/contract';

const fixtureDir = fileURLToPath(new URL('../../../fixtures/api/', import.meta.url));

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${fixtureDir}${name}.json`, 'utf8')) as Record<string, unknown>;
}

describe('the mock satisfies the client contract', () => {
  it('answers /meta with what the server answers', () => {
    expect(() => checkMeta(mockMeta, 'body')).not.toThrow();
  });

  it('answers /system/status with the public projection', () => {
    expect(() => checkSystemStatus(mockStatus, 'body')).not.toThrow();
  });

  it('answers /auth/me with a real user view', () => {
    expect(() => checkUser(mockUser('admin'), 'body')).not.toThrow();
  });

  it('answers /auth/login with a token, a lifetime and a user', () => {
    expect(() => checkLogin(mockLogin('admin', Date.now()), 'body')).not.toThrow();
  });

  it('answers logout and the unauthenticated rejection in the known shapes', () => {
    expect(() => checkAcknowledged({ status: 'ok' }, 'body')).not.toThrow();
    expect(() =>
      checkErrorEnvelope(
        { error: { code: 'UNAUTHENTICATED', message: 'not logged in', request_id: 'req_mock' } },
        'body',
      ),
    ).not.toThrow();
  });
});

describe('the mock does not drift from the golden bodies', () => {
  // Same keys, not just compatible values: a mock that quietly omits a field
  // the server sends lets a component be written against a shape nobody serves,
  // and it only breaks when someone points the same page at the real backend.
  const sameKeys = (mock: object, fixture: string, path: string[]) => {
    let node: unknown = load(fixture);
    for (const key of path) node = (node as Record<string, unknown>)[key];
    expect(Object.keys(mock).sort()).toEqual(Object.keys(node as object).sort());
  };

  it('describes the same instance fields', () => sameKeys(mockMeta, 'meta', []));
  it('describes the same instance state', () => sameKeys(mockStatus, 'system-status', []));
  it('describes the same user fields', () => sameKeys(mockUser('admin'), 'me', []));
  it('describes the same login fields', () => sameKeys(mockLogin('admin', 0), 'login', []));
});
