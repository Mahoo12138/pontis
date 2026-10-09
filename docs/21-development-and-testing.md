# 21. 开发顺序、测试策略与 syncsim

## 1. 开发原则

先验证 Domain/Protocol correctness，再写 Browser UI。

不要一写出 `/sync` 就立刻冲去做 Chrome Extension。

## 2. 推荐实现顺序

### Phase 1 — Foundation

- Go monorepo/server skeleton；
- config；
- SQLite driver；
- migrations；
- logging/error model；
- ID/time helpers。

### Phase 2 — Canonical Core

- SyncSpace；
- RootSlot；
- Node repository；
- CREATE / UPDATE / MOVE / DELETE；
- tree validation/order。

### Phase 3 — Revision History

- revision allocation；
- journal；
- tombstone；
- ChangeSet / Undo snapshot。

### Phase 4 — Auth / Device

- setup/user/session；
- Device registration；
- Binding；
- Receipt。

### Phase 5 — Sync Engine

- operation envelope；
- conflict dimensions；
- causality；
- rebase；
- `/sync`。

### Phase 6 — syncsim

- fake replicas；
- multi-device concurrent operations；
- crash/network injection；
- convergence checks。

### Phase 7 — Reconciliation

- matcher/planner；
- Initial；
- Full Resync；
- Recovery；
- snapshots/artifacts。

### Phase 8 — Extension

- WXT；
- Browser Adapter；
- Dexie local replica；
- event capture；
- remote apply；
- recovery UI。

### Phase 9 — Web/product modules

- Bookmark Explorer；
- Organizer/Search；
- Backup；
- Publication/Plaza；
- Diagnostics。

## 3. Pure Algorithm Tests

`canonical/sync/reconcile` 尽量可以纯 Go test，不启动 HTTP/SQLite（除 repository-specific code）。

重点：

- cycle rejection；
- same-field conflict；
- different-field merge；
- same-binding causal ordering；
- stale anchor rebase；
- exact matcher ambiguity；
- LIS reorder；
- protected descendant replace planning。

## 4. SQLite Integration Tests

不要 Mock SQLite。

使用 temporary database + real migrations 验证：

- foreign keys；
- transaction rollback；
- WAL/locking；
- revision allocation；
- journal/receipt atomicity；
- recursive CTE delete；
- cross-space transfer；
- migration upgrade。

## 5. 第一个核心 Tree Test

建议最早做：

```text
Create:
main
├── Development
│   ├── GitHub
│   └── Go
└── Reading

Move GitHub → Reading
Delete Development

Assert:
Reading/GitHub survives
Go deleted
Development deleted
Journal continuous
Tombstones correct
```

随后：

- move folder under descendant → TREE_CYCLE + rollback + revision unchanged；
- recursive delete → descendant tombstones + one top-level canonical DELETE；
- sibling reorder → only moved semantic node structure_revision changes。

## 6. syncsim

建议作为一等开发工具：

```text
Fake Server
├── Fake Edge
├── Fake Firefox
└── Fake Web UI
```

Fake Browser 模拟：

- Browser tree；
- mirror；
- pending outbox；
- remote inbox；
- applied/received watermark；
- crash/restart。

## 7. Fault Injection

随机插入：

```text
network drop
duplicate request
response loss
client crash
server restart
delayed apply
offline editing
out-of-order client arrival
```

关键 crash point：

- before/after SQLite commit；
- Server commit before response；
- client response before IDB commit；
- expectation persisted before Browser API；
- Browser API success before checkpoint；
- change applied before watermark advance。

### 并发交错

一次请求的"检查"与它的"落库"之间，另一个写入者可以提交。syncsim 用同一个 SQLite 文件的第二个连接，在一次 round 的指定读取点之后提交这些写入：Restore 换 epoch、Journal GC 抬 floor、另一个 Device 的 CREATE 落在 Snapshot 的两次读取之间、round 结束时的水位写失败。因此每条边界测试断言的是实际发生过的交错，而不是理论上可能的交错。

## 8. Protocol Invariants

最终 bring all replicas online 并 drain queues 后：

```text
Browser Canonical Projection
== Server Canonical Tree
```

除非存在明确 unresolved conflict/recovery。

并保证：

> 所有 offline-created new data 要么存在于 Canonical Tree，要么存在明确 recovery/conflict record，绝不静默消失。

## 9. Golden Protocol Fixtures

Go 与 TypeScript 共用 JSON fixtures：

```text
sync-request-v1.json
sync-response-v1.json
sync-response-empty-v1.json
operation-create-v1.json
operation-move-v1.json
error-epoch-mismatch.json
reconcile-client-snapshot-v1.json
reconcile-server-snapshot-v1.json
reconcile-snapshot-nodes-v1.json
reconcile-session-planned-v1.json
reconcile-steps-v1.json
reconcile-session-completed-v1.json
```

双方同时验证 encode/decode，防 wire schema 漂移。

对账生命周期的 golden 文件由 Go 的 wire DTO 生成，TypeScript 一侧有两处读取
同一批文件：`packages/protocol` 的共享 codec，以及扩展真正收线时用的边界校验
器（`parseReconciliationEnvelope`/`parseSteps`/`parseServerSnapshotPage`）。
只有后者通过，才说明扩展实际会收到的那份 JSON 是可用的。

## 10. Web / Extension Tests

Web：

```text
Vitest
React Testing Library
Playwright E2E
```

Extension Core：Vitest + Fake Browser Adapter/Dexie test DB。

真实 Chromium extension integration 可后续用 Playwright loading unpacked extension。

## 11. Release Testing

Release 前至少：

- new install bootstrap；
- migration from previous schema；
- web dist embedded serving；
- Docker data persistence；
- Full + Partial Binding；
- duplicate request / lost response；
- epoch restore + recovery；
- backup restore validation。
