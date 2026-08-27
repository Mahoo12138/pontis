# 03. Full Sync、Partial Sync、Binding 与 Mount

## 1. Device 的定义

Device 不是物理电脑，而是：

> 一个 Browser Profile 中的一次 Extension Installation。

同一台电脑上的 Edge Profile A、Edge Profile B、Firefox 都是不同 Device。

## 2. Binding

真正的同步状态单元是：

```text
Device × Space Binding
```

每个 Binding 独立拥有：

- epoch；
- applied revision；
- received revision；
- client_seq；
- pending queue；
- remote change queue；
- reconciliation lifecycle。

一个 Binding 出问题不应拖累同 Device 上其他 Space。

## 3. Full Sync

语义：

> 整个 Browser Profile 的书签系统 ↔ 一个 Space。

```text
Browser Favorites Bar ─┐
Browser Other          ├── Personal Space Root Slots
Browser Mobile         ┘
```

规则：

- 一个 Device 最多一个 Full Binding；
- Full Mode 与 Partial Mode 互斥；
- Full Mode 独占该 Profile 的 Bookmark Scope；
- Root Mapping 由 Extension 本地维护。

## 4. Partial Sync

语义：

> 浏览器中的多个独立 Folder 分别绑定多个 Space，其余书签保持 unmanaged/local。

示例：

```text
Favorites Bar
├── PersonalSync  ↔ Personal Space
├── WorkSync      ↔ Work Space
├── StudySync     ↔ Study Space
└── OtherLocal    ← 不受系统管理
```

V1 限制：

- 一个 Space 在一个 Device 上只能 Mount 一次；
- 一个 Mount 对应整个 Space；
- 不做 “同一个 Space 的多个 subtree → 多个 Browser Folder”；
- Mount roots 之间不能存在 ancestor/descendant 重叠。

以后若有需求，可把 Mount Target 从 `Space Root` 扩展成 `Canonical Subtree`，不需要推翻 Binding 模型。

## 5. Mount Root 不是 Canonical Node

Partial：

```text
Favorites Bar
└── PersonalSync   ← Local Mount Root
    ├── GitHub     ← Canonical
    └── Go         ← Canonical
```

`PersonalSync` 本身不上传 Server。

因此：

- Rename Mount Root 只改变本地名称；
- Move Mount Root 到另一个 Browser Root 不改变 Canonical Tree；
- Delete Mount Root 不能解释为 DELETE entire Space。

Mount Root 被删除时：

```text
Binding → MOUNT_MISSING
```

暂停同步并提示：重新创建、重新选择目录或断开绑定。

## 6. 移入 / 移出管理范围

### unmanaged → mounted scope

视为新 CREATE，生成新的 Canonical UUID。

### mounted scope → unmanaged

视为：

```text
Server DELETE
+ Browser 本地节点保留
+ 解除 Mapping
```

即“从同步空间移除，但保留为本地书签”。

Full Sync 不存在“移出 Scope”。

## 7. Cross-Space Drag

Partial 模式下用户可能自然地：

```text
Personal/Folder A
→ 拖入 Work Mount
```

Canonical 语义不是 MOVE，而是：

```text
Personal: DELETE old subtree
Work:     CREATE new subtree with new Canonical UUIDs
```

Browser IDs 可以继续复用，只需重建 Mapping。

因为两个 Space 的独立 `/sync` 可能出现半成功，V1 建议为 Cross-Space Transfer 提供独立的高层原子协议，由 Server 在一个 SQLite Transaction 中：

1. Target Space CREATE subtree；
2. Source Space DELETE subtree；
3. 分别推进两个 Space revisions；
4. 写两个 ChangeSets + 一个 Transfer record；
5. COMMIT。

## 8. Mode 切换

Full ↔ Partial 不是简单修改 enum。

应执行：

```text
Pause
→ Local Safety Snapshot
→ Remove old binding/mount config
→ Configure new mode
→ Initial-like reconciliation
→ Verify
→ Active
```

V1 不在已有 incremental timeline 上热切换 managed scope。
