// Response schemas for the Web-facing REST API, one per declared type in
// ./types. `fixtures/api/*.json` are the Go bodies these are checked against in
// test/rest-contract.test.ts, so a schema that disagrees with the server fails
// in CI rather than in a browser.
//
// Adding a field to ./types without adding it here is a compile error: the
// mapped type in record() demands a checker for every declared key.

import type {
  ActivityAction,
  ActivityEntry,
  ActivityListResponse,
  AdminUserListResponse,
  AdminUserView,
  ApiToken,
  ApiTokenListResponse,
  ApplyPublicationResponse,
  Backup,
  BackupKind,
  BackupListResponse,
  Binding,
  BindingListResponse,
  BindingHealth,
  CreateTokenResponse,
  Device,
  DeviceBindingView,
  DeviceOverview,
  DeviceOverviewResponse,
  DistributionArtifact,
  DistributionResponse,
  DuplicatesResponse,
  DuplicateGroup,
  ExportResponse,
  ImportApplyResponse,
  ImportEntryAction,
  ImportFormat,
  ImportPlan,
  ImportPlanEntry,
  JobListResponse,
  JobStatus,
  JobType,
  JobView,
  LinkCheckResult,
  LinkCheckResultsResponse,
  LinkDeletionResponse,
  LinkDeletionSkip,
  LinkStatusClass,
  LoginResponse,
  MetaResponse,
  Node,
  NodeMapping,
  NodeListResponse,
  NodeType,
  PublicationDetail,
  PublicationImportState,
  PublicationListResponse,
  PublicationNodeDTO,
  PublicationSummary,
  PublicationVersion,
  PublicationVersionListResponse,
  PublicationVisibility,
  RegisterDeviceResponse,
  RestoreBackupResponse,
  RootSlot,
  RootSlotListResponse,
  ScheduleKind,
  ScheduleView,
  Space,
  SpaceListResponse,
  StartPageSnapshot,
  StartPageSnapshotMeta,
  StartPageSnapshotNode,
  StartPageSource,
  SystemStatusResponse,
  SystemSettings,
  SystemSettingsResponse,
  TaskJobView,
  TaskListResponse,
  TransferResponse,
  UndoActivityResult,
  User,
} from './types';
import type { ErrorEnvelope } from './errors';
import {
  arr,
  bool,
  nullable,
  num,
  oneOf,
  opt,
  record,
  recordOf,
  str,
  unknownValue,
} from './validate';
import type { Checker } from './validate';

const nodeType: Checker<NodeType> = oneOf('folder', 'bookmark');
const bindingState = oneOf('pending_initial', 'active', 'suspended');
const syncMode = oneOf('full', 'partial', '');
const jobIdType: Checker<JobType> = oneOf(
  'backup.create',
  'organizer.link_check',
  'journal.gc',
  'receipt.gc',
  'session.cleanup',
  'artifact.cleanup',
  'backup.retention',
  'mail.send',
  'import.run',
);
const jobStatus: Checker<JobStatus> = oneOf(
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'cancelled',
);
const activityAction: Checker<ActivityAction> = oneOf(
  'create',
  'update',
  'move',
  'delete',
  'import',
  'publish',
  'transfer',
  'undo',
);
const bindingHealth: Checker<BindingHealth> = oneOf(
  'healthy',
  'syncing',
  'warning',
  'recovery',
  'offline',
  'suspended',
);

// --- meta and account ---

export const checkMeta: Checker<MetaResponse> = record<MetaResponse>({
  instance_id: str,
  product_version: str,
  api_version: str,
  sync_protocol_versions: arr(num),
});

// The anonymous view of the instance. Only these three keys are public — an
// extra field here would be the client accepting a server that leaked operator
// policy to visitors.
export const checkSystemStatus: Checker<SystemStatusResponse> =
  record<SystemStatusResponse>({
    initialized: bool,
    registration_mode: oneOf('closed', 'open', 'invite'),
    allow_registration: bool,
  });

export const checkUser: Checker<User> = record<User>({
  id: str,
  username: str,
  display_name: str,
  email: str,
  role: oneOf('admin', 'user'),
  status: oneOf('active', 'disabled'),
  locale: str,
  created_at: str,
});

export const checkErrorEnvelope: Checker<ErrorEnvelope> = record<ErrorEnvelope>({
  error: record<ErrorEnvelope['error']>({
    code: str,
    message: str,
    request_id: str,
    details: opt(recordOf(unknownValue)),
  }),
});

// --- library ---

export const checkSpace: Checker<Space> = record<Space>({
  id: str,
  name: str,
  epoch: num,
  revision: num,
  journal_floor_revision: num,
  created_at: str,
});

export const checkSpaceList: Checker<SpaceListResponse> = record<SpaceListResponse>({
  spaces: arr(checkSpace),
});

export const checkNode: Checker<Node> = record<Node>({
  id: str,
  space_id: str,
  type: nodeType,
  title: str,
  url: nullable(str),
  parent_id: nullable(str),
  root_key: nullable(str),
  position: num,
  created_revision: num,
  title_revision: num,
  url_revision: num,
  structure_revision: num,
  created_at: str,
  updated_at: str,
});

export const checkNodeList: Checker<NodeListResponse> = record<NodeListResponse>({
  nodes: arr(checkNode),
});

export const checkRootSlot: Checker<RootSlot> = record<RootSlot>({
  space_id: str,
  key: str,
  display_name: str,
  position: num,
  created_at: str,
});

export const checkRootSlotList: Checker<RootSlotListResponse> =
  record<RootSlotListResponse>({ root_slots: arr(checkRootSlot) });

export const checkActivityEntry: Checker<ActivityEntry> = record<ActivityEntry>({
  id: str,
  timestamp: str,
  actor: str,
  action: activityAction,
  summary: str,
  undoable: bool,
  undone: bool,
  expired: bool,
});

export const checkActivityList: Checker<ActivityListResponse> = record<ActivityListResponse>({
  activity: arr(checkActivityEntry),
});

// --- devices, bindings, tokens ---

export const checkBindingView: Checker<DeviceBindingView> = record<DeviceBindingView>({
  id: str,
  space_id: str,
  space_name: str,
  sync_mode: oneOf('full', 'partial'),
  state: bindingState,
  health: bindingHealth,
  epoch: num,
  applied_revision: num,
  server_revision: num,
  last_sync_at: nullable(str),
});

export const checkDeviceOverview: Checker<DeviceOverview> = record<DeviceOverview>({
  id: str,
  name: str,
  client_type: str,
  browser: str,
  platform: str,
  sync_mode: syncMode,
  created_at: str,
  last_seen_at: nullable(str),
  revoked_at: nullable(str),
  bindings: arr(checkBindingView),
});

export const checkDeviceOverviewResponse: Checker<DeviceOverviewResponse> =
  record<DeviceOverviewResponse>({ devices: arr(checkDeviceOverview) });

export const checkDistributionArtifact: Checker<DistributionArtifact> =
  record<DistributionArtifact>({
    platform: str,
    variant: str,
    version: str,
    file: str,
    sha256: str,
    size_bytes: num,
    manifest_version: num,
    min_server_version: str,
    supported_browsers: arr(str),
    sync_protocol_versions: arr(num),
  });

export const checkDistributionExtensions: Checker<DistributionResponse> =
  record<DistributionResponse>({
    release: str,
    commit: str,
    generated_at: str,
    server_version: str,
    http_api_version: str,
    // The server answers `[]` when this binary carries no package. A null here
    // would render as an empty install page instead of a contract failure.
    artifacts: arr(checkDistributionArtifact),
  });

export const checkBinding: Checker<Binding> = record<Binding>({
  id: str,
  device_id: str,
  space_id: str,
  state: bindingState,
  epoch: num,
  applied_revision: num,
  received_revision: num,
  max_client_seq: num,
});

export const checkBindingList: Checker<BindingListResponse> = record<BindingListResponse>({
  bindings: arr(checkBinding),
});

export const checkApiToken: Checker<ApiToken> = record<ApiToken>({
  id: str,
  name: str,
  scopes: arr(str),
  space_scope: str,
  created_at: str,
  last_used_at: nullable(str),
  expires_at: nullable(str),
});

export const checkApiTokenList: Checker<ApiTokenListResponse> = record<ApiTokenListResponse>({
  tokens: arr(checkApiToken),
});

// --- backups ---

const backupKind: Checker<BackupKind> = oneOf('manual', 'scheduled', 'safety');

export const checkBackup: Checker<Backup> = record<Backup>({
  id: str,
  space_id: str,
  kind: backupKind,
  filename: str,
  size_bytes: num,
  node_count: num,
  bookmark_count: num,
  created_at: str,
  protected: bool,
});

export const checkBackupList: Checker<BackupListResponse> = record<BackupListResponse>({
  backups: arr(checkBackup),
});

// --- jobs, schedules, tasks ---

export const checkJobView: Checker<JobView> = record<JobView>({
  id: str,
  type: jobIdType,
  status: jobStatus,
  owner: str,
  space_name: opt(str),
  phase: opt(str),
  progress: opt(record<NonNullable<JobView['progress']>>({ current: num, total: num })),
  attempt: num,
  max_attempts: num,
  scheduled_at: str,
  started_at: opt(str),
  finished_at: opt(str),
  error: opt(str),
});

export const checkJobList: Checker<JobListResponse> = record<JobListResponse>({
  jobs: arr(checkJobView),
});

const scheduleKind: Checker<ScheduleKind> = oneOf('daily', 'weekly', 'monthly');

export const checkScheduleView: Checker<ScheduleView> = record<ScheduleView>({
  id: str,
  type: jobIdType,
  title_key: str,
  space_id: opt(str),
  space_name: opt(str),
  enabled: bool,
  kind: scheduleKind,
  time_of_day: str,
  weekday: num,
  day_of_month: num,
  timezone: str,
  next_run_at: str,
  last_run_at: opt(str),
  created_at: str,
});

export const checkTaskJobView: Checker<TaskJobView> = record<TaskJobView>({
  id: str,
  type: jobIdType,
  status: jobStatus,
  title_key: opt(str),
  space_id: opt(str),
  space_name: opt(str),
  phase: opt(str),
  progress: opt(
    record<NonNullable<TaskJobView['progress']>>({ current: opt(num), total: opt(num) }),
  ),
  attempt: num,
  max_attempts: num,
  schedule_id: opt(str),
  scheduled_at: str,
  started_at: opt(str),
  finished_at: opt(str),
  error: opt(str),
});

export const checkScheduleList: Checker<{ schedules: ScheduleView[] }> =
  record<{ schedules: ScheduleView[] }>({ schedules: arr(checkScheduleView) });

export const checkTaskList: Checker<TaskListResponse> = record<TaskListResponse>({
  schedules: arr(checkScheduleView),
  jobs: arr(checkTaskJobView),
});

// --- organizer ---

const linkStatusClass: Checker<LinkStatusClass> = oneOf(
  'ok_2xx',
  'client_4xx',
  'server_5xx',
  'timeout',
  'network_error',
);

export const checkLinkCheckResult: Checker<LinkCheckResult> = record<LinkCheckResult>({
  node_id: str,
  title: str,
  checked_url: str,
  status_class: linkStatusClass,
  http_status: opt(num),
  error_type: opt(str),
  latency_ms: num,
  final_url: opt(str),
  checked_at: str,
});

export const checkLinkCheckResults: Checker<LinkCheckResultsResponse> =
  record<LinkCheckResultsResponse>({
    job_id: str,
    total: num,
    done: num,
    finished_at: opt(str),
    results: arr(checkLinkCheckResult),
  });

export const checkLinkDeletionSkip: Checker<LinkDeletionSkip> = record<LinkDeletionSkip>({
  node_id: str,
  reason: oneOf('not_in_run', 'node_gone', 'node_changed', 'url_changed', 'delete_failed'),
  detail: opt(str),
});

export const checkLinkDeletion: Checker<LinkDeletionResponse> = record<LinkDeletionResponse>({
  // Both arrays are always present: a batch that refused nothing still has to
  // be iterable, and the page reports "N deleted, M refused" from these.
  deleted: arr(str),
  skipped: arr(checkLinkDeletionSkip),
});

export const checkDuplicateGroup: Checker<DuplicateGroup> = record<DuplicateGroup>({
  id: str,
  kind: oneOf('exact', 'suspected'),
  reason: opt(str),
  items: arr(
    record<DuplicateGroup['items'][number]>({ node_id: str, title: str, url: str, path: str }),
  ),
});

export const checkDuplicates: Checker<DuplicatesResponse> = record<DuplicatesResponse>({
  groups: arr(checkDuplicateGroup),
});

// --- plaza / publications ---

const publicationVisibility: Checker<PublicationVisibility> = oneOf('private', 'plaza');

// Recursive, so the shape is built when a body arrives rather than while this
// const is still being initialized.
export const checkPublicationNode: Checker<PublicationNodeDTO> = (value, at) =>
  record<PublicationNodeDTO>({
    id: str,
    type: nodeType,
    title: str,
    url: opt(str),
    children: opt(arr(checkPublicationNode)),
  })(value, at);

const publicationSummaryShape = {
  id: str,
  slug: str,
  title: str,
  description: str,
  publisher: str,
  version: num,
  visibility: publicationVisibility,
  bookmark_count: num,
  folder_count: num,
  tags: arr(str),
  created_at: str,
  updated_at: str,
  is_mine: bool,
} satisfies { [K in keyof PublicationSummary]-?: Checker<PublicationSummary[K]> };

export const checkPublicationSummary: Checker<PublicationSummary> =
  record(publicationSummaryShape);

const publicationImportState: Checker<PublicationImportState> =
  record<PublicationImportState>({
    last_version: num,
    space_id: str,
    target_parent: str,
    has_update: bool,
  });

export const checkPublicationDetail: Checker<PublicationDetail> = record<PublicationDetail>({
  ...publicationSummaryShape,
  tree: checkPublicationNode,
  import: opt(publicationImportState),
});

export const checkPublicationList: Checker<PublicationListResponse> =
  record<PublicationListResponse>({ publications: arr(checkPublicationSummary) });

export const checkApplyPublication: Checker<ApplyPublicationResponse> =
  record<ApplyPublicationResponse>({ created: num, updated: num, kept: num });

const publicationVersionShape = {
  version: num,
  bookmark_count: num,
  folder_count: num,
  note: str,
  created_at: str,
} satisfies { [K in keyof PublicationVersion]-?: Checker<PublicationVersion[K]> };

export const checkPublicationVersion: Checker<PublicationVersion> =
  record<PublicationVersion>(publicationVersionShape);

export const checkPublicationVersions: Checker<PublicationVersionListResponse> =
  record<PublicationVersionListResponse>({ versions: arr(checkPublicationVersion) });

// --- import / export ---

const importFormat: Checker<ImportFormat> = oneOf('netscape_html', 'native_json');

const importEntryAction: Checker<ImportEntryAction> = oneOf(
  'create',
  'update',
  'move',
  'delete',
  'keep',
  'ambiguous',
  'unsupported',
);

export const checkImportPlanEntry: Checker<ImportPlanEntry> = record<ImportPlanEntry>({
  title: str,
  url: opt(str),
  path: str,
  action: importEntryAction,
  reason: opt(str),
});

// A preview only reports the actions it actually planned: `{create: 2}` for a
// first import, not the other six as zeroes. Each key stays closed, so an action
// name the server renames is a violation instead of a silently missing badge.
const importCounts = record<Partial<Record<ImportEntryAction, number>>>({
  create: opt(num),
  update: opt(num),
  move: opt(num),
  delete: opt(num),
  keep: opt(num),
  ambiguous: opt(num),
  unsupported: opt(num),
});

export const checkImportPlan: Checker<ImportPlan> = record<ImportPlan>({
  plan_id: str,
  space_id: str,
  format: importFormat,
  total: num,
  counts: importCounts,
  warnings: arr(str),
  entries: arr(checkImportPlanEntry),
  bound_revision: num,
});

export const checkImportApply: Checker<ImportApplyResponse> = record<ImportApplyResponse>({
  created: num,
  updated: num,
  deleted: num,
  kept: num,
});

export const checkExport: Checker<ExportResponse> = record<ExportResponse>({
  filename: str,
  content_type: str,
  content: str,
});

// --- cross-space transfer ---

export const checkTransferResponse: Checker<TransferResponse> = record<TransferResponse>({
  transfer_id: str,
  source_revision: num,
  target_revision: num,
  // A folder move answers with one entry per node carried, in source order;
  // the UI maps its own ids through this table, so it must be an array.
  mapping: arr(record<NodeMapping>({ source_node_id: str, target_node_id: str })),
});

// --- users admin ---

export const checkAdminUser: Checker<AdminUserView> = record<AdminUserView>({
  id: str,
  username: str,
  display_name: str,
  email: str,
  role: oneOf('admin', 'user'),
  status: oneOf('active', 'disabled'),
  space_count: num,
  created_at: str,
  // A user who has never logged in has no last seen moment at all.
  last_seen_at: nullable(str),
});

export const checkAdminUserList: Checker<AdminUserListResponse> = record<AdminUserListResponse>({
  users: arr(checkAdminUser),
});

export const checkResetLink: Checker<{ reset_link: string }> = record<{ reset_link: string }>({
  reset_link: str,
});

// --- one-shot answers ---
//
// These are the bodies a client reads exactly once: a login, a credential issued
// by registration, the job it just queued. They are pinned like every other
// response, which is why the secrets themselves are normalized in the fixture
// harness — the contract is that the answer carries the string.

export const checkDevice: Checker<Device> = record<Device>({
  id: str,
  name: str,
  client_type: str,
  browser: str,
  platform: str,
  sync_mode: opt(syncMode),
  created_at: str,
});

export const checkLogin: Checker<LoginResponse> = record<LoginResponse>({
  token: str,
  expires_at: str,
  user: checkUser,
});

export const checkRegisterDevice: Checker<RegisterDeviceResponse> =
  record<RegisterDeviceResponse>({ device: checkDevice, token: str });

export const checkCreateToken: Checker<CreateTokenResponse> = record<CreateTokenResponse>({
  token: checkApiToken,
  secret: str,
});

// The instance store is key/value text, so the two numeric policies really do
// come back as "24" and "16"; nothing on the server acts on them yet.
export const checkSystemSettings: Checker<SystemSettings> = record<SystemSettings>({
  registration_mode: oneOf('closed', 'open', 'invite'),
  default_locale: str,
  session_ttl_hours: str,
  max_spaces_per_user: str,
});

export const checkSystemSettingsResponse: Checker<SystemSettingsResponse> =
  record<SystemSettingsResponse>({ settings: checkSystemSettings });

export const checkUndoActivity: Checker<UndoActivityResult> = record<UndoActivityResult>({
  status: oneOf('clean', 'review_required', 'not_undoable', 'expired'),
  // Only the clean path carries an inverse ChangeSet; every other status is
  // answered as an error envelope instead, so these stay optional here.
  change_set_id: opt(str),
  summary: opt(str),
  reasons: opt(arr(str)),
});

export const checkRestoreBackup: Checker<RestoreBackupResponse> =
  record<RestoreBackupResponse>({ safety_backup_id: str, new_epoch: num });

/** The `{status:"ok"}` every acknowledged action answers with. */
export const checkAcknowledged: Checker<{ status: string }> = record<{ status: string }>({
  status: str,
});

/** A job the server has just taken: enqueue, retry and run-now all answer this. */
export const checkJobAccepted: Checker<{ id: string; type: JobType; status: JobStatus }> =
  record<{ id: string; type: JobType; status: JobStatus }>({
    id: str,
    type: jobIdType,
    status: jobStatus,
  });

/** run-now omits `type`; the id is what the caller polls. */
export const checkRunNow: Checker<{ id: string; status: JobStatus }> =
  record<{ id: string; status: JobStatus }>({ id: str, status: jobStatus });

// ─── Start page ────────────────────────────────────────────────────────────
//
// Pinned here even though the Web app reads none of it: the extension carries
// its own hand-copied version of these shapes, and this is the only automated
// link that says the two still describe the same bytes.

export const checkStartPageSource: Checker<StartPageSource> = record<StartPageSource>({
  space_id: str,
  space_name: str,
  folder_id: str,
  folder_title: str,
});

export const checkStartPageSnapshotNode: Checker<StartPageSnapshotNode> =
  record<StartPageSnapshotNode>({
    id: str,
    type: nodeType,
    parent_id: str,
    title: str,
    // A folder has no url and no children to count; both keys are left out
    // rather than sent as "" or 0, so a missing one is not read as a value.
    url: opt(str),
    position: num,
    child_count: opt(num),
    updated_at: str,
  });

export const checkStartPageSnapshotMeta: Checker<StartPageSnapshotMeta> =
  record<StartPageSnapshotMeta>({
    epoch: num,
    revision: num,
    captured_at: str,
    complete: bool,
    source_title: str,
  });

export const checkStartPageSnapshot: Checker<StartPageSnapshot> = record<StartPageSnapshot>({
  schema_version: num,
  instance_id: str,
  user_id: str,
  source: checkStartPageSource,
  snapshot: checkStartPageSnapshotMeta,
  // The server answers `[]` for an empty folder. Anything else — null, an
  // absent key — is a read the page must not render as an empty room.
  nodes: arr(checkStartPageSnapshotNode),
});
