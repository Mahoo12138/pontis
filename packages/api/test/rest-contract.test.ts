// The "API contract" row of the acceptance matrix: bodies the Go server really
// emitted (fixtures/api, written by
// `go test ./internal/httpapi -run TestGoldenRESTFixtures -update-rest-fixtures`)
// are fed through the same runtime checkers the browser client uses. An `as T`
// cast cannot fail here; these can, in both directions — the server changing a
// shape, and a declaration drifting away from its validator.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkActivityList,
  checkApiTokenList,
  checkBackupList,
  checkBindingList,
  checkDeviceOverviewResponse,
  checkDuplicates,
  checkErrorEnvelope,
  checkJobList,
  checkLinkCheckResults,
  checkMeta,
  checkNodeList,
  checkRootSlotList,
  checkScheduleList,
  checkSpaceList,
  checkTaskList,
  checkUser,
} from '../src/contract';
import { ContractViolation } from '../src/validate';
import type { ErrorEnvelope } from '../src/errors';
import type {
  ActivityListResponse,
  ApiTokenListResponse,
  BackupListResponse,
  BindingListResponse,
  DeviceOverviewResponse,
  DuplicatesResponse,
  JobListResponse,
  LinkCheckResultsResponse,
  MetaResponse,
  Node,
  NodeListResponse,
  RootSlotListResponse,
  SpaceListResponse,
  TaskListResponse,
  User,
} from '../src/types';

const fixtureDir = fileURLToPath(new URL('../../../fixtures/api/', import.meta.url));

function load(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDir}${name}.json`, 'utf8'));
}

// One golden body per checker. The declared type appears twice on purpose: as
// the returned annotation and as what the checker produces, so a schema that no
// longer matches ./types fails `tsc` before it ever fails here.
const contract = {
  meta: (v: unknown): MetaResponse => checkMeta(v, 'body'),
  me: (v: unknown): User => checkUser(v, 'body'),
  spaces: (v: unknown): SpaceListResponse => checkSpaceList(v, 'body'),
  nodes: (v: unknown): NodeListResponse => checkNodeList(v, 'body'),
  'nodes-empty': (v: unknown): NodeListResponse => checkNodeList(v, 'body'),
  'root-slots': (v: unknown): RootSlotListResponse => checkRootSlotList(v, 'body'),
  activity: (v: unknown): ActivityListResponse => checkActivityList(v, 'body'),
  'device-overview': (v: unknown): DeviceOverviewResponse => checkDeviceOverviewResponse(v, 'body'),
  bindings: (v: unknown): BindingListResponse => checkBindingList(v, 'body'),
  tokens: (v: unknown): ApiTokenListResponse => checkApiTokenList(v, 'body'),
  backups: (v: unknown): BackupListResponse => checkBackupList(v, 'body'),
  jobs: (v: unknown): JobListResponse => checkJobList(v, 'body'),
  tasks: (v: unknown): TaskListResponse => checkTaskList(v, 'body'),
  schedules: (v: unknown): { schedules: TaskListResponse['schedules'] } =>
    checkScheduleList(v, 'body'),
  'link-check-results': (v: unknown): LinkCheckResultsResponse =>
    checkLinkCheckResults(v, 'body'),
  duplicates: (v: unknown): DuplicatesResponse => checkDuplicates(v, 'body'),
  'error-validation': (v: unknown): ErrorEnvelope => checkErrorEnvelope(v, 'body'),
  'error-not-found': (v: unknown): ErrorEnvelope => checkErrorEnvelope(v, 'body'),
} as const;

describe('golden REST bodies satisfy the client contract', () => {
  for (const [name, check] of Object.entries(contract)) {
    it(`validates ${name}.json`, () => {
      expect(() => check(load(name))).not.toThrow();
    });
  }

  it('claims every fixture the server writes', () => {
    // A new golden file no checker covers would be a silent gap.
    const onDisk = readdirSync(fixtureDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length))
      .sort();
    expect(onDisk).toEqual(Object.keys(contract).sort());
  });
});

// A validator that accepts anything is worse than the cast it replaced, so
// these prove the properties that matter are actually enforced.
describe('the contract checks are not decorative', () => {
  function nodesBody(): NodeListResponse & { nodes: Node[] } {
    return load('nodes') as NodeListResponse & { nodes: Node[] };
  }

  it('rejects null where a list is iterated', () => {
    const body = { nodes: null } as unknown as NodeListResponse;
    expect(() => checkNodeList(body, 'body')).toThrow(ContractViolation);
  });

  it('names the field that broke', () => {
    const body = nodesBody();
    (body.nodes[0] as unknown as Record<string, unknown>).position = '0';
    try {
      checkNodeList(body, 'body');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolation);
      expect((error as ContractViolation).at).toBe('body.nodes[0].position');
      return;
    }
    throw new Error('expected a contract violation');
  });

  it('rejects a node type the client cannot render', () => {
    const body = nodesBody();
    (body.nodes[0] as unknown as Record<string, unknown>).type = 'sidebar';
    expect(() => checkNodeList(body, 'body')).toThrow(/one of folder \| bookmark/);
  });

  it('says whether a wrong value was a string or a number', () => {
    // `received 0` would describe both "0" and 0, and telling those apart is
    // the entire content of this class of error.
    const asText = nodesBody();
    (asText.nodes[0] as unknown as Record<string, unknown>).position = '0';
    expect(() => checkNodeList(asText, 'body')).toThrow(/received "0"/);

    const asStringTypedNumber = nodesBody();
    (asStringTypedNumber.nodes[0] as unknown as Record<string, unknown>).title = 7;
    expect(() => checkNodeList(asStringTypedNumber, 'body')).toThrow(/received 7$/);
  });

  it('treats a missing required field as a violation, not undefined', () => {
    const body: Record<string, unknown> = load('spaces') as Record<string, unknown>;
    delete body.spaces;
    expect(() => checkSpaceList(body, 'body')).toThrow(ContractViolation);
  });

  it('does not invent a value for an absent optional field', () => {
    const body: Record<string, unknown> = load('link-check-results') as Record<string, unknown>;
    expect(body.finished_at).toBeUndefined();
    expect(checkLinkCheckResults(body, 'body').finished_at).toBeUndefined();
  });
});
