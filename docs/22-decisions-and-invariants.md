# 22. 关键决策、不变量与术语表

## A. Architecture Decisions

| 主题 | V1 决策 |
|---|---|
| Canonical authority | Server |
| Client | Offline-capable replica |
| Sync | Operation-based `/sync` |
| Event Sourcing | No |
| Current State | SQLite canonical nodes |
| Incremental history | Short-lived Journal |
| Node Identity | UUIDv7 |
| Browser IDs | Client-local only |
| Node types | Folder / Bookmark |
| Ordering | integer position storage + before_id wire |
| Sync primitives | CREATE/UPDATE/MOVE/DELETE |
| UPDATE | one field per operation |
| DELETE Folder | recursive |
| Space owner | exactly one user |
| Shared collaborative Space | No V1 |
| Admin private content access | No product-level implicit access |
| Full Sync | whole profile ↔ one Space |
| Partial Sync | multiple non-overlapping folders ↔ multiple Spaces |
| Same Space multiple mounts | No V1 |
| Cross-space drag | atomic high-level transfer |
| Initial matching | strict parent-aware exact matching |
| URL normalization in sync | Never |
| Full Resync identity | Canonical UUID mapping |
| Recovery | protect new data, review stale destructive intent |
| Search V1 | scoped SQLite substring first |
| Backup | logical per-Space snapshot |
| Whole-space restore | epoch change |
| Job queue | SQLite persistent jobs |
| Scheduler | persistent SQLite state |
| Job delivery | at least once |
| Undo | new inverse ChangeSet, never revision rollback |
| Telemetry | off by default |
| Backend | Go + chi + SQLite + handwritten SQL |
| ORM | None |
| Frontend | TS + React18 + TanStack Router/Query + Mantine + Vanilla Extract |
| Extension | TS + WXT + Dexie |
| Repository | monorepo server/web/extension/packages |
| Web production | dist embedded into Go binary |

## B. Sync Invariants

1. Canonical State + Revision + Journal + Receipt 必须原子提交。
2. 一个 Space 的 Canonical Changes 有严格线性 revision 顺序。
3. Client Operation 通过 op_id 幂等。
4. Canonical Change 通过 `(epoch, revision)` 唯一。
5. received_revision 只能推进到已经完整持久化的连续 Inbox。
6. applied_revision 只能推进到 Browser 实际确认的连续 Changes。
7. HTTP success 不等于 Pending 可删除。
8. same Binding Canonical Change 严格按 revision 串行 Apply。
9. DELETE 不允许 stale UPDATE/MOVE resurrection。
10. offline-created new data 不得静默丢失。
11. normal incremental identity 永远基于 Canonical UUID，不使用 URL 重新识别。
12. active reconciliation 时 network sync 可暂停，但 local Browser Event Capture 不能暂停。
13. old-epoch Pending 不得原样 replay。
14. Full/Initial/Recovery Verify 成功后才进入 ACTIVE。
15. Server committed reconciliation 不因 Browser apply failure 回滚 Server。

## C. Domain Invariants

1. 每个 Node 恰好属于一个 Space。
2. 每个 Node 恰好一个 ParentRef：Node 或 RootSlot。
3. Parent Node 必须 Folder。
4. Node type immutable。
5. Bookmark url 非 NULL；Folder url NULL。
6. Folder 不能 parent=self/descendant。
7. Ordering 是用户数据。
8. Sibling position renumber 不代表 sibling semantic move。
9. Canonical Tree mutation 不可绕过 Domain Executor。

## D. Privacy / Security Invariants

1. Private resource exactly one owner。
2. Admin role ≠ private bookmark reader。
3. Token authority ⊆ owner user authority。
4. Device Credential 只作为该 Device Replica。
5. Cross-user content transfer 必须显式通过 Publication Copy。
6. Resource ID 永远不是 authorization capability。
7. Bookmarklet 不得在 Web UI Origin 执行。
8. Diagnostics/Logs 默认不记录完整 private URL/title/secrets。
9. Host/proxy headers 默认不可信。
10. Logical Bookmark Backup 不包含 Server credentials。

## E. Retention Invariants

1. Journal/Tombstone/Receipt 共享历史安全边界。
2. Old offline Device 不无限阻止 Journal GC。
3. Backup 是用户资产，不按普通 Job retention 粗暴删除。
4. 新 Backup 成功后才执行 retention cleanup。
5. Protected Backup 永不自动删除。
6. 最后一份成功 Backup 不自动删除。
7. Undo retention 与 Journal retention 独立。

## F. 术语

### Canonical Tree
Server 权威 Bookmark Tree。

### Sync Space
独立 Canonical Bookmark universe。

### Device
一个 Browser Profile 中的一次 Extension Installation。

### Binding
Device × Space 的同步状态单元。

### Mount
Client-local browser folder/root 与 Binding 的映射。

### Operation
Client 提交的本地意图。

### Canonical Change
Server 已提交的权威事实。

### Journal
可 GC 的 Canonical Change 增量历史。

### Tombstone
记录近期已删除 Canonical Node identity 的同步辅助数据。

### Receipt
Client Operation 幂等处理记录。

### ChangeSet
面向用户业务语义的一次 Canonical 修改集合。

### Reconciliation
两个 Tree/Replica 在非普通增量情境下重新建立一致性的流程。

### Initial Sync
第一次建立 Browser ↔ Canonical identity。

### Full Resync
identity 可信但增量 continuity 断裂时重新建立 baseline。

### Recovery
continuity/identity 有风险且存在可能丢失本地数据时的保守重建流程。

### Publication
用户显式发布的独立分享树快照/版本，不是 Private live reference。

### Safety Backup
高风险操作前系统自动生成的短期保护备份。
