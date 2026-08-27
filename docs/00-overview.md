# 00. 产品概览与范围

## 1. 产品定位

项目是一个**自托管、跨浏览器、原生书签同步平台**。它直接同步 Edge、Chrome、Firefox 的浏览器原生 Bookmark/Favorites Tree，而不是重新发明一个 Read-it-later 或独立收藏网页。

用户可以继续使用浏览器厂商同步密码、历史、扩展等类别，只关闭浏览器自带的 Favorites / Bookmarks Sync，由本系统接管书签同步。

目标场景包括：

- 单人多浏览器、多设备同步；
- 家庭或小圈子多用户自部署；
- 每个用户拥有多个独立 Sync Space；
- Full Sync 与 Partial Sync；
- 离线编辑、稍后同步；
- 多客户端并发修改；
- Backup / Restore；
- Organizer；
- Search；
- Plaza / Publication；
- 浏览器插件、Web UI、外部 REST API 共用同一 Canonical Domain。

## 2. 核心产品原则

### 2.1 Server 是 Source of Truth

浏览器不是互相同步的 Peer。所有 Browser Replica 最终向 Server Canonical Tree 收敛。

```text
Browser A ─┐
Browser B ─┼─→ Server Canonical Tree ← Web / API / Import / Plaza
Browser C ─┘
```

浏览器允许离线工作，但所有本地修改都被表达为 Operation，最终由 Server 判定是否 Apply / Rebase / Conflict / Recover。

### 2.2 用户新建数据不能静默丢失

系统可以让 stale mutation 失败，但对离线期间真正 CREATE 出来的新 Bookmark / Folder 应优先保护，例如父目录已被别人删除时移动到 `Recovered/<Device>`。

### 2.3 删除不会被旧客户端悄悄复活

DELETE 优先于 stale UPDATE / MOVE。旧客户端不能因为长时间离线重新把已经删除的节点“修改回来”。

### 2.4 多用户默认私有

每个 Sync Space 只有一个 Owner。V1 不实现共享 Space、ACL、Editor/Viewer Role。

跨用户书签传播通过**显式 Publication Copy**完成，而不是直接读取别人的 Private Space。

### 2.5 Admin 不是 Private Bookmark Superuser

产品权限模型中，管理员负责系统配置、用户状态和广场治理，但不天然获得浏览别人 Private Bookmark 的能力。

物理 Server 管理员能读取 SQLite 是部署信任边界问题，不等于产品应提供“浏览所有用户书签”按钮。

### 2.6 Correctness First

V1 优先可靠性，而不是：

- 极致实时；
- 极致减少 Operation 数；
- 极致减少 Revision；
- 复杂自动 Merge；
- 分布式多 Server；
- 任意自动化平台。

## 3. V1 明确不做

- 多用户共同编辑同一个 Sync Space；
- Node ACL / Group / Team / Workspace；
- Event Sourcing；
- PostgreSQL abstraction；
- Redis / RabbitMQ 等外部 Job Queue；
- Server 间分布式一致性；
- 通用 URL Shortener；
- Publication 自动订阅与实时跟随；
- 模糊 URL Matching 作为 Sync Identity；
- Sync 层 URL normalization；
- Firefox Separator 跨浏览器同步；
- 通用自动化 Workflow Builder；
- 全局 Ctrl+Z 式 Undo Stack；
- 默认外部 Telemetry。

## 4. 核心系统分层

```text
                    Web UI
                      │
External API ─────── Domain API
                      │
Browser Extension ─ Sync Protocol
                      │
          ┌───────────┴───────────┐
          │                       │
     Sync Engine          Reconciliation Engine
          │                       │
          └───────────┬───────────┘
                      ▼
               Canonical Domain
                      │
                    SQLite
```

所有改变 Canonical Tree 的能力最终必须经过统一 Domain Command / Tree Apply 层。

## 5. 交付形式

生产部署目标：

```text
Single Go Binary
+ SQLite Database
+ Data Directory
```

React Web UI 的 `dist` 在 release build 中嵌入 Go binary。运行时不需要 Node.js。

Browser Extension 独立发布，版本节奏与 Server 独立，以 Sync Protocol compatibility 判定是否兼容。
