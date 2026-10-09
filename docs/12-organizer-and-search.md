# 12. Organizer 与 Search

## 1. Organizer 原则

Organizer 是：

> Detect / Propose → User Selects → Domain Mutation。

它不能偷偷修改 Canonical Tree。

V1 两个核心能力：

- Link Health；
- Duplicate Detection。

## 2. Link Health

Scope：

- whole Space；
- RootSlot；
- Folder subtree。

异步 LinkCheckJob 就是队列里的一个 `organizer.link_check` Job，organizer 不另设第二套任务系统：

```text
enumerate bookmarks
→ bounded concurrent checks
→ persist results
→ user filters/selects
→ batch delete/update via Domain
```

### Result Classes

主要：

```text
2xx
4xx
5xx
Timeout
Network Error
```

3xx 默认 follow redirects，以 final status 分类，同时记录 redirect info。

### Request Strategy

- HEAD first；
- appropriate GET fallback；
- timeout；
- max redirect；
- bounded response read；
- global concurrency；
- per-host concurrency；
- outbound network policy：Link Check 用服务器自己的网络身份发起，因此默认只允许公网可路由地址。loopback、link-local（云 metadata 所在）、RFC1918/ULA、CGNAT、multicast、6to4/Teredo 一律拒绝，`error_type = ssrf_blocked`；URL 的 scheme 必须是 http/https 且不得带 credentials。域名解析出的每个地址都要校验，校验通过的那个地址才被直接 dial（不再二次解析），每一跳 redirect 都重新校验。管理员可以为受管 LAN 配置 allowlist（`link_check_allow_cidrs` / `PONTIS_LINK_CHECK_ALLOW_CIDRS`），allowlist 只能打开私有段，永远打不开 loopback/link-local 这一层。

404 是正常 LinkCheck Result，不是 Job Failure。

## 3. Link Result 与 Canonical State 分离

建议保存：

```text
job_id
node_id
checked_url
status_class
http_status
error_type
latency_ms
final_url
checked_at
```

`checked_url` 很重要：当前 node.url 改变后，旧 scan 自动判定 stale。

这些是 Derived Data，不进入 Bookmark Backup。

实际落在两张表里（migration 000019）：

- `link_check_runs(job_id, space_id, created_at, finished_at)`：一次运行一行，`job_id` 外键到 `jobs(id) ON DELETE CASCADE`，所以 Job 摘要被保留策略清掉时结果一起消失。
- `link_check_items(job_id, node_id, …, status)`：`(job_id, node_id)` 主键，`status` 只有 `pending`/`checked`。种子写入来自运行开始时的书签快照，重复入队不会重复计数；只有 `checked` 的行才会被读成结果。

运行的 `total` / `done` 都从 items 数出来，不另存一份，因此不会出现进度分母和实际条目不一致。

因此取消、进程重启或 Worker 被抢占都不会丢掉已检查出来的结果：同一个 Job 带 `retry_wait` 回来，只处理仍然 `pending` 的条目。

## 4. Duplicate Detection

### Exact Duplicate

Raw URL 完全相同，title 不影响。

即使位于不同 folders 也列出，但不自动删除，因为 placement 可能有意为之。

### Suspected Duplicate

仅 Organizer 可使用保守 normalization，例如：

- host case；
- default port；
- empty path vs slash；
- common tracking params；
- optional fragment ignore。

不要默认：

- http == https；
- www == bare domain。

每组 suspected duplicate 必须给 reason，例如：

```text
tracking_params_only
trailing_slash_only
default_port_only
```

V1 不用 title similarity 做 Duplicate identity。

## 5. Private Query vs Search

### Query

确定性读取：

- Space；
- Node；
- children；
- subtree；
- root；
- exact raw URL；
- host/domain。

### Search

用户文本查找：

- Folder title；
- Bookmark title；
- raw URL；
- optional derived host。

Scope：

- current subtree；
- current Space；
- all owned Spaces。

绝不搜索其他用户 Private Space。

## 6. V1 不急着 FTS5

先使用 SQLite scoped substring query：

```text
LIKE '%q%'
```

配合正常结构索引和 Go-side simple ranking。

理由：

- 个人书签规模有限；
- 中文/URL/混合文本行为直观；
- 避免一开始维护派生全文索引；
- Search Repository 以后可替换为 FTS5，不影响 Canonical Domain/API。

## 7. Ranking

简单稳定：

```text
title exact
> title prefix
> title contains
> host/domain match
> URL contains
```

Search 返回 Folder + Bookmark，可 filter type。

搜索 folder 名应返回 Folder 本身，不因为 ancestor path 含关键词就返回所有 descendants。

## 8. Path

不在 Canonical Node 上保存 full_path / depth。

Folder MOVE 不应导致 descendants 全部 update/reindex。

Breadcrumb 在查询/展示时通过 adjacency tree 派生。

## 9. Exact Bookmark Lookup

提供 API 查询 raw URL 是否已经 bookmarked：

- current Space；
- all owned Spaces；
- returns count/items/path。

Future 可提供 Organizer-normalized mode，但默认 exact raw URL。
