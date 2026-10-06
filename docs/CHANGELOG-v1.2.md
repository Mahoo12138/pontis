# Pontis Design V1.2 变更说明

本次调整针对已实现 UI 中出现的导航问题进行约束。

## 变更

原实现：

```text
设置
├── 账户
├── 偏好
├── API Token
└── 系统
    ├── 注册模式
    ├── 会话有效期
    ├── 每用户 Space 上限
    ├── 打开用户管理
    └── 后台任务
```

调整为：

```text
设置
├── 账户
├── 偏好
└── API Token

管理（管理员专属）
├── 用户
├── 后台任务
└── 系统设置
```

## 核心理由

- 用户与后台任务是独立管理对象，不是系统设置项；
- Settings 应保持“当前用户个人设置”的稳定语义；
- System Settings 只承担实例级策略配置；
- 管理页面必须拥有稳定的一等导航和独立路由；
- 管理功能不得仅依靠页面内部按钮被发现。

建议实现路由：

```text
/settings/account
/settings/preferences
/settings/api-tokens

/admin/users
/admin/jobs
/admin/system
```
