# 19. 技术栈、Monorepo 与构建部署

## 1. Monorepo

```text
/
├── server/
├── web/
├── extension/
├── packages/
│   ├── api/
│   ├── protocol/
│   └── i18n/        (若最终共享语言资源)
├── api/
│   └── openapi.yaml
├── scripts/
├── package.json
└── pnpm-workspace.yaml
```

不用 Turborepo/Nx 起步，pnpm workspace 足够。

## 2. Server

基线：

```text
Go 1.27
net/http + chi
database/sql
SQLite
ncruces/go-sqlite3（首选，adapter 保持薄）
handwritten SQL
log/slog
Argon2id
REST + JSON
OpenAPI
TOML + env
go:embed
```

原则：

- no ORM；
- no GORM；
- no heavy web framework；
- no DI framework；
- stdlib first；
- 保持 CGO-free where practical。

SQLite Driver 若开发期 transaction/locking integration tests 暴露问题，可在薄 adapter 内替换，不为了 PostgreSQL 构造通用 Persistence Layer。

## 3. Web

```text
TypeScript
React 18
Vite
TanStack Router
TanStack Query
Mantine
Vanilla Extract
Mantine Form
native fetch + thin client
i18n: zh-CN / en baseline
```

状态分工：

```text
URL State       → TanStack Router
Server State    → TanStack Query
Form State      → Mantine Form
Local UI State  → React state/reducer
```

V1 不默认 Redux/Zustand。

TanStack Table / Virtual 视实际页面与性能需求引入，不因“全家桶”提前全部安装。

## 4. Mantine + Vanilla Extract

Mantine Theme 是基础 design token Source of Truth。

Vanilla Extract 负责：

- App layout；
- Bookmark Explorer；
- complex product-specific styling；
- semantic visual composition。

尽量使用 Mantine CSS Variables，避免再维护第二套基础 spacing/color/radius tokens。

## 5. Extension

```text
TypeScript
WXT
Pure TS Sync/Replica Core
Dexie / IndexedDB Adapter
React 18 UI
Mantine
Vanilla Extract
```

React 只存在于 popup/options/recovery UI，不进入 sync core。

WXT 负责 packaging/runtime entry/cross-browser build，不成为 Sync Domain 依赖。

## 6. Web Dist Embedding

生产必须将 Web `dist` 嵌入 Go binary。

注意 Go `embed` 不能跨 package directory 直接引用兄弟目录的 `../web/dist`。

Build pipeline：

```text
pnpm web build
→ web/dist
→ stage/copy to server/internal/webui/dist
→ go build
```

`server/internal/webui/dist` 是 generated artifact，不提交 Git。

生产 Go：

```text
/api/* → API
/*     → embedded SPA static
```

SPA route fallback 到 `index.html`，但 `/api/*` 永不 fallback。

## 7. Dev Server

开发：

```text
Browser → Vite :5173
          ├── HMR React
          └── /api → proxy → Go :8080
```

生产同源，不需要泛化 CORS。

## 8. OpenAPI

`api/openapi.yaml` 是 HTTP Contract Source of Truth，不是 Domain/DB Source of Truth。

建议：

```text
OpenAPI
├── → Go HTTP DTO generation
└── → TypeScript types generation
```

Go Handler/Router 保持手写，不要求 codegen 生成完整 Web framework。

TS 侧：

```text
openapi-typescript → types
native fetch       → transport
TanStack Query     → cache/server state
```

`packages/api` 提供薄 client/error wrapper。

## 9. Sync Protocol Package

即使 `/sync` 也出现在 OpenAPI 中，仍作为一等 Replica Protocol 管理：

```text
packages/protocol
```

维护：

- protocol version；
- operations；
- canonical changes；
- result/error codes；
- JSON fixtures。

Go 与 TypeScript 用 shared golden JSON fixtures 做 compatibility tests。

## 10. i18n

V1 至少预留：

```text
zh-CN
en
```

Frontend/Extension machine error code 映射本地化文案。

Server error message 主要 debug/fallback，不承担动态 UI localization。

Server 直接发送的 Email 需要 server-side localized template。

## 11. Configuration

Deployment config 使用：

```text
config.toml
+ environment variables override
```

部署设置示例：listen/data dir/database/public URL/logging/trusted proxies。

Web UI 产品设置保存在 SQLite，例如 registration、SMTP、backup providers、retention。

Web UI 不修改 config.toml。

## 12. Secret Store

Web UI 配置的 SMTP/Backup Provider Secrets：

```text
data/instance.key
+
encrypted system_secrets in SQLite
```

例如 AES-GCM。

支持 deployment environment master key override。

Logical Bookmark Backup 不包含 server secret key/credentials。

## 13. Deployment

裸机：

```text
server binary
data/
config.toml
```

Container runtime 只需要 binary + data volume + CA certificates。

Node 只在 build stage。

Server 可嵌入 timezone database，降低 minimal container 对 host tzdata 的依赖。

TLS 推荐由 Caddy/Nginx/Traefik/Cloudflare Tunnel 终止；V1 不自带 ACME lifecycle。

## 14. Upgrade

启动顺序：

```text
Open DB
→ schema check
→ create pre-upgrade system DB backup
→ migrations
→ integrity check
→ start HTTP/jobs
```

Migration 完成前不接受业务流量。

Downgrade 不自动做 down migrations：旧 binary 遇到 schema too new 应拒绝启动，恢复升级前 System DB Backup 才是 downgrade 路径。

## 15. Versioning

独立版本：

```text
Server + Embedded Web product version
Extension version
/api/v1 HTTP version
Sync protocol_version
DB migration version
Backup format_version
Publication format_version
```

Extension 与 Server 不要求 product version 完全一致，只要支持共同 Sync Protocol。
