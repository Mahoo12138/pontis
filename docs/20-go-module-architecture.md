# 20. Go 模块架构与依赖方向

## 1. 风格

采用：

> Modular Monolith + Domain-focused packages。

不使用教科书式多层 Clean Architecture 套娃，不构造 `interfaces/` 垃圾场，也不为了未来 PostgreSQL 过度抽象。

## 2. Server 目录建议

```text
server/
├── cmd/server/main.go
├── internal/
│   ├── app/
│   ├── config/
│   ├── canonical/
│   ├── auth/
│   ├── device/
│   ├── sync/
│   ├── reconcile/
│   ├── publication/
│   ├── backup/
│   ├── jobs/
│   ├── organizer/
│   ├── search/
│   ├── mail/
│   ├── diagnostics/
│   ├── httpapi/
│   └── store/sqlite/
└── migrations/
```

## 3. Canonical 是内核

`canonical` 管：

- SyncSpace/RootSlot/Node model；
- ParentRef；
- CREATE/UPDATE/MOVE/DELETE commands；
- validation/order；
- revision；
- journal/tombstone；
- ChangeSet/Undo；
- snapshot。

任何模块修改 Bookmark Tree 最终必须调用 Canonical Executor。

Canonical 不能 import：

```text
sync
httpapi
publication
organizer
```

越核心的模块越不知道外部业务来源。

## 4. Typed IDs

建议轻量类型：

```text
SpaceID
NodeID
DeviceID
BindingID
UserID
```

避免所有参数都是 string 导致传错 ID 编译器无法发现。

不需要复杂 DDD Value Object。

## 5. Domain Model 与 DTO/DB Row 分离

不要让一个 struct 同时承担：

```text
Domain entity
HTTP DTO
DB row
Backup format
Publication format
```

HTTP DTO 由 httpapi/OpenAPI adapter 映射；DB adapter 自己负责 scan/insert；Domain 不依赖 JSON/DB tags。

## 6. Interface 定义在消费者侧

例如 `canonical` 需要 Store，则在 `canonical/repository.go` 定义它需要的最小接口。

`store/sqlite` 自然满足接口。

不创建全局：

```text
internal/interfaces/
```

## 7. SQLite

Domain 不需要知道具体 driver，但项目也不假装未来无成本换 PostgreSQL。

抽象的目的是隔离测试/driver details，而不是 Vendor Independence 宗教。

手写 SQL，特别是：

- Recursive CTE；
- composite FK；
- revision/journal transaction；
- atomic cross-space transfer。

## 8. Canonical Executor

需要支持在同一个 write transaction 中执行多个 domain commands，例如 Organizer batch / Transfer。

同时确保：

```text
Node changes
+ revisions
+ journal
+ tombstone
+ ChangeSet/Undo
+ receipt (sync source)
```

原子提交。

## 9. Sync 包

负责：

```text
ClientOperation
Conflict/Rebase
Receipt
Causality
Sync request orchestration
```

Sync 不直接 SQL UPDATE nodes。

路径：

```text
Client Operation
→ Sync Decision
→ Canonical Command
→ Canonical Executor
```

## 10. Reconcile 包

尽量 pure Go：

```text
tree
matcher
exact matcher
canonical matcher
publication matcher
desired tree
planner
LIS
plan
```

输出 Plan，不直接 HTTP/SQLite/Browser。

## 11. Device 包

负责：

- Device registration；
- credential lifecycle；
- full/partial mode；
- binding lifecycle；
- revoke。

与 Sync protocol logic 分离。

## 12. Auth 包

统一 Principal：

```text
Session
API Token
Device
```

HTTP middleware 只负责 credential → Principal。

Authorization Service 负责资源权限。

## 13. Jobs

Jobs infrastructure 不 import 具体 backup/organizer/mail 业务。

App composition root 注册：

```text
"backup.create" → backup handler
"organizer.link_check" → organizer handler
"mail.send" → mail handler
```

避免 import cycles。

## 14. Backup Provider Interface

这里明确存在多个实现，值得真正抽象：

```text
Put
Get
Delete
List
```

实现 Local/WebDAV/S3/OneDrive。

## 15. HTTP Layer

chi/net/http handler 只做：

```text
decode
authenticate/authorize
call application/domain service
map error
encode
```

Domain Error 不知道 HTTP status。

## 16. Context

所有 blocking/cancellable operation 传 `context.Context` 参数。

不要把 Context 存进 Service struct。

Request ID 等 request-scoped metadata 可通过 Context 传给 logging/diagnostics。

## 17. App Composition Root

`internal/app`：

- open database；
- migrations；
- construct repositories/services；
- register jobs；
- build HTTP router；
- graceful shutdown。

业务逻辑尽量为 0，手写 DI。
