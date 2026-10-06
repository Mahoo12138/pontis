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
| User task surface | 独立「任务」页，聚合用户-owned schedules/jobs；领域页面仍是主要配置入口 |
| Admin task surface | 独立 `管理 / 后台任务` 页面，用于全局 Job/Worker 运维，不得隐藏在系统设置中，不暴露私人书签内容 |
| Generic task builder | No；用户只能创建注册过的领域 Task Definition |
| Job delivery | at least once |
| Undo | new inverse ChangeSet, never revision rollback |
| Telemetry | off by default |
| Backend | Go + chi + SQLite + handwritten SQL |
| ORM | None |
| Frontend | TS + React18 + TanStack Router/Query + Mantine + Vanilla Extract |
| Extension | TS + WXT + Dexie |
| Repository | monorepo server/web/extension/packages |
| Web production | dist embedded into Go binary |
| Settings IA | `设置` 仅承载当前用户个人设置；实例级能力进入独立 `管理` 区 |
| Admin IA | 管理员主导航固定提供 `用户` / `后台任务` / `系统设置` 三个一等入口 |

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

## E. Task / Job Invariants

1. Schedule 与 Job 是两个不同对象：Schedule 决定何时产生 Job；Job 表示一次实际执行。
2. `owner_user_id != NULL` 表示 User Task；`owner_user_id == NULL` 表示 System Task。
3. 用户级「任务」页面只展示当前用户拥有的领域任务，不暴露 Generic Job Infrastructure。
4. 用户任务配置优先归属领域页面；任务中心提供跨 Space 聚合、状态与统一管理。
5. 管理员「后台任务」页面是运维视图，不赋予 Private Bookmark Reader 权限。
6. Pause/Delete Schedule 不自动取消已经创建或正在运行的 Job。
7. 普通用户不能提交任意 Job Type / Payload / Cron，只能使用已注册的 User-visible Task Definition。


## F. Information Architecture Invariants

1. 「设置」表示当前用户自身配置，只包含账户、偏好、API Token 等个人范围内容。
2. 「系统设置」表示实例级配置，只对管理员开放；不得与普通用户设置混在同一个 Tab 组中。
3. 「用户管理」与「后台任务」是独立管理对象，不属于「系统设置」的子按钮或隐藏入口。
4. 管理员登录后，主导航必须出现稳定的「管理」区域，并直接提供 `用户 / 后台任务 / 系统设置` 三个入口。
5. 非管理员完全不渲染「管理」导航，同时 Server API 仍必须执行管理员权限校验；隐藏 UI 不能替代授权。
6. 页面导航必须按“对象/任务”划分，而不是按“谁能访问”把不相关功能塞进「系统」。
7. 允许在系统设置页面提供指向用户管理、后台任务的上下文快捷链接，但快捷链接不能成为这些页面唯一的可发现入口。
8. 用户级「任务」与管理员级「后台任务」必须在命名、路由与页面语义上保持区分。

## G. Retention Invariants

1. Journal/Tombstone/Receipt 共享历史安全边界。
2. Old offline Device 不无限阻止 Journal GC。
3. Backup 是用户资产，不按普通 Job retention 粗暴删除。
4. 新 Backup 成功后才执行 retention cleanup。
5. Protected Backup 永不自动删除。
6. 最后一份成功 Backup 不自动删除。
7. Undo retention 与 Journal retention 独立。

## H. 术语

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
