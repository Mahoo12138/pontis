# 08. Browser Extension ↔ Server API Contract

## 1. 协议分层

```text
/api/v1      HTTP API version
protocol_version = 1   Sync semantic protocol version
```

两者独立版本化。

Browser Sync Protocol 与普通 Domain REST API 分开。Browser Extension 使用 Device Credential，而不是普通 API Token。

## 2. Discovery

```http
GET /api/v1/meta
```

返回：

- instance_id；
- server product version；
- API version；
- supported sync protocol versions；
- feature metadata。

Extension 保存 `server_url + instance_id`。URL 可以变化，instance_id 不变表示仍是同一安装实例。

instance_id 变化时禁止盲目复用旧 Replica State。

## 3. Extension Login / Pairing

建议：

```http
POST /api/v1/auth/extension/login
```

用户名密码只换取短生命周期 onboarding/setup token。

之后：

```http
POST /api/v1/devices
Authorization: Bearer <setup-token>
```

Server 返回一次性的 Device Token。

未来 Pairing Code / Web approval 只需要替换 onboarding 流程，不影响后续 Device Protocol。

## 4. Device Credential Scope

Device Principal 只允许：

- device self；
- owner 的 Space catalog metadata；
- create/manage own bindings；
- `/sync`；
- snapshot / reconciliation / recovery。

不允许：

- Publication management；
- Backup management；
- API Token management；
- 普通 broad Bookmark REST API。

## 5. Space Catalog

```http
GET /api/v1/device/spaces
```

返回可绑定 Space 的：

- id；
- name；
- epoch/revision；
- optional node counts。

不直接返回完整 tree。

## 6. Device Sync Mode

```http
PUT /api/v1/device/sync-mode
```

```text
full
partial
```

Mode change 若已有 Active Binding 必须经过 reconfiguration，不简单热切换。

## 7. Bindings

```text
GET    /api/v1/device/bindings
POST   /api/v1/device/bindings
DELETE /api/v1/device/bindings/{id}
```

Server Binding 只知道 Device ↔ Space，不保存 browser folder/root IDs。

Disconnect Binding 不删除 Space，也默认不删除浏览器现有书签。

## 8. Normal Sync

```http
POST /api/v1/sync/bindings/{binding_id}
```

请求/响应见 `04-sync-protocol.md`。

同一 Binding 的 normal sync 与 active reconciliation 不能并发。

## 9. Server Snapshot Resource

大 tree 分页必须绑定同一 Canonical Point-in-Time。

```text
POST /api/v1/sync/bindings/{binding}/server-snapshots
GET  /api/v1/sync/server-snapshots/{snapshot_id}
GET  /api/v1/sync/server-snapshots/{snapshot_id}/nodes?cursor=&limit=
```

创建 snapshot 时确定：

```text
snapshot_id
epoch
revision
node_count
checksum
expires_at
```

后续分页永远读取同一快照，即使 current_revision 已继续增长。

## 10. Client Browser Snapshot

```http
POST /api/v1/sync/bindings/{binding}/client-snapshots
```

Server 不接收持久 browser IDs。

Client 使用 session-local `local_ref`：

```text
l_1
l_2
...
```

Extension 本地知道：

```text
l_2 ↔ browser_id 8371
```

Server 只看到 local_ref、tree fields 和 optional canonical_id。

## 11. Reconciliation Resource

统一：

```http
POST /api/v1/sync/bindings/{binding}/reconciliations
```

类型：

```text
initial
full_resync
recovery
```

后续：

```text
GET  /api/v1/sync/reconciliations/{id}
POST /api/v1/sync/reconciliations/{id}/plan
PUT  /api/v1/sync/reconciliations/{id}/decisions
POST /api/v1/sync/reconciliations/{id}/commit
GET  /api/v1/sync/reconciliations/{id}/steps
POST /api/v1/sync/reconciliations/{id}/complete
```

## 12. Reconciliation Plan

Plan 绑定：

```text
base_epoch
base_revision
plan_hash
```

Commit 时若 Canonical Target 已改变：

```text
409 PLAN_STALE
```

需要重新 Preview。

## 13. Apply Steps

Server Reconciliation 不要求 Extension 再实现 Tree Planner。

Steps 可包含：

```text
assign_identity
create
update
move
delete
```

`assign_identity(local_ref, canonical_id)` 只建立 Mapping，不修改 Browser tree。

其余 Steps 使用 Ensure-State 语义，允许 crash-safe retry。

## 14. Committed Session Retention

Preview/Waiting User 的 session 可以短期过期。

一旦 `server_committed=true`：

> 该 Reconciliation 成为 Binding 正确性的一部分。

不能按普通临时 artifact 自动删除，必须保留到 Client complete 或 binding reset，或能够可靠重新生成 apply target。

## 15. Cross-Space Transfer

建议：

```http
POST /api/v1/sync/transfers
```

使用 `transfer_id` 幂等，Server 在同一 SQLite Transaction 中原子完成 Source DELETE + Target CREATE。

## 16. Error Envelope

统一：

```json
{
  "error": {
    "code": "EPOCH_MISMATCH",
    "message": "...",
    "details": {},
    "request_id": "req_..."
  }
}
```

Frontend / Extension 主要依赖 `code`，message 作为 debug/fallback。
