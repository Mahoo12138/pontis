# 自托管跨浏览器书签同步平台：设计文档集

> 文档状态：V1 Architecture Baseline  
> 更新时间：2026-08-27

本目录记录项目从产品边界、Canonical Tree、同步协议、浏览器扩展、本地副本、Reconciliation、备份、权限、后台任务、数据库、安全到工程技术栈的完整设计。

设计目标不是实现一个“稍微复杂一点的书签 CRUD”，而是实现一个可以长期自托管、支持 Edge / Chrome / Firefox、多用户、多设备、离线修改和稳定恢复的原生书签同步系统。

## 推荐阅读顺序

1. [00-overview.md](./00-overview.md) — 产品定位、核心原则和范围
2. [01-system-architecture.md](./01-system-architecture.md) — 系统总体架构与模块边界
3. [02-domain-model.md](./02-domain-model.md) — Canonical Tree、Node、Space、Root Slot
4. [03-sync-space-and-mounts.md](./03-sync-space-and-mounts.md) — Full / Partial Sync、Binding、Mount
5. [04-sync-protocol.md](./04-sync-protocol.md) — `/sync`、Operation、Change、Revision 与冲突
6. [05-client-replica-and-extension.md](./05-client-replica-and-extension.md) — 浏览器扩展与 IndexedDB 副本
7. [06-initial-resync-recovery.md](./06-initial-resync-recovery.md) — Initial / Full Resync / Recovery
8. [07-reconciliation-engine.md](./07-reconciliation-engine.md) — Tree Matching / Planning / Apply
9. [08-api-contract.md](./08-api-contract.md) — 浏览器插件与 Server 协议接口
10. [09-multi-user-auth-permissions.md](./09-multi-user-auth-permissions.md) — User / Session / Token / Device 权限
11. [10-publication-plaza.md](./10-publication-plaza.md) — Plaza / Publication / Copy 模型
12. [11-import-export.md](./11-import-export.md) — HTML / Native JSON Import / Export
13. [12-organizer-and-search.md](./12-organizer-and-search.md) — 失效链接、重复项、私有搜索
14. [13-background-jobs.md](./13-background-jobs.md) — Job Queue / Scheduler / Worker / Crash Recovery
15. [14-backup-retention-gc.md](./14-backup-retention-gc.md) — Backup、Journal/Tombstone/Receipt Retention
16. [15-undo-activity.md](./15-undo-activity.md) — ChangeSet、Activity、Undo
17. [16-diagnostics-observability.md](./16-diagnostics-observability.md) — Diagnostics / Logs / Support Bundle
18. [17-security.md](./17-security.md) — 安全模型与威胁边界
19. [18-database-schema.md](./18-database-schema.md) — SQLite V1 Schema Baseline
20. [19-tech-stack-and-monorepo.md](./19-tech-stack-and-monorepo.md) — 技术栈、Monorepo 与构建方式
21. [20-go-module-architecture.md](./20-go-module-architecture.md) — Go 模块、依赖方向和核心接口
22. [21-development-and-testing.md](./21-development-and-testing.md) — 开发顺序、测试与 syncsim
23. [22-decisions-and-invariants.md](./22-decisions-and-invariants.md) — 关键决策、不变量与术语表

## 文档约定

- **Canonical State**：Server 上某个 Sync Space 的权威书签树。
- **Device**：一个浏览器 Profile 中的一次 Extension Installation，而非物理电脑。
- **Binding**：`Device × Space` 的独立同步状态单元。
- **Mount**：浏览器中的本地目录/root 与某个 Binding 的映射；浏览器 ID 永不上传 Server。
- **Operation**：Client 对 Canonical World 提交的意图。
- **Canonical Change**：Server 最终已经提交的事实。
- **Journal**：增量同步所需的短期 Canonical Change 历史。
- **ChangeSet**：面向用户业务语义的一次操作，例如“删除 72 个失效书签”。
- **Publication**：由用户明确发布的独立分享树，不是 Private Space 的实时引用。

本文档集以 V1 为基线。V2/V3 能力只有在其边界会影响 V1 数据模型时才预留，不提前实现。
