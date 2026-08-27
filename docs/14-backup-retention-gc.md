# 14. Backup、Retention 与 GC

## 1. Retention 原则

不是“数据老了就删”，而是：

> 数据什么时候已经不再承担正确性或用户资产责任。

分类：

```text
Sync correctness:
  Journal / Tombstone / Receipt

Operational temporary:
  Job Results / Plans / Artifacts

User assets:
  Backup
```

## 2. Journal Floor

若：

```text
current_revision = 18300
journal_floor_revision = 12000
```

表示客户端 `received_revision >= 12000` 时 Server 保证能继续提供后续连续 changes。

Journal 保存约：

```text
12001 ... 18300
```

## 3. Journal Retention

建议双重最低保障：

```text
至少最近 30 天
至少最近 50,000 revisions
```

只有一条 journal 同时超出两个保障窗口才可 GC。

具体数字配置化，但协议关系固定。

旧 Device 不阻塞 GC。超出窗口的 Device 走 HISTORY_EXPIRED → Full Resync/Recovery。

## 4. Tombstone

Tombstone 生命周期与 Journal Floor 绑定：

```text
deleted_revision <= journal_floor_revision
→ GC eligible
```

不再单独定义“保留 90 天”。

## 5. Operation Receipt

Receipt 即使 Operation 没产生 revision，也保存：

```text
processed_at_revision
```

GC 条件：

```text
processed_at_revision <= journal_floor_revision
```

这样 Receipt 不会早于 Server 仍支持的同步历史被删除。

Revoked Device receipts 可在 grace period 后更积极 GC。

## 6. Old Epoch

Epoch switch 后旧 journal/tombstone 不再参与 sync correctness。

可：

- 立即 GC；或
- 保留约 7 天作为诊断窗口。

V1 建议短期保留诊断，再清理。

## 7. Job Retention

Job Summary 与 Detailed Result 分离：

```text
Job Summary       ~90 days
Detailed Results  ~30 days
```

Duplicate scan / preview plan 可更短：

```text
Duplicate scan       7~30 days
Tree preview/plan    hours, max ~24h when uncommitted
Export temp file     ~24h
Diagnostic events    ~7 days
```

Committed Reconciliation 不能按普通 Plan retention 清理。

## 8. Backup 是用户资产

Backup 不受通用 Job GC 直接删除。

分类：

```text
manual
scheduled
safety
```

### Manual

默认永久，直到用户删除。

### Scheduled

按 Backup Retention Policy。

### Safety

由高风险操作自动创建，例如：

- pre restore；
- pre whole-space replace；
- pre destructive import。

默认约 30 天，可用户 Protect/Pin 转长期保留。

## 9. Backup Retention Rules

硬规则：

1. 自动 retention 永远不删除最后一份成功 Backup；
2. 新 Backup 成功并校验后再删旧 Backup；
3. Protected Backup 永不自动 GC。

简单模式 V1：

```text
keep last N successful scheduled backups
```

Smart tiered retention 可作为高级模式后续实现。

## 10. Backup Provider 删除

Remote delete 失败时不能先从 catalog 消失。

状态：

```text
delete_pending
delete_failed
```

Retry，Provider 确认删除后再清 catalog。

用户手工删除 Remote Object 时，restore/verify 标记：

```text
missing
```

## 11. Logical Bookmark Backup

Backup unit = one Sync Space。

包含：

- durable Space metadata；
- root slots；
- canonical nodes；
- stable Canonical UUIDs；
- ordering；
- future durable bookmark fields。

不包含：

- journal；
- tombstone；
- receipts；
- devices/mappings；
- applied revisions；
- search index；
- jobs；
- provider credentials。

建议 archive：

```text
manifest.json
space.json
nodes.json
+ compression
```

## 12. Restore

Full Space Restore：

1. create pre-restore safety backup；
2. validate checksum/schema/tree；
3. replace root_slots/nodes；
4. epoch++；
5. revision=0；
6. clear/reseed sync history baseline；
7. bindings require resync/recovery。

保留 Canonical UUID，因为是在恢复同一个历史世界。

Partial recovery/import from backup 生成 new UUID，因为是 copy 到当前世界。

## 13. SQLite File Size

DELETE 后 SQLite 文件不必立即缩小，free pages 可复用。

不要每次 GC 后 VACUUM。

可定期 controlled checkpoint / incremental vacuum 或管理员手工 Compact。
