# 24. Pontis 信息架构与导航约束

## 1. 目标

Pontis 的导航必须围绕“用户正在管理的对象”设计，而不是把所有管理员能力塞入一个模糊的「系统」页面。

V1 明确区分四类入口：

```text
内容工作区
→ Space / Plaza / Activity

用户任务
→ Tasks

个人与设备
→ Devices / Settings

实例管理
→ Users / Background Jobs / System Settings
```

## 2. Sidebar 基线

普通用户：

```text
空间
  个人
  工作
  学习
  + 新建空间

────────

广场
最近活动
任务

────────

设备
设置
```

管理员：

```text
空间
  个人
  工作
  学习
  + 新建空间

────────

广场
最近活动
任务

────────

设备
设置

────────

管理
  用户
  后台任务
  系统设置
```

「管理」为管理员专属 Section Label。

## 3. Settings 的严格定义

「设置」只代表当前用户自己的配置：

```text
设置
├── 账户
├── 偏好
└── API Token
```

不得出现：

- 用户管理入口作为设置项；
- 后台任务入口作为设置项；
- 注册模式；
- 全局 Session Policy；
- 每用户 Space 上限；
- SMTP / Retention 等实例级策略。

原因是这些内容的作用域不是“当前用户”。

## 4. Administration 的严格定义

实例级管理统一进入 `/admin/*`。

### `/admin/users`

管理 User 对象。

### `/admin/jobs`

管理 / 观察 Server Background Job Runtime。

### `/admin/system`

配置实例级全局策略。

三个页面是平级关系，不是：

```text
System Settings
├── Users
└── Jobs
```

## 5. 为什么用户与后台任务不能藏在系统设置里

用户和 Job 都有：

- 独立列表；
- 独立状态；
- 独立生命周期；
- 独立操作；
- 独立筛选与详情。

因此它们是一级管理对象，而不是“一个配置项”。

将其隐藏在系统设置中的按钮会造成：

1. 可发现性差；
2. 用户无法形成稳定的导航心智模型；
3. System Settings 页面同时承担配置与运营管理两种语义；
4. 后续用户/任务能力扩展后页面必然继续膨胀；
5. 管理页面无法拥有自己的路由、筛选和深链接。

因此 V1 明确禁止这种设计。

## 6. 用户任务与后台任务

两个页面虽然共享底层 Job Engine，但产品语义不同。

```text
任务
用户视角
“Pontis 要替我做什么？”

后台任务
管理员视角
“Server 当前在执行什么？”
```

普通用户「任务」：

- 自动备份；
- 定期链接检查；
- 其他已注册领域任务；
- 计划、运行状态、历史。

管理员「后台任务」：

- Worker；
- Lease；
- Retry；
- Error Code；
- System Job；
- 全局运行状态；
- 用户 Job 的脱敏元数据。

两者不能合并成同一页面通过 Role Filter 区分。

## 7. 系统设置页面边界

`/admin/system` 可以包含：

```text
基础
注册与用户策略
会话与安全
邮件
Retention
其他实例默认值
```

但不能包含：

```text
[打开用户管理]
[后台任务]
```

作为一级管理功能的唯一入口。

可以提供状态型上下文链接：

```text
注册用户：8
管理用户 →

失败后台任务：2
查看后台任务 →
```

这些只是 shortcut。

## 8. 路由

```text
/settings/account
/settings/preferences
/settings/api-tokens

/admin/users
/admin/jobs
/admin/system
```

所有管理员页面必须支持直接 deep-link。

## 9. Authorization

导航可见性与权限是两层机制：

```text
UI Visibility
≠
Authorization
```

规则：

1. 非管理员不显示 Admin Navigation；
2. `/admin/*` API / route 必须独立校验管理员 Principal；
3. 角色变化应立即影响后续请求；
4. Admin 权限仍不提供 Private Bookmark Content 的隐式读取权。

## 10. V1 不变量

1. Settings 永远表示个人范围。
2. Administration 永远表示实例范围。
3. User、Job 等独立管理对象必须拥有独立页面与路由。
4. System Settings 只管理策略，不承担其他管理模块的容器职责。
5. 用户任务与后台任务必须保持独立产品语义。
6. 管理功能不能只通过页面内部隐藏按钮被发现。
