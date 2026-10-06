# 18. SQLite V1 Schema Baseline

> 本文是逻辑 Schema Baseline。真正 `000001_initial.sql` 可按实现阶段拆分 migration，但字段语义应遵循本文。

## 1. 系统

### `server_meta`

```text
key TEXT PRIMARY KEY
value TEXT NOT NULL
```

典型：instance_id、created_at。

### `system_settings`

```text
key
value
updated_at
```

Web UI 可编辑产品设置，不用于明文存 Secret。

### `system_secrets`

```text
id
kind
ciphertext
nonce
created_at
updated_at
```

## 2. 用户与认证

### `users`

```text
id PK
username
username_normalized UNIQUE
display_name
email NULL
email_normalized NULL
password_hash
role
status
locale
default_space_id NULL
email_verified_at NULL
password_changed_at
created_at
updated_at
```

email normalized 使用 partial unique index（非 NULL 时唯一）。

### `sessions`

```text
id PK
user_id FK
token_hash UNIQUE
created_at
last_seen_at
expires_at
user_agent
```

### `api_tokens`

```text
id
user_id
name
token_prefix
token_hash UNIQUE
scopes JSON
all_spaces
created_at
last_used_at
expires_at
revoked_at
```

### `api_token_spaces`

```text
token_id
space_id
PRIMARY KEY(token_id, space_id)
```

另有：password_reset_tokens、email_verification_tokens、invites。

## 3. Sync Space

### `sync_spaces`

```text
id PK
owner_user_id FK
name
epoch
current_revision
journal_floor_revision
created_at
updated_at
```

Invariant：

```text
epoch >= 1
0 <= journal_floor_revision <= current_revision
```

### `root_slots`

```text
space_id
key
display_name
position
created_at
PRIMARY KEY(space_id, key)
```

### `nodes`

```text
space_id
id

type
title
url NULL

parent_id NULL
root_key NULL
position

created_revision
title_revision
url_revision
structure_revision

created_at
updated_at

PRIMARY KEY(space_id,id)
```

CHECK：parent_id/root_key exactly one；folder url NULL；bookmark url non-NULL。

Composite FK：

```text
(space_id,parent_id) → nodes(space_id,id) ON DELETE RESTRICT
(space_id,root_key)  → root_slots(space_id,key)
```

Indexes：

```text
(space_id,parent_id,position)
(space_id,root_key,position)
(space_id,type)
(space_id,url)
```

## 4. Sync History

### `journal`

```text
space_id
epoch
revision
change_type
node_id NULL
payload JSON
origin_type
origin_user_id NULL
origin_device_id NULL
origin_binding_id NULL
origin_client_seq NULL
op_id NULL
change_set_id NULL
request_id NULL
created_at
PRIMARY KEY(space_id,epoch,revision)
```

保存 final Canonical Change，而不是 raw Client Intent。

### `tombstones`

```text
space_id
node_id
deleted_epoch
deleted_revision
deleted_at
PRIMARY KEY(space_id,node_id)
```

## 5. Device / Binding

### `devices`

```text
id
owner_user_id
name
client_type
browser
platform
sync_mode NULL
created_at
last_seen_at
revoked_at
```

### `device_credentials`

```text
id
device_id
token_prefix
token_hash UNIQUE
created_at
last_used_at
revoked_at
```

### `device_space_bindings`

```text
id
device_id
space_id
state
epoch
applied_revision
received_revision
max_client_seq
initialized_at
last_sync_at
created_at
updated_at
UNIQUE(device_id,space_id)
```

Browser mount IDs 不进入 Server Schema。

### `client_operation_receipts`

```text
binding_id
op_id
client_seq
request_epoch
base_revision
request_hash
status
reason
result_revision NULL
settle_after_revision NULL
processed_at_revision
created_at
UNIQUE(binding_id,op_id)
UNIQUE(binding_id,client_seq)
```

## 6. Reconciliation

### `sync_artifacts`

大 payload 只保存 metadata，内容可使用 data/runtime artifact files：

```text
id
binding_id
kind
epoch NULL
revision NULL
storage_key
checksum
size_bytes
expires_at NULL
created_at
```

### `reconciliations`

```text
id
binding_id
type
reason
state
phase
source_epoch/revision NULL
target_epoch/revision NULL
client_snapshot_artifact_id NULL
server_snapshot_artifact_id NULL
plan_artifact_id NULL
steps_artifact_id NULL
plan_hash NULL
server_committed
created_at
updated_at
completed_at NULL
```

### `reconciliation_issues`

```text
id
reconciliation_id
type
payload
default_choice
selected_choice NULL
```

## 7. ChangeSet / Undo

### `change_sets`

```text
id
space_id
actor_type
actor_user_id NULL
actor_device_id NULL
actor_api_token_id NULL
origin
kind
summary JSON
first_revision
last_revision
inverse_of_change_set_id NULL
created_at
```

### `change_set_undo_data`

```text
change_set_id PRIMARY KEY
format_version
codec
payload BLOB
expires_at
created_at
```

## 8. Cross-Space Transfer

### `cross_space_transfers`

```text
id
owner_user_id
source_space_id
target_space_id
source_binding_id NULL
target_binding_id NULL
state
request_hash
source_change_set_id NULL
target_change_set_id NULL
created_at
completed_at NULL
```

## 9. Publication

### `publications`

```text
id
owner_user_id
slug UNIQUE
title
description
visibility
current_version_id NULL
created_at
updated_at
deleted_at NULL
```

### `publication_versions`

```text
id
publication_id
version
source_space_id NULL
source_epoch NULL
source_revision NULL
created_at
UNIQUE(publication_id,version)
```

### `publication_version_nodes`

```text
version_id
publication_node_id
type
title
url
parent_publication_node_id NULL
position
PRIMARY KEY(version_id,publication_node_id)
```

### `publication_imports`

```text
id
user_id
publication_id
last_version_id
target_space_id
target_kind
target_node_id NULL
target_root_key NULL
strategy
placement_mode
created_at
updated_at
```

### `publication_import_mappings`

```text
import_id
publication_node_id
canonical_node_id
PRIMARY KEY(import_id,publication_node_id)
```

## 10. Backup

### `backup_providers`

```text
id
owner_user_id
type
name
config JSON
secret_ref NULL
created_at
updated_at
```

### `backups`

```text
id
space_id
provider_id
kind
reason NULL
status
source_epoch
source_revision
object_key
checksum
size_bytes NULL
protected
created_at
completed_at NULL
deleted_at NULL
```

### `backup_policies`

```text
id
space_id
provider_id
mode
config JSON
schedule_id NULL
enabled
```

## 11. Jobs / Schedules

### `jobs`

```text
id
type
owner_user_id NULL   # non-NULL = User Job; NULL = System Job
space_id NULL
status
payload JSON
result JSON
priority
progress_current NULL
progress_total NULL
progress_phase NULL
progress_message NULL
attempt
max_attempts
schedule_id NULL
scheduled_for NULL
worker_id NULL
lease_until NULL
cancel_requested_at NULL
scheduled_at
started_at NULL
finished_at NULL
created_at
updated_at
UNIQUE(schedule_id,scheduled_for)
```

### `schedules`

```text
id
owner_user_id NULL   # non-NULL = User Schedule; NULL = System Schedule
type
enabled
schedule_type
schedule_expr
timezone
payload JSON
next_run_at
last_run_at NULL
created_at
updated_at
```

Ownership invariant：

```text
owner_user_id IS NOT NULL → 用户领域任务 / 计划，只能由 Owner 管理
owner_user_id IS NULL     → 系统维护任务 / 计划，不出现在普通用户任务中心
```

无需额外 `visibility` 字段。是否允许普通用户创建某种 Schedule 由应用层 `TaskDefinition` 注册表控制；Generic `type/payload/schedule_expr` 不直接暴露给 User API。

管理员后台任务页可以读取所有 Job 的运行元数据，但不得因此返回 Private Bookmark payload/result。

## 12. Derived / Operational

可以后续 migration 再引入：

```text
link_check_job_items
node_search_meta
duplicate_scan_groups/items
diagnostic_events
security_audit_log
```

不要为了 initial schema“看起来完整”提前冻结 Organizer derived tables。

## 13. SQLite Pragmas

启动至少：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

实际 driver connection-level pragma 行为需要 integration test 验证。

## 14. Migration

```text
migrations/
000001_initial.sql
000002_...
```

`schema_migrations(version, applied_at)`。

Forward-only；migration 失败拒绝启动，不在每次启动里用 `CREATE TABLE IF NOT EXISTS` 猜 Schema。
