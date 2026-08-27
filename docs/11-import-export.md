# 11. Import / Export

## 1. Backup 与 Import/Export 不同

### Backup

恢复系统的历史状态：

- Full restore 保留 Canonical UUID；
- new epoch baseline；
- 面向灾难恢复。

### Import

把外部内容复制/合并到当前世界：

- new content 生成新的 Canonical UUID；
- 不把外部 ID 当 Canonical identity；
- 面向迁移/添加内容。

### Export

Side-effect free，不产生 revision/journal。

## 2. V1 格式

支持：

```text
Netscape Bookmark HTML
Native Portable Bookmark JSON
```

## 3. Native Portable JSON

文件中的 ID 仅用于表达树内 parent relation，是 file-local identity，不是 Canonical UUID。

支持 Export Scope：

- single Bookmark；
- Folder subtree；
- RootSlot；
- entire Space。

Native JSON 可以保留 RootSlot 语义。

## 4. Netscape HTML

V1 重点读取：

```text
title
url
folder hierarchy
order
```

可忽略或降级：

- ADD_DATE；
- LAST_MODIFIED；
- ICON；
- tags；
- separator。

Unsupported 在 Preview 中 warning。

HTML 无法完整表达 Canonical RootSlot 时，可导出为普通顶层 folders。

## 5. URL

Import 层不做 URL normalization。

保存 raw URL，包括 bookmarklet/custom scheme（通过必要结构校验后）。

是否允许 Web UI 点击属于前端安全策略，而不是 Import identity policy。

## 6. Target 与 Strategy

Import 用户选择：

```text
Target Space
Target node/root
Merge | Replace
child | contents
```

Merge/Replace 的语义与 Publication/Reconciliation 一致。

## 7. Matching

第一次 Import 使用保守 ExactTreeMatcher：

- matched parent；
- Folder exact title + unique；
- Bookmark exact raw URL + unique；
- ambiguous 不猜。

Matched Target 保留现有 Canonical UUID。

SourceOnly 生成新 Canonical UUID。

## 8. Preview First

Import 永远先：

```text
Parse
→ Validate
→ Plan
→ Preview
```

Preview 至少展示：

```text
create
update
move
delete
keep
ambiguous
unsupported
```

Plan 绑定 target epoch/revision；确认时 stale 则重新 Preview。

## 9. Whole-Space Replace

对整个 Space Replace：

```text
Pre-Backup
→ new epoch baseline
```

普通 subtree Replace 是 normal revisions。

## 10. Parser Safety

设置边界：

- max upload size；
- max node count；
- max title/url length；
- max tree depth；
- invalid parent/cycle detection。

避免恶意文件造成内存/stack/DB abuse。
