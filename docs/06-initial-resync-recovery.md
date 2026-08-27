# 06. Initial Sync、Full Resync 与 Recovery

## 1. 三种流程的区别

### Initial Sync

第一次建立 Device × Space Binding，没有可信 Canonical ↔ Browser Mapping。

问题是：**建立身份关系**。

### Full Resync

已有 Mapping 仍可信，但增量 timeline 无法继续，例如 epoch mismatch 或 journal history expired，且没有危险的 local unsynced intent。

问题是：**重新建立 authoritative baseline**。

### Recovery

历史连续性断裂，同时存在 pending local intent，或 Mapping 严重损坏。

问题是：**先保护用户本地数据，再重新建立可信 Replica**。

## 2. Binding State

建议：

```text
UNINITIALIZED
INITIALIZING
ACTIVE
RESYNC_REQUIRED
RESYNCING
RECOVERY_REQUIRED
RECOVERING
MOUNT_MISSING
PAUSED
ERROR
REVOKED
```

Binding 只记录大状态，细 phase 放在持久 `reconciliation_sessions`。

## 3. Persistent Reconciliation Session

关键字段：

```text
id
binding_id
type: INITIAL | FULL_RESYNC | RECOVERY | INTEGRITY
state: RUNNING | WAITING_USER | COMPLETED | FAILED
phase
source_epoch/revision
target_epoch/revision
browser_snapshot_id
server_snapshot_id
plan_id
progress
server_committed
```

一个 Binding 同时只允许一个 active reconciliation。

## 4. Initial State Machine

```text
UNINITIALIZED
→ PREPARE
→ SNAPSHOT_BROWSER
→ FETCH_SERVER
→ ANALYZE
→ WAIT_USER_DECISION (when necessary)
→ PREPARE_PLAN
→ COMMIT_SERVER
→ APPLY_BROWSER
→ VERIFY
→ PROCESS_DEFERRED_LOCAL_CHANGES
→ FINALIZE
→ ACTIVE
```

每个 phase 都必须持久化，MV3 worker 可 resume。

## 5. Initial 四类输入

### Server empty + Browser non-empty

推荐 Browser → Server import，建立 Canonical IDs 和 mapping。

### Server non-empty + Browser empty

Server authoritative initialize Browser。

### 双方 empty

建立 empty baseline。

### 双方 non-empty

默认不自动 destructive merge，提供 Preview：

- Merge；
- Use Server；
- Use Browser；
- Import Browser under a dated/separate folder。

## 6. Initial Exact Matching

只在 already matched parent 下匹配：

- Folder：exact folder title + unique candidate；
- Bookmark：exact raw URL + unique candidate。

不使用：

- title 作为 Bookmark identity；
- URL normalization；
- case-fold/fuzzy folder matching；
- cross-parent MOVE inference；
- ambiguous guess。

Initial Merge 只识别 Match / Create，不自动推断 Rename / MOVE / DELETE。

宁可 duplicate，也不要错误合并。

## 7. Full Resync 判定

例如 `EPOCH_MISMATCH` 或 `HISTORY_EXPIRED`：

```text
No unsynced local intent
→ Full Resync

Has pending/local intent
→ Recovery
```

无 Pending Full Resync 流程：

```text
Local safety snapshot
→ Server canonical snapshot
→ UUID diff
→ Ensure browser target state
→ Verify
→ set new baseline
→ ACTIVE
```

Full Resync 不使用 URL/title identity guessing，依赖已有 Canonical Mapping。

## 8. Snapshot Revision

Server Snapshot 必须绑定明确：

```text
(epoch, snapshot_revision)
```

Client Apply 期间 Server 可以继续写到更高 revision。

完成 Snapshot Apply 后：

```text
applied_revision = snapshot_revision
received_revision = snapshot_revision
```

再正常 `/sync` 拉取 snapshot 之后的新 changes。

## 9. Recovery Snapshot

Recovery 开始前保存：

- Browser Managed Tree；
- Local Mirror；
- Mapping；
- Pending Operations；
- old epoch/revision；
- Deferred Local Events。

这是 Client Emergency Snapshot，不应因流程失败立即清理。

## 10. 跨 Epoch Pending 只是 Intent

Old epoch Operation 不能原样重新提交：

```text
old op_id
old base_revision
old client_seq
```

全部不再代表合法 new-epoch Sync Operation。

它们只是 Recovery Intent；若用户选择重新应用，应在当前 baseline 产生新的 Domain/Sync Operation。

## 11. Recovery Intent Policy

### CREATE

新数据优先保护。Parent 仍存在则建议原位置；否则放：

```text
Recovered/<Device>
```

### UPDATE

不要自动覆盖新的 Server baseline。Preview：keep server / apply local / copy local。

### MOVE

不自动 replay。原 parent 合法时可提供 reapply。

### DELETE

Server wins by default。用户若确实希望再次删除，再显式选择。

总体原则：

> New data auto-preserve；destructive/stale intent requires explicit review。

## 12. Mapping Lost Recovery

如果大量 Browser nodes 没有 Mapping，不要生成大量 CREATE。

进入：

```text
Browser Snapshot + Server Snapshot
→ Conservative Exact Matching
```

Ambiguous 不猜。

## 13. Reconciliation 中的新用户操作

开始 reconciliation 时记录 local event sequence / session ID。

流程中用户操作仍然 capture。最终不要简单 replay stale events，而是把 touched nodes/parents 标记 dirty，然后读取**当前 Browser State**做 targeted reconciliation。

## 14. Verify 是强制阶段

Initial / Resync / Recovery 最后都要重新扫描 managed scope，检查：

- mapping 完整；
- node count sane；
- title/url；
- parent；
- order；
- 无意外额外 canonical node。

只有 Verify 成功才能 `ACTIVE`。

## 15. Server Commit 后 Browser Apply 失败

不做分布式 rollback。

一旦 Server Reconciliation Plan Commit：

> Canonical target 已成为真相。

Browser 失败只意味着 Client 需要继续 resume Ensure-State Apply，直到收敛。
