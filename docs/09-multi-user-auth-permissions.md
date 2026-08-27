# 09. 用户、Session、API Token、Device 与权限模型

## 1. 产品角色

V1 只有：

```text
admin
user
```

不做 RBAC Policy Engine、Group、Workspace、Editor/Viewer。

## 2. User

建议字段：

```text
id
username
username_normalized
display_name
email optional
email_normalized
password_hash
role
status
locale
created_at
updated_at
```

username case-insensitive unique。

Email 可选；引入 SMTP 后可以支持 email verification / reset / invite，但 Server 不应因为没有 SMTP 就无法使用。

## 3. First Setup

当 users=0 时进入 bootstrap setup：

```text
Create first admin
→ mark initialized
→ setup endpoint disabled permanently
```

默认 registration mode 推荐 `closed`。

## 4. Registration Mode

模型：

```text
closed
open
invite
```

V1 UI 可先提供 closed/open，底层预留 invite。

新用户注册后自动创建一个普通默认 Space，降低首次使用门槛。

## 5. Password

使用 Argon2id 存储 hash。

Password Change / Reset 默认应让 Web Sessions 失效，但 Device Credential 与 API Token 是独立凭据，不应在用户只是忘记网页登录密码时自动全部撤销。

可提供“同时撤销所有 API Token / Device”的显式选项。

## 6. Principal

统一认证上下文：

```text
Session Principal
API Token Principal
Device Principal
```

三种 Principal 都关联 User，但权限语义不同。

## 7. Web Session

采用 Server-side opaque session，不用 JWT。

Cookie：

```text
HttpOnly
Secure (HTTPS)
SameSite=Lax
Path=/
```

数据库只存 Session Token hash。

优点：

- logout 即时；
- user disable 即时；
- session revoke 简单；
- password reset 可批量失效 sessions。

## 8. CSRF

Cookie Session 的 mutation API 使用：

```text
SameSite
+ Origin/Referer validation
+ CSRF token/header
```

Bearer API Token / Device Token 不使用 Cookie，因此不走相同 CSRF 机制。

## 9. API Token

用于外部程序/自动化，不用于 Browser Sync。

建议 scopes：

```text
bookmarks:read
bookmarks:write
publications:read
publications:write
backups:read
backups:write
```

API Token 权限永远是 User 权限子集。

普通 Token 不授予系统 Admin API。

## 10. Space Restriction

Token 权限由两维组成：

```text
Capability Scope
+
Resource Boundary
```

支持：

```text
all current and future owned spaces
```

或：

```text
selected spaces
```

指定 Space 用关系表实现，不急于构造通用 JSON policy DSL。

## 11. Device Credential

Device ID 不是 credential。

Server 注册 Device 后返回一次性 Device Secret；Server 只保存 hash。

Device Credential 最小权限，仅执行 Replica Protocol。

Extension reinstall / local replica database loss 默认视为 new Device，旧 Device 可 revoke。

## 12. User Disable 与 Revoke

`status=disabled`：

- Session 拒绝；
- API Token 拒绝；
- Device Sync 拒绝；
- user data 不删除；
- Publication 可暂时从 Plaza 隐藏。

Credential 本身不必自动 `revoked`，因此重新 enable 可恢复。

显式 revoke 才永久撤销特定 Token / Device credential。

## 13. Admin Boundary

Admin 可：

- 系统配置；
- registration policy；
- user status；
- reset flow；
- jobs/system health；
- Plaza moderation。

默认不可：

- 搜索其他用户 Private Space；
- 浏览 private bookmarks；
- 读取 private logical backup 内容。

## 14. Authorization Service

权限不能散落 HTTP Handler。

统一策略示例：

```text
CanReadSpace
CanWriteSpace
CanReadPublication
CanWritePublication
CanManageBackup
CanManageUser
```

Repository 可进一步使用 owner-scoped query 做纵深防御。

## 15. Password Reset

有 SMTP：发送 single-use short-lived Reset Link。

无 SMTP：管理员生成一次性 reset link，由管理员通过其他渠道发给用户。

Admin 不需要知道用户新密码。

## 16. Account Delete

Disable 与 Delete 分开。

真正 Delete Account 是高风险操作，应明确影响：

- spaces/nodes；
- devices/tokens；
- backups；
- publications；
- import mappings；
- organizer data。

已由其他用户从 Publication Copy 进入自己 Space 的书签不受 Publisher 删除影响。
