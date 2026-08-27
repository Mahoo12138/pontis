# 16. Diagnostics、Observability 与 Developer Tools

## 1. 两层视图

普通用户看到：

> 同步是否健康、发生了什么、下一步做什么。

开发者看到：

> epoch/revision、queue、operation、journal、state machine、request correlation。

不要把内部协议术语直接暴露给所有用户。

## 2. User Sync Status

Extension / Web UI：

```text
Personal   已同步
Work       正在同步…
Study      需要处理
```

展开可显示：

- last sync；
- local pending count；
- remote apply backlog；
- server connectivity；
- actionable recovery message。

Machine code 与用户文案分离。

## 3. Derived Binding Health

可根据真实状态计算：

```text
HEALTHY
SYNCING
DEGRADED
ACTION_REQUIRED
OFFLINE
ERROR
```

不必把 health 再作为独立 Source of Truth 存数据库。

## 4. Advanced Diagnostics

显示：

```text
Binding state
Epoch
Applied Revision
Received Revision
Server Revision
Journal Floor
Pending Ops
Remote Queue
Expected Mutations
Last Error
Last Successful Sync
```

安全动作：

- Sync now；
- Integrity Scan；
- fetch server state；
- export diagnostic bundle。

危险的 `Clear Mapping/Reset Revision` 不应放普通 UI。

## 5. Developer Inspector

可包含：

```text
Bindings
Pending Operations
Remote Changes
Expected Mutations
Reconciliation Sessions
Journal
ChangeSets
Jobs
```

便于解释具体 Operation Result / Rebase / Conflict。

## 6. Explain This Node

Web UI 可从 Node Activity 展示：

```text
Edge on Windows 将其从 Development 移到 Tools
Web 重命名
Firefox 创建
Organizer 删除
```

用户无需理解 revision 即可回答“为什么书签不见了/跑到这里了”。

## 7. Diagnostic Events

独立于 Activity / Security Audit / Structured Logs。

例：

```text
SYNC_REQUEST_STARTED
SYNC_REQUEST_SUCCEEDED
OPERATION_CONFLICT
REMOTE_CHANGE_APPLY_FAILED
EXPECTED_MUTATION_TIMEOUT
INTEGRITY_MISMATCH_FOUND
RECOVERY_REQUIRED
RECOVERY_COMPLETED
MOUNT_MISSING
```

默认只保存必要 metadata，不存完整 private URL/title。

## 8. Correlation ID

每个 HTTP request 有 `request_id`，贯穿：

- HTTP logs；
- sync service；
- operation receipts；
- journal metadata；
- diagnostics。

用户错误页可展示 Request ID，方便定位日志。

## 9. Structured Logging

Go 使用 structured fields：

```text
level
component
event
request_id
user_id
device_id
binding_id
space_id
revision
duration
error_code
```

日志输出 stdout/file，不把所有日志复制 SQLite。

## 10. Diagnostic Bundle

主动导出脱敏 ZIP：

```text
system.json
server.json
device.json
binding.json
recent-errors.json
recent-diagnostics.json
redacted-state.json
```

默认排除：

- password；
- session/api/device token；
- SMTP/S3/WebDAV secret；
- full bookmark URL/title。

可以由用户显式选择是否包含更多 Bookmark 内容。

## 11. System Health

Admin 可查看：

- database；
- scheduler；
- jobs；
- SMTP；
- backup providers；
- journal GC；
- DB/WAL size；
- migrations/build version。

System Health 不等于浏览用户 Private Content。

## 12. Telemetry

默认：

```text
No external telemetry
No analytics upload
No crash upload
```

OpenTelemetry / Prometheus / Sentry 仅作为管理员显式配置的可选 integration。

Metrics 避免 high-cardinality/sensitive labels，如 URL、title、个人用户名。
