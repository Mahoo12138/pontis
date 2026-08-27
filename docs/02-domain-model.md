# 02. Canonical Domain Model

## 1. Sync Space

Sync Space 是独立的 Canonical Bookmark Universe。

```text
User
├── Personal Space
├── Work Space
└── Study Space
```

每个 Space 独立拥有：

- owner；
- root slots；
- nodes；
- epoch；
- current revision；
- journal floor；
- tombstones；
- backups；
- bindings。

V1 每个 Space 恰好一个 Owner，不存在 Members / Editors。

## 2. Canonical Node

V1 只有两类：

```text
Folder
Bookmark
```

不将 Browser Root 当成普通 Folder，也暂不支持 Separator。

建议字段：

```text
space_id
id                UUIDv7

type              folder | bookmark
title
url               bookmark 非空，folder 为 NULL

parent_id         Node parent
root_key          RootSlot parent
position

created_revision
title_revision
url_revision
structure_revision
```

### 类型不可变

Folder 不能 UPDATE 成 Bookmark，反之亦然。需要改变类型时应 DELETE + CREATE。

## 3. Parent Tagged Union

协议和 Domain 都用显式 ParentRef：

```json
{"type":"node","id":"..."}
```

或：

```json
{"type":"root","key":"toolbar"}
```

避免以 `parent_id == null` 暗示 Root 的模糊表达。

## 4. Root Slot

Root Slot 是 Canonical Tree 顶部的抽象位置，不是 Node。

可能包含：

```text
main
toolbar
other
mobile
menu
```

浏览器能力不同。Full Sync 时浏览器原生 Roots 可以映射到 RootSlot；Partial Sync 时一个普通 Browser Folder 可以承载整个 Space，并在必要时创建 Local Slot Containers。

Local Slot Container 与 Mount Root 都不是 Canonical Node。

## 5. UUID

Canonical Node ID 使用 UUIDv7。

Browser bookmark ID 永远不能作为 Server Primary Key，也不能进入 Server 数据库。Extension 维护：

```text
Canonical UUID ↔ Browser Bookmark ID
```

## 6. Ordering

排序是用户数据。

Current State V1 使用整数 `position`，Wire Protocol 使用：

```text
before_id
```

`before_id = null` 表示 append。

MOVE 同时承担：

- 跨父目录移动；
- 同父目录 reorder。

不定义单独 REORDER Primitive。

Sibling `position` 重排只改变存储位置，不应错误更新未被语义移动的 sibling `structure_revision`。

## 7. 四个 Sync Primitive

### CREATE

- client 可离线生成 Canonical UUIDv7；
- 指定 node type；
- parent；
- before_id；
- title；
- bookmark url。

### UPDATE

V1 每个 Operation 只更新一个字段：

```text
title
url
```

### MOVE

```text
node_id
parent
before_id
```

### DELETE

只需要 `node_id`。

删除 Folder 永远意味着递归删除整个 subtree。

RESTORE、BATCH、IMPORT、RENAME 都是更高层 Domain Command，不是 Sync Primitive。

## 8. Tree Validity

必须保证：

- parent 与 node 位于同一 Space；
- parent 只能是 Folder；
- Node 不能 parent=self；
- Folder 不能移入自己的 descendant；
- RootSlot 必须存在；
- Bookmark URL 必须非 NULL；
- Folder URL 必须 NULL；
- 每个 node 恰好一个 ParentRef。

Cycle 检查可以从 new parent 向祖先向上遍历。

## 9. Recursive Delete

推荐 SQLite Recursive CTE 收集 subtree。

执行时：

1. 捕获 Undo before-image（若此次操作可 Undo）；
2. 递归收集所有 descendant；
3. 为每个被删 node 写 Tombstone；
4. 删除 nodes；
5. Journal 可以只产生一个顶层 `DELETE folder` Canonical Change。

数据库父 FK 建议 `ON DELETE RESTRICT`，避免绕过 Domain 时数据库偷偷 cascade。
