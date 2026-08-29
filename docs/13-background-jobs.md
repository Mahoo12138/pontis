# 13. 后台任务与调度系统

## 1. 总体选择

不引入 Redis / RabbitMQ。

采用：

> SQLite Persistent Job Queue + Go Worker Pools + Persistent Scheduler。

```text
Domain Action ─────────┐
                       ▼
Schedule → Scheduler → Jobs → Worker → Handler
```

Scheduler 解决“什么时候产生任务”；Job System 解决“任务如何执行”。

## 2. Schedule 与 Job 分离

```text
每天 03:00 Backup Personal
```

是 Schedule。

每天实际触发出的某一次执行是 Job。

手动“立即 Backup”直接创建 Job，不需要 Schedule。

## 3. Job States

```text
QUEUED
RUNNING
RETRY_WAIT
SUCCEEDED
FAILED
CANCELLED
```

字段建议：

```text
id/type
owner_user_id nullable
space_id nullable
status
payload/result/error
priority
progress
attempt/max_attempts
schedule_id/scheduled_for
worker_id/lease_until
cancel_requested_at
scheduled_at/started_at/finished_at
```

Job payload 创建后不可修改。要改变任务语义就 cancel + new job。

### 3.1 Ownership

`owner_user_id` 的语义固定为：

```text
owner_user_id IS NOT NULL
→ User Job / User Schedule

owner_user_id IS NULL
→ System Job / System Schedule
```

用户 API 必须始终按当前用户过滤；管理员运维 API 可读取全局 Job 元数据，但仍遵循私人内容脱敏规则。

删除/暂停 Schedule 不等于取消已经创建的 Job：

- `enabled = false`：停止未来 occurrence；
- 删除 Schedule：停止未来 occurrence，历史 Job 按 retention 保留；
- Cancel Job：只影响该次执行。



## 4. 产品层任务模型：用户任务 ≠ 后台任务

底层 `schedules + jobs + worker` 是统一基础设施，但产品层必须拆成两种不同视图：

```text
普通用户：任务
→ “我要 Pontis 定期或立即帮我做什么？”

管理员：设置 / 后台任务
→ “Server 当前正在执行什么？是否健康？”
```

这不是角色不同导致的同一张 Job 表的简单筛选，而是两个不同产品语义。

### 4.1 用户「任务」页面

Pontis V1 提供独立的用户级「任务」页面，用于聚合当前用户拥有的长期任务和计划执行状态。它是统一观察与管理入口，但**不是通用 Workflow / Cron Builder**。

页面主要展示：

- 正在运行的用户任务；
- 用户创建的计划任务；
- 最近完成 / 失败的执行；
- 暂停、恢复、立即运行、取消当前执行等安全操作。

用户看到的是领域名称，例如：

```text
自动备份
检查失效链接
定期更新发布（若未来支持）
```

而不是内部 Handler 名：

```text
backup.create
organizer.link_check
publication.refresh
```

用户任务页不是所有任务的唯一创建入口。任务配置优先从其所属领域页面创建，例如：

```text
Space / Backup
→ 配置自动备份

Space / Organizer / Link Check
→ 配置定期检查
```

「任务」页面负责跨 Space 汇总和统一管理，并可提供 `+ 新建任务`，但其创建表单必须使用已注册的领域模板，不能暴露任意 `type / payload / cron`。

### 4.2 管理员「后台任务」页面

管理员在：

```text
设置
→ 系统
→ 后台任务
```

查看系统级运行状态，包括：

- queued / running / retry / failed job；
- Worker / Lease；
- 系统维护任务；
- 用户任务的非敏感元数据；
- Error Code / Request ID / Attempt / Duration；
- 必要时执行取消、重试等运维操作。

系统维护任务例如：

```text
journal.gc
receipt.gc
session.cleanup
artifact.cleanup
backup.retention
mail.send
```

管理员页面不得因为能观察 Job 而获得 Private Bookmark 内容读取权限。默认不得展示：

- 私有书签 Title / URL；
- Link Check 的原始 URL 列表；
- 未脱敏 payload/result；
- Secret / Credential。

对用户任务的管理员操作属于运维能力，不等于修改用户的领域配置。V1 管理员可以在必要时取消/重试执行中的 Job，但不直接编辑用户 Schedule 语义；相关操作必须进入 Security / Operational Audit。

### 4.3 Task Definition Registry

为了防止 Generic Job Infrastructure 泄露到产品层，应用层维护一组领域任务定义：

```text
TaskDefinition
- type
- user_visible
- schedulable
- title_key
- handler_class
```

例如：

```text
backup.create
  user_visible = true
  schedulable  = true

organizer.link_check
  user_visible = true
  schedulable  = true

journal.gc
  user_visible = false
  schedulable  = false
```

用户 API 只能创建 `user_visible && schedulable` 的 Task Definition，不能提交任意 Job Type。


## 5. Scheduler

`schedules` 保存：

- type；
- enabled；
- schedule type；
- expression；
- IANA timezone；
- payload；
- next_run_at；
- last_run_at。

产品 UI 不必让普通用户直接写 Cron；可以用 Daily / Weekly / Monthly / custom，内部转换。

## 6. Timezone

Schedule 必须绑定 IANA timezone，而不是创建时一次性转换固定 UTC offset。

这样 DST 地区仍然保持“每天当地 03:00”的语义。

## 7. Scheduler Source of Truth

`next_run_at` 在 SQLite 中持久化。

Go Timer 仅用于 wake optimization，不是真相。

Server shutdown 期间 missed occurrence：

> 默认 coalesce 成一个 catch-up Job。

离线 30 天不补跑 30 个 Daily Backup。

## 8. Schedule Idempotency

Job 保存：

```text
schedule_id
scheduled_for
```

Unique：

```text
(schedule_id, scheduled_for)
```

避免 Scheduler 创建 Job 后、更新 next_run_at 前 crash 导致重复 occurrence。

## 9. Worker Claim + Lease

Worker 不直接 SELECT 然后执行。

使用 claim transaction：

```text
select queued
→ mark running
→ worker_id
→ lease_until
→ commit
```

执行中定期 renew lease。

Process crash 后 expired lease 可 recover/requeue。

## 10. At-Least-Once

不追求通用 Exactly Once Job Execution。

Handler 应尽量幂等。

例如 Backup object key 包含 job_id，使 retry 写同一个 object。

SMTP 极端 crash 情况可能重复发送一封邮件，可接受，不为此引入分布式事务。

## 11. Error Classification

Handler 结果区分：

```text
Success
RetryableError
FatalError
Cancelled
```

例如：

- S3 timeout → retryable；
- SMTP temporary failure → retryable；
- invalid import JSON → fatal；
- Link 404 → normal scan result。

Retry 使用 bounded exponential backoff。

## 12. Worker Class Concurrency

不要让大量 LinkCheck Job 占满所有 worker。

可按 class：

```text
network_scan
backup
email
maintenance
cpu_heavy
```

设并发限制。

Job concurrency 与 Job 内 HTTP concurrency 是两个层次。

## 13. Cancellation

Cooperative cancellation：

```text
cancel_requested_at
+ context cancellation
```

Handler 在安全 cancellation point 检查。

禁止“杀 goroutine”。

短 Canonical commit transaction 一旦开始不应半途 cancel。

## 14. Progress

支持：

```text
current
total
phase
message
```

不是所有任务都有可靠百分比，phase 比伪精确 percentage 更有价值。

## 15. Backup Job

分成：

```text
Phase 1: Capture Canonical snapshot
Phase 2: Compress/encrypt/upload
```

外部上传绝不持有 SQLite Canonical transaction。

## 16. Link Check Resume

为长 LinkCheck 先创建 job_items snapshot：

```text
node_id + checked_url + status
```

Crash 后继续 `status=pending`，不从头扫描。

## 17. Email

Password Reset / Verify / Invite 等邮件走 Job Queue，不让 HTTP request 同步等待 SMTP。

Email payload 避免长期存完整 sensitive token/body；使用 template + safe data/reference。

## 18. System Maintenance

系统维护 Job：

- journal/tombstone/receipt GC；
- expired session/reset/invite cleanup；
- backup retention fallback；
- temp artifact cleanup；
- optional DB maintenance。

Generic Scheduler 是 infrastructure，不在产品中变成任意 Workflow Builder。
