# 15. Undo 与 Activity History

## 1. Journal ≠ Activity ≠ Undo

### Journal

机器级 Canonical Change history，服务于 sync。

### Activity

用户级业务历史：

```text
“删除了 72 个失效书签”
```

而不是 72 行 journal。

### Undo Data

为某个 ChangeSet 保存足够的 Before Image，用于安全产生 inverse commands。

## 2. Undo 永远不回退 Revision

例如：

```text
102 DELETE Rust
103 CREATE Zig
```

Undo 102 不能让 revision 回到 101。

正确：

```text
104 RESTORE Rust
```

Revision 永远单调。

## 3. ChangeSet

一次面向用户业务语义的操作：

```text
ChangeSet
├── origin
├── actor
├── kind
├── summary
├── first_revision
├── last_revision
└── inverse_of
```

Journal entries 可关联 ChangeSet。

数据库 SQL Transaction、HTTP `/sync` batch、ChangeSet 是三个不同概念。

## 4. UPDATE Undo

保存：

```text
before
expected_after
```

Undo 前检查当前字段是否仍是 expected_after。

若后来已被其他修改：

```text
REVIEW_REQUIRED
```

不强制覆盖新状态。

## 5. MOVE Undo

保存 old parent/order 与 expected post-move location。

如果 node 后来又 MOVE，Undo 不自动把它拖回去。

## 6. CREATE Undo

简单 Bookmark CREATE 若之后未产生需要保护的 dependent data，可 DELETE。

Folder CREATE 如果后来有其他用户/设备新增 descendants，不能 recursive delete 整棵。

进入 Review，保护后续新增数据。

## 7. DELETE Undo

Tombstone 不足以 Undo DELETE。

必须保存完整 deleted subtree Before Image：

- node UUID；
- type/title/url；
- parent/order；
- subtree structure。

Restore 同一个删除节点时保留原 Canonical UUID。

若 original parent 已不存在，fallback 到 Recovery location，而不是丢失恢复内容。

## 8. High-Level Operation

Organizer bulk delete、Import Merge、Publication Apply 等天然作为一个 ChangeSet，可整体 Undo。

Undo 先 Build Plan：

```text
clean
review required
not undoable
expired
```

V1 不提供 Force Undo。

## 9. Whole-Space Restore/Replace

不生成数万个 inverse primitives。

依赖 pre-operation Safety Backup：

```text
恢复到操作前状态
```

实际上执行另一次 Backup Restore → new epoch。

## 10. Activity UI

Space 级入口：

```text
今天 15:21
Edge on Windows
重命名了 GitHub
[撤销]

15:10
失效书签整理
删除了 23 个书签
[撤销]
```

多个 Browser primitives 可在 UI 层做视觉聚合，但底层 ChangeSet identity 不为了 UI 合并。

## 11. Activity 与 Security Audit

Activity：Bookmark/Space data changes。

Security Audit：login/password/token/device/user status/system config。

两套数据、两套 UI。

## 12. Undo Retention

建议：

```text
Activity Summary ~90 days
Undo Data        ~30 days
```

超过 Undo Window 后 Activity 仍可展示，但按钮变为“撤销已过期”。

Undo retention 与 Journal retention 独立，因为 Undo 是在当前 Canonical State 上产生新 commands，不需要 replay old journal。

## 13. Atomic Before Image

只要某操作声明 `undoable=true`，其 Before Image 必须在 Canonical mutation commit 前准备，并与修改一起原子持久化。

不能先 delete commit，再事后保存 Undo Snapshot。
