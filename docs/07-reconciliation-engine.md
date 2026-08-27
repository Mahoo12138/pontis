# 07. Tree Reconciliation / Apply Engine

## 1. 目的

Reconciliation Engine 处理：

> 给定 Source Tree 与 Target Tree，应如何将 Target 转换成目标状态。

使用场景：

- Initial Merge；
- Import；
- Publication Apply；
- Full Resync；
- Mapping-lost Recovery。

它不是 Sync Conflict Engine。

## 2. Pipeline

```text
Source + Target
    ↓
Identity Resolver
    ↓
MatchResult
    ↓
Desired Tree Builder
    ↓
Tree Planner
    ↓
TreeApplyPlan
    ↓
Preview / Validate
    ↓
Executor
```

## 3. Matcher

### ExactTreeMatcher

用于 Initial、file import、first publication apply。

规则：parent-aware / top-down / exact / unique。

### PublicationMappingMatcher

Publication 后续版本更新依赖稳定 PublicationNode ↔ CanonicalNode mapping。

### CanonicalIDMatcher

Full Resync / trusted identity context 使用 Canonical UUID。

## 4. MatchResult

节点状态只有：

```text
Matched
SourceOnly
TargetOnly
Ambiguous
```

Ambiguous 不得猜。

## 5. Merge 与 Replace

### Merge

- Matched：Source state wins；
- SourceOnly：Create；
- TargetOnly：Keep。

### Replace

- Matched：Source state wins；
- SourceOnly：Create；
- TargetOnly：Delete。

Matched Target 保留其 Canonical UUID。

SourceOnly 进入 Private Space 时生成新 Canonical UUIDv7。

## 6. Placement Mode

Import / Publication 支持：

```text
child
contents
```

`child`：Source root 自身作为 Target child。

`contents`：将 Source root 的 children 应用到 Target。

## 7. Planner

应尽量产生语义最小的 Primitive：

- changed field → UPDATE；
- changed parent/order → MOVE；
- source-only → CREATE；
- replace target-only → DELETE。

移动一个 Folder 不应为其 descendants 分别生成 MOVE。

## 8. Sibling Reorder

避免因 `position` 重排生成大量无意义 MOVE。

建议：

1. 将 Current matched sibling order 映射成 Desired index 序列；
2. 对序列求 LIS；
3. LIS 中节点保留；
4. 对其余节点产生必要 MOVE；
5. CREATE 节点直接按最终 before_id 插入。

这样 Planner 与数据库的 integer position 实现解耦。

## 9. Replace 的 Protected Descendant

TargetOnly Folder 可能包含应保留的 Matched descendant。

不能直接 recursive DELETE old folder。

Planner 必须：

1. 识别 protected descendants；
2. 先 MOVE survivors 到 Desired parent；
3. 再 DELETE old TargetOnly subtree。

## 10. Apply Order

内部 dependency graph / topological order 大致：

```text
CREATE parents first
→ UPDATE fields
→ MOVE/reorder
→ DELETE last
```

具体顺序由 dependency planner 决定，不要求用户可见。

## 11. First-Class Plan

`TreeApplyPlan` 应保存：

- target space；
- target epoch；
- target revision；
- strategy；
- operations；
- stats；
- warnings；
- ambiguities；
- plan hash。

用户 Preview 后若 Target 已变化：

```text
PLAN_STALE
```

V1 不自动套用 stale destructive plan。

## 12. Apply Atomicity

Server-generated Tree Plan 与 `/sync` batch 不同。

`/sync` 中每个 Client Operation 可以得到独立 Conflict Result；但一个已确认的 Tree Plan 应作为一个 Domain Transaction all-or-nothing 执行。

Whole-Space Replace 是特殊 baseline replacement，可以逻辑展示 diff，但物理上不必 replay 数万 primitive revisions。

## 13. Organizer 不进入 Matcher

Reconciliation 的 Identity Resolver 必须保守。

“疑似重复 URL”“相似 title”属于 Organizer，而不是 Sync/Import Identity。
