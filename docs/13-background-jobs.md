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

## 4. Scheduler

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

## 5. Timezone

Schedule 必须绑定 IANA timezone，而不是创建时一次性转换固定 UTC offset。

这样 DST 地区仍然保持“每天当地 03:00”的语义。

## 6. Scheduler Source of Truth

`next_run_at` 在 SQLite 中持久化。

Go Timer 仅用于 wake optimization，不是真相。

Server shutdown 期间 missed occurrence：

> 默认 coalesce 成一个 catch-up Job。

离线 30 天不补跑 30 个 Daily Backup。

## 7. Schedule Idempotency

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

## 8. Worker Claim + Lease

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

## 9. At-Least-Once

不追求通用 Exactly Once Job Execution。

Handler 应尽量幂等。

例如 Backup object key 包含 job_id，使 retry 写同一个 object。

SMTP 极端 crash 情况可能重复发送一封邮件，可接受，不为此引入分布式事务。

## 10. Error Classification

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

## 11. Worker Class Concurrency

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

## 12. Cancellation

Cooperative cancellation：

```text
cancel_requested_at
+ context cancellation
```

Handler 在安全 cancellation point 检查。

禁止“杀 goroutine”。

短 Canonical commit transaction 一旦开始不应半途 cancel。

## 13. Progress

支持：

```text
current
total
phase
message
```

不是所有任务都有可靠百分比，phase 比伪精确 percentage 更有价值。

## 14. Backup Job

分成：

```text
Phase 1: Capture Canonical snapshot
Phase 2: Compress/encrypt/upload
```

外部上传绝不持有 SQLite Canonical transaction。

## 15. Link Check Resume

为长 LinkCheck 先创建 job_items snapshot：

```text
node_id + checked_url + status
```

Crash 后继续 `status=pending`，不从头扫描。

## 16. Email

Password Reset / Verify / Invite 等邮件走 Job Queue，不让 HTTP request 同步等待 SMTP。

Email payload 避免长期存完整 sensitive token/body；使用 template + safe data/reference。

## 17. System Maintenance

系统维护 Job：

- journal/tombstone/receipt GC；
- expired session/reset/invite cleanup；
- backup retention fallback；
- temp artifact cleanup；
- optional DB maintenance。

Generic Scheduler 是 infrastructure，不在产品中变成任意 Workflow Builder。
