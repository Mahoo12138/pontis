// ─── Meta ───────────────────────────────────────────────────

export interface MetaResponse {
  instance_id: string;
  product_version: string;
  api_version: string;
  sync_protocol_versions: number[];
}

// ─── Auth ───────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  display_name: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  locale: string;
  created_at: string;
}

export interface SetupRequest {
  username: string;
  password: string;
  display_name?: string;
  email?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expires_at: string;
  user: User;
}

// ─── Spaces ─────────────────────────────────────────────────

export interface Space {
  id: string;
  name: string;
  epoch: number;
  revision: number;
  journal_floor_revision: number;
  created_at: string;
}

export interface SpaceListResponse {
  spaces: Space[];
}

export interface CreateSpaceRequest {
  name: string;
}

// ─── Devices ────────────────────────────────────────────────

export interface Device {
  id: string;
  name: string;
  client_type: string;
  browser: string;
  platform: string;
  sync_mode?: 'full' | 'partial' | '';
  created_at: string;
}

export interface RegisterDeviceRequest {
  name: string;
  client_type?: string;
  browser?: string;
  platform?: string;
}

export interface RegisterDeviceResponse {
  device: Device;
  token: string;
}

// ─── Device overview (gap endpoint — mock only) ─────────────

/** UI-facing health of a Device × Space binding. */
export type BindingHealth =
  | 'healthy'
  | 'syncing'
  | 'warning'
  | 'recovery'
  | 'offline'
  | 'suspended';

export interface DeviceBindingView {
  id: string;
  space_id: string;
  space_name: string;
  sync_mode: 'full' | 'partial';
  state: 'pending_initial' | 'active' | 'suspended';
  health: BindingHealth;
  epoch: number;
  applied_revision: number;
  server_revision: number;
  last_sync_at: string | null;
}

export interface DeviceOverview {
  id: string;
  name: string;
  client_type: string;
  browser: string;
  platform: string;
  sync_mode: 'full' | 'partial' | '';
  created_at: string;
  last_seen_at: string | null;
  bindings: DeviceBindingView[];
}

export interface DeviceOverviewResponse {
  devices: DeviceOverview[];
}

// ─── Bindings ───────────────────────────────────────────────

export interface Binding {
  id: string;
  device_id: string;
  space_id: string;
  state: 'pending_initial' | 'active' | 'suspended';
  epoch: number;
  applied_revision: number;
  received_revision: number;
  max_client_seq: number;
}

export interface BindingListResponse {
  bindings: Binding[];
}

export interface CreateBindingRequest {
  space_id: string;
}

// ─── Sync ───────────────────────────────────────────────────

export interface ParentRef {
  type: 'node' | 'root';
  id?: string;
  key?: string;
}

export interface OperationDTO {
  op_id: string;
  client_seq: number;
  base_revision: number;
  type: string;
  node_id: string;
  node_type?: 'folder' | 'bookmark';
  title?: string;
  url?: string;
  parent?: ParentRef;
  before_id?: string;
}

export interface SyncRequest {
  protocol_version: number;
  epoch: number;
  applied_revision: number;
  received_revision: number;
  max_changes: number;
  operations: OperationDTO[];
}

export interface OperationResult {
  op_id: string;
  client_seq: number;
  status: string;
  reason: string;
  result_revision: number;
  settle_after_revision: number;
}

export interface Change {
  revision: number;
  type: string;
  node_id: string;
  payload: unknown;
}

export interface SyncResponse {
  protocol_version: number;
  epoch: number;
  journal_floor_revision: number;
  from_revision: number;
  through_revision: number;
  server_revision: number;
  has_more: boolean;
  operation_results: OperationResult[];
  changes: Change[];
}

// ─── Nodes (gap endpoint — mock only) ───────────────────────

export type NodeType = 'folder' | 'bookmark';

export interface Node {
  id: string;
  space_id: string;
  type: NodeType;
  title: string;
  url: string | null;
  parent_id: string | null;
  root_key: string | null;
  position: number;
  created_revision: number;
  title_revision: number;
  url_revision: number;
  structure_revision: number;
  created_at: string;
  updated_at: string;
}

export interface RootSlot {
  space_id: string;
  key: string;
  display_name: string;
  position: number;
  created_at: string;
}

export interface NodeListResponse {
  nodes: Node[];
}

export interface RootSlotListResponse {
  root_slots: RootSlot[];
}

export interface CreateNodeRequest {
  type: NodeType;
  title: string;
  url?: string;
  parent: ParentRef;
  before_id?: string;
}

export interface UpdateNodeRequest {
  title?: string;
  url?: string;
}

export interface MoveNodeRequest {
  parent: ParentRef;
  before_id?: string;
}

// ─── Activity (gap endpoint — mock only) ──────────────────

export type ActivityAction = 'create' | 'update' | 'move' | 'delete';

export interface ActivityEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: ActivityAction;
  summary: string;
  undoable: boolean;
}

export interface ActivityListResponse {
  activity: ActivityEntry[];
}

// ─── Plaza / Publications (gap endpoint — mock only) ────────

export type PublicationVisibility = 'private' | 'plaza';

/**
 * Node inside a published share tree. `id` is a stable publication_node_id,
 * deliberately unrelated to any canonical UUID.
 */
export interface PublicationNodeDTO {
  id: string;
  type: NodeType;
  title: string;
  url?: string;
  children?: PublicationNodeDTO[];
}

export interface PublicationSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  publisher: string;
  version: number;
  visibility: PublicationVisibility;
  bookmark_count: number;
  folder_count: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_mine: boolean;
}

export interface PublicationDetail extends PublicationSummary {
  tree: PublicationNodeDTO;
}

export interface PublicationListResponse {
  publications: PublicationSummary[];
}

export interface PublishRequest {
  space_id: string;
  /** Omitted = whole space; a node id publishes that subtree. */
  root_node_id?: string;
  title: string;
  description?: string;
  tags?: string[];
}

export interface ApplyPublicationRequest {
  space_id: string;
  parent: ParentRef;
  strategy: 'merge' | 'replace';
}

export interface ApplyPublicationResponse {
  created: number;
  updated: number;
  kept: number;
}

// ─── Import / Export (gap endpoint — mock only) ─────────────

export type ImportFormat = 'netscape_html' | 'native_json';

export type ImportEntryAction =
  | 'create'
  | 'update'
  | 'move'
  | 'delete'
  | 'keep'
  | 'ambiguous'
  | 'unsupported';

/** One planned change from the Parse → Validate → Plan pipeline. */
export interface ImportPlanEntry {
  title: string;
  url?: string;
  path: string;
  action: ImportEntryAction;
  reason?: string;
}

export interface ImportPlan {
  plan_id: string;
  format: ImportFormat;
  total: number;
  counts: Record<ImportEntryAction, number>;
  warnings: string[];
  entries: ImportPlanEntry[];
  /** Plan binds to target epoch/revision; stale plans must be re-previewed. */
  bound_revision: number;
}

export interface ImportPreviewRequest {
  format: ImportFormat;
  content: string;
}

export interface ImportApplyRequest {
  plan_id: string;
  parent: ParentRef;
  strategy: ImportStrategy;
}

export type ImportStrategy = 'merge' | 'replace';

export interface ImportApplyResponse {
  created: number;
  updated: number;
  deleted: number;
  kept: number;
}

export interface ExportRequest {
  format: ImportFormat;
  root_key?: string;
}

export interface ExportResponse {
  filename: string;
  content_type: string;
  content: string;
}

// ─── Organizer (gap endpoint — mock only) ────────────────────

export type LinkStatusClass = 'ok_2xx' | 'client_4xx' | 'server_5xx' | 'timeout' | 'network_error';

export interface LinkCheckResult {
  node_id: string;
  title: string;
  checked_url: string;
  status_class: LinkStatusClass;
  http_status?: number;
  error_type?: string;
  latency_ms: number;
  final_url?: string;
  checked_at: string;
}

export interface LinkCheckRunResponse {
  job_id: string;
  total: number;
}

export interface LinkCheckResultsResponse {
  job_id: string;
  finished_at: string;
  results: LinkCheckResult[];
}

export interface DuplicateGroup {
  id: string;
  kind: 'exact' | 'suspected';
  reason?: string;
  items: {
    node_id: string;
    title: string;
    url: string;
    path: string;
  }[];
}

export interface DuplicatesResponse {
  groups: DuplicateGroup[];
}

// ─── Backups (gap endpoint — mock only) ──────────────────────

export type BackupKind = 'manual' | 'scheduled' | 'safety';

export interface Backup {
  id: string;
  space_id: string;
  kind: BackupKind;
  filename: string;
  size_bytes: number;
  node_count: number;
  bookmark_count: number;
  created_at: string;
  protected: boolean;
}

export interface BackupListResponse {
  backups: Backup[];
}

export interface RestoreBackupResponse {
  safety_backup_id: string;
  new_epoch: number;
}

// ─── API Tokens & Settings (gap endpoint — mock only) ────────

export interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  space_scope: 'all' | string[];
  created_at: string;
  last_used_at: string | null;
}

export interface ApiTokenListResponse {
  tokens: ApiToken[];
}

export interface CreateTokenRequest {
  name: string;
  scopes: string[];
  space_scope: 'all' | string[];
}

export interface CreateTokenResponse {
  token: ApiToken;
  secret: string;
}

export interface SystemSettings {
  registration_mode: 'closed' | 'open' | 'invite';
  default_locale: string;
  session_ttl_hours: number;
  max_spaces_per_user: number;
}

export interface SystemSettingsResponse {
  settings: SystemSettings;
}

// ─── Users admin (gap endpoint — mock only) ──────────────────

export interface AdminUserView {
  id: string;
  username: string;
  display_name: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  space_count: number;
  created_at: string;
  last_seen_at: string | null;
}

export interface AdminUserListResponse {
  users: AdminUserView[];
}
