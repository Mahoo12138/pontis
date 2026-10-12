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
  checkAdminUserList,
  checkAcknowledged,
  checkApiTokenList,
  checkApplyPublication,
  checkBackupList,
  checkBindingList,
  checkCreateToken,
  checkJobAccepted,
  checkDeviceOverviewResponse,
  checkDuplicates,
  checkErrorEnvelope,
  checkExport,
  checkImportApply,
  checkImportPlan,
  checkJobList,
  checkLinkCheckResults,
  checkLogin,
  checkMeta,
  checkNodeList,
  checkPublicationDetail,
  checkPublicationList,
  checkRegisterDevice,
  checkResetLink,
  checkRestoreBackup,
  checkRootSlotList,
  checkRunNow,
  checkScheduleList,
  checkSpaceList,
  checkStartPageGrantList,
  checkStartPageSnapshot,
  checkStartPageSource,
  checkSystemSettingsResponse,
  checkTaskList,
  checkTransferResponse,
  checkUndoActivity,
  checkUser,
} from '../src/contract';
import { ContractViolation } from '../src/validate';
import type { ErrorEnvelope } from '../src/errors';
import type {
  ActivityListResponse,
  AdminUserListResponse,
  AdminUserView,
  ApiTokenListResponse,
  ApplyPublicationResponse,
  BackupListResponse,
  BindingListResponse,
  CreateTokenResponse,
  DeviceOverviewResponse,
  DuplicatesResponse,
  ExportResponse,
  ImportApplyResponse,
  ImportPlan,
  JobListResponse,
  JobStatus,
  JobType,
  LoginResponse,
  LinkCheckResultsResponse,
  MetaResponse,
  Node,
  NodeListResponse,
  RegisterDeviceResponse,
  RestoreBackupResponse,
  PublicationDetail,
  PublicationListResponse,
  RootSlotListResponse,
  SpaceListResponse,
  StartPageGrantListResponse,
  StartPageSnapshot,
  StartPageSource,
  SystemSettingsResponse,
  TaskListResponse,
  TransferResponse,
  UndoActivityResult,
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
  // Start page: the source a device may read, the subtree it resolves to,
  // and the same read as a signed-in account.
  'start-page-source': (v: unknown): StartPageSource => checkStartPageSource(v, 'body'),
  'start-page-grants': (v: unknown): StartPageGrantListResponse => checkStartPageGrantList(v, 'body'),
  'start-page-snapshot': (v: unknown): StartPageSnapshot => checkStartPageSnapshot(v, 'body'),
  'start-page-web-snapshot': (v: unknown): StartPageSnapshot => checkStartPageSnapshot(v, 'body'),
  'start-page-snapshot-empty': (v: unknown): StartPageSnapshot => checkStartPageSnapshot(v, 'body'),
  'error-validation': (v: unknown): ErrorEnvelope => checkErrorEnvelope(v, 'body'),
  'error-not-found': (v: unknown): ErrorEnvelope => checkErrorEnvelope(v, 'body'),
  'admin-users': (v: unknown): AdminUserListResponse => checkAdminUserList(v, 'body'),
  'reset-link': (v: unknown): { reset_link: string } => checkResetLink(v, 'body'),
  'plaza-publications': (v: unknown): PublicationListResponse => checkPublicationList(v, 'body'),
  'publication-detail': (v: unknown): PublicationDetail => checkPublicationDetail(v, 'body'),
  'publication-apply': (v: unknown): ApplyPublicationResponse => checkApplyPublication(v, 'body'),
  'space-transfer': (v: unknown): TransferResponse => checkTransferResponse(v, 'body'),
  'import-preview': (v: unknown): ImportPlan => checkImportPlan(v, 'body'),
  'import-apply': (v: unknown): ImportApplyResponse => checkImportApply(v, 'body'),
  export: (v: unknown): ExportResponse => checkExport(v, 'body'),

  // One-shot answers: each is what a client reads exactly once.
  login: (v: unknown): LoginResponse => checkLogin(v, 'body'),
  'profile-updated': (v: unknown): User => checkUser(v, 'body'),
  settings: (v: unknown): SystemSettingsResponse => checkSystemSettingsResponse(v, 'body'),
  'settings-updated': (v: unknown): SystemSettingsResponse =>
    checkSystemSettingsResponse(v, 'body'),
  'device-register': (v: unknown): RegisterDeviceResponse => checkRegisterDevice(v, 'body'),
  'token-create': (v: unknown): CreateTokenResponse => checkCreateToken(v, 'body'),
  undo: (v: unknown): UndoActivityResult => checkUndoActivity(v, 'body'),
  'schedule-run-now': (v: unknown): { id: string; status: JobStatus } => checkRunNow(v, 'body'),
  'job-enqueue': (v: unknown): { id: string; type: JobType; status: JobStatus } =>
    checkJobAccepted(v, 'body'),
  'job-cancel': (v: unknown): { status: string } => checkAcknowledged(v, 'body'),
  'admin-job-cancel': (v: unknown): { status: string } => checkAcknowledged(v, 'body'),
  logout: (v: unknown): { status: string } => checkAcknowledged(v, 'body'),
  'password-reset': (v: unknown): { status: string } => checkAcknowledged(v, 'body'),
  'backup-restore': (v: unknown): RestoreBackupResponse => checkRestoreBackup(v, 'body'),
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

  it('accepts a user who has never been seen, rejects an unknown role', () => {
    // The golden list has one admin who logged in, so the null branch of
    // last_seen_at only exists here.
    const alice = (load('admin-users') as AdminUserListResponse).users[0] as AdminUserView;
    expect(alice.last_seen_at).not.toBeNull();
    const never = { users: [{ ...alice, last_seen_at: null }] };
    expect(checkAdminUserList(never, 'body').users[0]?.last_seen_at).toBeNull();

    const promoted = load('admin-users') as Record<string, unknown>;
    ((promoted.users as unknown[])[0] as Record<string, unknown>).role = 'owner';
    expect(() => checkAdminUserList(promoted, 'body')).toThrow(/role.*one of admin \| user/);
  });

  it('refuses to read a start-page snapshot that lost its node list', () => {
    // An empty folder answers `nodes: []`. Null and an absent key are
    // different failures, and the page has to tell them apart from a folder
    // that really has nothing in it (§13.2).
    const body = load('start-page-snapshot') as Record<string, unknown>;
    body.nodes = null;
    expect(() => checkStartPageSnapshot(body, 'body')).toThrow(/nodes.*an array/);
    delete body.nodes;
    expect(() => checkStartPageSnapshot(body, 'body')).toThrow(/nodes.*an array/);

    // Watermarks stay numbers. A revision that arrived as a string would be
    // compared against a number somewhere downstream and lose.
    const drifted = load('start-page-snapshot') as Record<string, unknown>;
    (drifted.snapshot as Record<string, unknown>).revision = '2';
    expect(() => checkStartPageSnapshot(drifted, 'body')).toThrow(/revision.*a number/);

    const empty = load('start-page-snapshot-empty') as StartPageSnapshot;
    expect(empty.nodes).toEqual([]);
    expect(checkStartPageSnapshot(empty, 'body').snapshot.complete).toBe(true);
  });

  it('names a source by both ends of its authorization', () => {
    const source = load('start-page-source') as StartPageSource;
    expect(source.folder_title).toBe('Reading');
    // A grant version is what expires a cache; without it the client cannot
    // tell a moved source from an unchanged one.
    expect(source.grant_version).toBe(1);

    const stale = load('start-page-source') as Record<string, unknown>;
    stale.grant_id = undefined;
    expect(() => checkStartPageSource(stale, 'body')).toThrow(/grant_id.*a string/);
  });

  it('keeps an import plan reporting only the actions it planned', () => {    // `{create: 2}` is what the server really sent; a checker that demanded all
    // seven keys would reject every first import.
    const plan = load('import-preview') as ImportPlan;
    expect(plan.counts).toEqual({ create: 2 });
    expect(checkImportPlan(plan, 'body').counts.update).toBeUndefined();

    const silent = load('import-preview') as Record<string, unknown>;
    delete silent.counts;
    expect(() => checkImportPlan(silent, 'body')).toThrow(
      /expected an object, received undefined/,
    );

    // The action vocabulary itself is closed, so a rename fails on the entry
    // that carries it rather than vanishing into an unmatched badge.
    const renamed = load('import-preview') as Record<string, unknown>;
    ((renamed.entries as unknown[])[0] as Record<string, unknown>).action = 'remove';
    expect(() => checkImportPlan(renamed, 'body')).toThrow(/one of create \| update \| move/);
  });

  it('requires a transfer mapping it can walk', () => {
    // The explorer maps its own node ids through this table; a null would be a
    // blank transfer rather than an error.
    const body = load('space-transfer') as Record<string, unknown>;
    body.mapping = null;
    expect(() => checkTransferResponse(body, 'body')).toThrow(/body\.mapping.*an array/);
  });

  it('names where inside a publication tree the shape broke', () => {
    const body = load('publication-detail') as PublicationDetail;
    (body.tree.children?.[0] as unknown as Record<string, unknown>).children = 'Reading';
    try {
      checkPublicationDetail(body, 'body');
    } catch (error) {
      expect((error as ContractViolation).at).toBe('body.tree.children[0].children');
      return;
    }
    throw new Error('expected a contract violation');
  });

  it('pins instance settings as the text the store really holds', () => {
    // The key/value column means a session lifetime arrives as "24", not 24.
    // Saying so here is what keeps `session_ttl_hours * 3600` from quietly
    // becoming string repetition in a client that trusted the old declaration.
    const settings = load('settings') as SystemSettingsResponse;
    expect(settings.settings.session_ttl_hours).toBe('24');
    expect(() =>
      checkSystemSettingsResponse(
        { settings: { ...settings.settings, session_ttl_hours: 24 } },
        'body',
      ),
    ).toThrow(/body\.settings\.session_ttl_hours.*expected a string, received 24/);
  });

  it('refuses a login that carries no user', () => {
    const body = load('login') as Record<string, unknown>;
    delete body.user;
    expect(() => checkLogin(body, 'body')).toThrow(
      /body\.user.*expected an object, received undefined/,
    );
  });

  it('keeps an undo status inside the four the page can render', () => {
    const body = load('undo') as Record<string, unknown>;
    body.status = 'reverted';
    expect(() => checkUndoActivity(body, 'body')).toThrow(/one of clean \| review_required/);
  });

  it('requires the epoch a restore says it moved to', () => {
    const body = load('backup-restore') as Record<string, unknown>;
    body.new_epoch = '2';
    expect(() => checkRestoreBackup(body, 'body')).toThrow(
      /body\.new_epoch.*expected a number, received "2"/,
    );
  });
});
