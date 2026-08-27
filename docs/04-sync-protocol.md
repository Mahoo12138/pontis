# 04. 增量同步协议

## 1. 基础模型

系统采用：

> Server-authoritative + offline-capable clients + operation-based synchronization。

Client 上传的是“意图”，Server 返回的是“结果 + Canonical Change Stream”。

## 2. Space Time Model

每个 Space：

```text
(epoch, revision)
```

### Revision

- 在一个 epoch 内单调递增；
- 每一个产生 Canonical Change 的写入分配 revision；
- NOOP / Conflict / Reject 不产生 revision。

### Epoch

用于表示 Canonical Continuity 被打断。

发生以下 Whole-Space Baseline Replacement 时：

- Backup Restore；
- Browser-overwrites-server full replace；
- Whole-space Publication/Import Replace；
- Major reset。

执行：

```text
epoch++
revision = 0
```

现有 Client 收到 `EPOCH_MISMATCH`，进入 Full Resync 或 Recovery。

## 3. Client Operation Envelope

```json
{
  "op_id": "UUIDv7",
  "client_seq": 382,
  "base_revision": 18230,
  "type": "move",
  "payload": {}
}
```

### op_id

幂等键。相同 op_id + 相同 request hash 返回原 Receipt；相同 op_id + 不同 payload 是协议错误 `OP_ID_REUSED`。

### client_seq

Binding 级单调逻辑序号：

```text
(binding_id, client_seq)
```

允许 holes，但新 op_id 的 seq 不得回退。

### base_revision

用户产生该 Operation 时，Browser 实际已应用的 Canonical Revision。

永远不要因为后来收到了更多 Change 就改写旧 Operation 的 base revision。

## 4. 三个客户端 Watermark

### base_revision

单个 Local Operation 创建时看到的世界。

### applied_revision

Browser 实际并连续收敛到的最高 Revision。

### received_revision

Server Change 已经安全持久化到 Client Inbox 的最高连续 Revision。

合法关系：

```text
applied_revision <= received_revision <= server_revision
```

Change Stream continuity 依据 `received_revision`；Conflict causality 依据 Operation `base_revision`。

## 5. `/sync` 请求

逻辑形式：

```json
{
  "protocol_version": 1,
  "epoch": 3,
  "applied_revision": 18276,
  "received_revision": 18300,
  "operations": [],
  "max_changes": 500
}
```

Operation 按 `client_seq ASC` 处理。

空 operations 合法，用于 pull changes。

## 6. `/sync` 返回

```json
{
  "protocol_version": 1,
  "epoch": 3,
  "journal_floor_revision": 12000,
  "from_revision": 18301,
  "through_revision": 18340,
  "server_revision": 18412,
  "has_more": true,
  "operation_results": [],
  "changes": []
}
```

### through_revision

本次实际返回 Change Stream 到哪里。

### server_revision

当前 Server Head。

两者不能混用。

## 7. Operation Result

业务状态：

```text
APPLIED
REBASED
NOOP
CONFLICT
REJECTED
RECOVERED
```

推荐字段：

```text
op_id
client_seq
status
reason
result_revision
settle_after_revision
```

`settle_after_revision` 表示 Client 需要把 Canonical winning state 至少 Apply 到哪个 revision，才能安全清理该 Pending Operation。

## 8. Conflict Dimensions

一个 Node 的语义变化拆分为：

```text
content.title
content.url
structure(parent/order)
existence
```

### 不同维度并发

自动 Merge：

- title UPDATE vs url UPDATE；
- MOVE vs title UPDATE；
- MOVE vs url UPDATE。

### 同字段并发

若 stale base 之后该字段被其他 causal origin 修改：

- 最终值相同 → NOOP；
- 最终值不同 → CONFLICT `concurrent_update`。

### MOVE vs MOVE

不同 Canonical destination → `concurrent_move`。

### DELETE vs stale UPDATE/MOVE

DELETE wins，返回 `target_deleted`，绝不 stale resurrection。

## 9. Same-Binding Causality

同一个 Browser 快速执行：

```text
seq 51 MOVE A→X base 300
seq 52 MOVE A→Y base 300
```

51 Commit 后 structure_revision > base，但 52 不应被误判成 concurrent move。

Server 使用 Journal origin：

```text
origin_binding_id
origin_client_seq
```

判断最新 semantic revision 是否只是当前 seq 的 same-binding causal predecessor。

如果其间插入了另一 Binding 的修改，则正常 Conflict。

## 10. Stale Anchor

MOVE 使用 `before_id`。

### Anchor 曾经合法，后来删除/移动

```text
REBASED
reason = anchor_deleted / anchor_moved
```

V1 fallback：append 到当前 parent。

### Anchor 从来就不合法

```text
REJECTED invalid_anchor
```

## 11. Parent Deleted + Offline CREATE

离线新数据优先保护：

```text
CREATE X under F
```

如果 F 后来被删除：

```text
RECOVERED parent_deleted
```

Server 将 X 创建至：

```text
Recovered/<Device>
```

如果后续 same-binding CREATE child 指向 X，可继续构建整个离线 subtree。

## 12. Journal Floor 与 History Expired

`journal_floor_revision = F` 表示 Server 保证能从 F 继续提供连续增量历史。

### Change Stream continuity

如果：

```text
received_revision < F
```

Client 缺少已经被 Server GC 的 Change：

```text
HISTORY_EXPIRED
```

### Operation continuity

如果某 pending operation：

```text
base_revision < F
```

即使 Client 已收到较新的 Change，Server 也无法安全 rebase 这个旧意图：

```text
OPERATION_HISTORY_EXPIRED
```

进入 Recovery。

## 13. Client Own Change 也必须回流

Client 自己的成功 Operation 也进入连续 Canonical Change Stream。

这样 Client 可以只维护一个 Revision Timeline，不需要特殊跳过自己造成的 revisions。

若 Browser 本来已满足自己的 Change，则 Local Apply 为 NOOP，仍然推进 applied revision。

## 14. HTTP 与业务错误

普通 per-operation Conflict 使用 HTTP 200。

Binding continuity / protocol failure 使用统一 machine `error.code`，例如：

```text
EPOCH_MISMATCH
HISTORY_EXPIRED
OPERATION_HISTORY_EXPIRED
BINDING_NOT_ACTIVE
RECONCILIATION_IN_PROGRESS
SYNC_PROTOCOL_UNSUPPORTED
```

HTTP 状态只作为 transport category；Client 逻辑主要依赖稳定 `error.code`。
