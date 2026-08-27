# 10. Plaza / Publication 分享模型

## 1. 核心原则

Publication 不是 Private Space 的 live view，也不是共享 ACL。

> 用户明确从自己的 Bookmark Tree 发布一个独立、版本化的 Share Tree。

Private Space 后续变化不会自动进入 Publication。

## 2. 三层概念

```text
Private
Published
Imported
```

不存在 cross-user shared canonical node。

## 3. Publication 输入

用户可发布：

- 单 Bookmark；
- Folder subtree；
- entire Space。

三者统一为 `Publication Tree`。

单 Bookmark Publication 只是只有一个 Bookmark node 的树。

## 4. Publication Identity

Published nodes 使用自己的稳定 `publication_node_id`。

明确不同于：

```text
Source Canonical UUID
Consumer Canonical UUID
```

Publication version 更新时尽量保持 Publication Node identity，从而支持 Consumer 更新 mapping。

## 5. 数据最小化

Publication Tree 只包含必要信息：

```text
type
title
url
parent/order
```

Publication metadata 可包含：

- title；
- description；
- publisher；
- created/updated；
- version；
- visibility。

不得发布：

- private canonical UUID；
- revision；
- device；
- private note/tag/cache；
- internal diagnostics。

## 6. Visibility

V1 推荐：

```text
private
plaza
```

未来可增加：

```text
public_link
```

`/p/<slug>` 是 Publication address，不演化成通用短链服务。

## 7. Publisher Update

Publisher 显式选择任意自己的 Space node/subtree/space 更新某个 Publication。

不要求来自最初 source。

支持：

```text
Merge
Replace
```

Source wins for matched content。

## 8. Consumer Apply

用户选择：

- Target Space；
- Target folder/root；
- Merge / Replace；
- child / contents placement。

首次 Apply 使用 ExactTreeMatcher。

后续从 Publication 新 version 更新时使用 Publication Import Mapping，而不是重新 URL/title 猜 identity。

## 9. Publication Import Mapping

```text
PublicationImport
  ├── publication_id
  ├── last_version
  ├── target
  └── strategy

PublicationNodeID ↔ Local CanonicalNodeID
```

用户本地修改 imported node 后再显式更新 Publication，V1 Source wins，但 Preview 显示变化。

不做复杂 three-way merge。

## 10. Whole-Space Replace

如果 Publication Apply Replace 的 Target 是整个 Space root：

```text
Pre-Safety Backup
→ baseline replacement
→ epoch++
→ revision=0
→ all clients resync/recovery
```

Whole-Space Merge 和 subtree Replace 都可以作为普通 Domain Transaction / ChangeSet。

## 11. Plaza Search

Private Search 与 Plaza Search 必须产品上和物理索引上分离。

Plaza search unit 是 Publication，不是内部 Publication Node。

可检索：

- Publication title/description；
- publisher；
- published folder titles；
- published bookmark titles/URLs。

内部 node 命中时聚合到 Publication，并显示 matching snippet/path。

只有显式 Publication Snapshot 数据进入 Plaza index。

## 12. 安全

Publication 内容永远视为不可信输入。

Import Publication 不得主动访问其中 URL。

`javascript:` Bookmarklet 可以存储/导入，但 Web UI 不得在自身 Origin 执行。
