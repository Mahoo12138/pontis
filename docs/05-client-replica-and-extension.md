# 05. 浏览器扩展与本地 Replica

## 1. MV3 的设计前提

扩展后台不是可靠常驻进程。

> Service Worker 可以在几乎任意 await / callback 之间被暂停或杀死。

因此：

- 内存只能做 cache；
- IndexedDB 才是同步状态 Source of Truth；
- 所有长流程必须可 checkpoint / resume；
- 正确性不能依赖 persistent WebSocket。

## 2. Extension 模块

```text
Browser Adapter
Event Processor
Local Replica Store
Sync Coordinator
Remote Change Applier
Integrity Reconciler
Reconciliation State Machine
UI (Popup / Settings / Recovery)
```

核心同步逻辑不能直接散落 `chrome.bookmarks.*` 调用，应通过 Browser Adapter 隔离 Chrome/Edge/Firefox 差异。

## 3. Storage 分工

### `browser.storage.local`

只存少量 bootstrap：

```text
server_url
server_instance_id
device_id
device_token
basic preferences
```

不使用 `browser.storage.sync` 保存任何 Replica State 或 Secret。

### IndexedDB / Dexie

核心本地数据库：

```text
bindings
binding_roots
local_nodes
pending_operations
remote_changes
expected_mutations
reconciliation_sessions
deferred_local_events
cross_space_transfers
local_safety_snapshots
diagnostic_events
```

## 4. Local Mirror 与 Mapping

V1 可合并成 `local_nodes`：

```text
binding_id
canonical_id
browser_id

type
title
url
parent...
position
```

Unique：

```text
(binding_id, canonical_id)
(binding_id, browser_id)
```

这同时表达：

- Canonical ↔ browser identity mapping；
- Extension 对 Browser 当前状态的 last-known mirror。

Browser Tree 才是真实本地状态，Mirror 可以通过 Integrity Scan 修复。

## 5. Pending Operation Outbox

Browser local event 非 remote expectation 时：

```text
Browser Event
→ Generate op_id UUIDv7
→ Allocate client_seq
→ base_revision = binding.applied_revision
→ Transaction:
   update mirror
   insert pending op
→ Kick sync
```

Mirror + Pending 应尽量在同一个 IndexedDB Transaction 中提交。

Pending 状态建议：

```text
QUEUED
RESOLVED
SETTLED
```

HTTP 成功不代表 Pending 可以立即删除。

## 6. Remote Change Inbox

`/sync` response 不应直接从内存 apply Browser API。

正确流程：

```text
HTTP Response
→ IndexedDB Transaction:
   persist operation results
   persist remote changes
   advance received_revision
→ commit
→ Remote Change Applier
```

若 worker 在 response persistence 中途被杀，整个 transaction rollback，Server 可重新发送。

## 7. 严格串行 Apply

同一 Binding 的 Canonical Change 必须按 revision 严格串行。

例如：

```text
101 MOVE child out of folder
102 DELETE folder
```

若 102 先于 101，浏览器递归删除会错误吞掉 child。

V1 不为少量性能收益并行 Apply revisions。

## 8. Expected Remote Mutation

Server Change 调 Browser API 会触发 browser event。

禁止使用：

```text
suppressEvents = true
```

正确做法：

```text
Persist Expected Mutation
→ call Browser API
→ Browser Event
→ exact match expectation
→ update mirror, no local op
```

Expectation 必须持久化，且**在调用 Browser API 之前写入**。

## 9. CREATE 的两阶段 Expectation

CREATE 前不知道 Browser ID，因此 expectation 先按：

- canonical_id；
- parent；
- title/url；
- position；
- operation/revision

持久化为 provisional。

Browser API / event 返回 browser_id 后 resolve。

若产生歧义，不猜，进入 targeted Integrity Reconciliation。

## 10. Ensure-State 幂等 Apply

远程 Change / Reconciliation Step 不应理解成“必须执行命令一次”，而是：

> Ensure Browser 达到 Canonical target state。

例如 `bookmarks.move` 已成功，但 worker 在 checkpoint 前 crash：

```text
restart
→ probe Browser
→ target state already satisfied
→ mark change applied
```

## 11. applied_revision

只有 Browser State 实际确认后才能推进。

```text
remote 101 applied
remote 102 applied
remote 103 pending
```

则：

```text
applied_revision = 102
```

即使 103 已经 received。

## 12. Move → before_id

Browser API 通常提供 parentId + index，Server Protocol 使用 ParentRef + before_id。

收到 `onMoved` 后建议重新读取 new parent children，按事件完成后的真实 sibling order，寻找下一个 syncable Canonical sibling：

```text
before_id = next sibling canonical ID
```

无下一个 sibling → null append。

Firefox Separator 在计算时跳过，保持 local-only。

## 13. Event Capture 永远不能暂停

即使 Binding 正在 Initial / Resync / Recovery：

- Normal network sync 可以 pause；
- Browser Event Capture 不能 pause。

Reconciliation 中真实用户操作记录为 Deferred Local Events / dirty region，最终对当前 Browser State 做 targeted reconciliation，不机械 replay 陈旧 event sequence。

## 14. Periodic Integrity

Normal path：browser events。

兜底 path：Integrity Reconciliation。

触发：

- startup；
- upgrade；
- abnormal previous shutdown；
- expected mutation timeout；
- Browser API anomaly；
- periodic（如 daily）；
- user manual check。

如果少量 mapped node 漂移，可产生对应 Local Operation。

如果 Mapping 大面积丢失，不能生成成千上万 CREATE，应进入 Mapping-lost Recovery。

## 15. 网络触发

V1 不依赖 persistent WebSocket。

Sync Trigger：

- local event + debounce；
- browser.alarms periodic wake；
- extension startup；
- UI open；
- manual sync。

未来 Push 只能作为低延迟优化，不能是 correctness dependency。

## 16. 四条 Crash Consistency Rule

1. Local Browser Event：Mirror + Pending 尽量同一 IDB Transaction。
2. Remote mutation：Expected Mutation 必须先持久化，再 Browser API。
3. Server response：Remote Changes 持久化成功后才推进 received revision。
4. Browser state confirmed 后才推进 applied revision。
