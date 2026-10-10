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
  ApiToken,
  ApiTokenListResponse,
  Backup,
  BackupKind,
  BackupListResponse,
  Binding,
  BindingListResponse,
  BindingHealth,
  DeviceBindingView,
  DeviceOverview,
  DeviceOverviewResponse,
  DuplicatesResponse,
  DuplicateGroup,
  JobListResponse,
  JobStatus,
  JobType,
  JobView,
  LinkCheckResult,
  LinkCheckResultsResponse,
  LinkStatusClass,
  MetaResponse,
  Node,
  NodeListResponse,
  NodeType,
  RootSlot,
  RootSlotListResponse,
  ScheduleKind,
  ScheduleView,
  Space,
  SpaceListResponse,
  TaskJobView,
  TaskListResponse,
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
  bindings: arr(checkBindingView),
});

export const checkDeviceOverviewResponse: Checker<DeviceOverviewResponse> =
  record<DeviceOverviewResponse>({ devices: arr(checkDeviceOverview) });

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
