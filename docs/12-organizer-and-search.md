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

异步 LinkCheckJob：

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
- per-host concurrency。

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
