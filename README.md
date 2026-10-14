# Pontis

自托管的跨浏览器书签同步平台：Go 服务端 + 嵌入的 Web 控制台 + 浏览器扩展。
设计与决策记录在 [docs/](./docs/README.md)，界面权威见 [PRODUCT.md](PRODUCT.md) 与 [DESIGN.md](DESIGN.md)。

**当前状态：内部 Alpha。** 单个可执行文件已经可以跑起来（构建与演练见下），
但还没有把真实书签库当作唯一副本的条件；公开注册默认关闭，要由管理员显式开启。
Firefox 适配排在 Chromium Alpha 之后。

## 构建一个产物

发布构建需要 Node（编译前端）与 Go，运行它只需要那个二进制：

```sh
pnpm install
pnpm build          # web 编译 → 扩展打包 → 两份产物暂存进 server/ → go build
./server/pontis -config config.toml
```

`pnpm build` 依次做五件事：`@pontis/web` 的 `vite build`、`@pontis/extension` 的
`wxt zip`、`scripts/stage-web-dist.mjs` 与 `scripts/stage-distribution.mjs` 分别把
Web dist 和扩展 ZIP 拷进各自的 `server/internal/*/`（`go:embed` 只能看见本包目录）、
最后 `go build -o server/pontis ./cmd/server`。单独跑 `pnpm build:web` 只产出
`web/dist/`，**那不是可部署产物**。

扩展安装包是随二进制一起交付的：用户在 Web 的「设备」页下载本实例内嵌的那一份，
按开发者模式手动加载。校验、清单与下载接口的形状见
[扩展分发与 Release 方案](pontis-extension-distribution-release-v1.md) 与 docs/21 §12。

没有配置文件的机器上直接 `./server/pontis` 也能起：默认监听 `:8080`，数据目录
`./data`。

## 配置

`-config` 指向一个 TOML（不存在则跳过），同名项可用 `PONTIS_*` 环境变量覆盖。

```toml
# 监听地址。生产建议放在反向代理后面。
listen = ":8080"

# 数据目录：SQLite（pontis.db）与 backups/ 都写在这里。
# 这一目录 + 备份就是全部状态；换机器时带走它。
data_dir = "data"

# info | debug | warn | error
log_level = "info"

# 优雅关停预算
shutdown_timeout = "10s"

# 链接检查的出站范围。留空 = 只允许公网可路由地址，这是安全的默认值：
# 链接检查是拿服务器自己的网络身份去访问用户填的 URL。
# 只有确实要检查内网地址时，才由实例管理员显式列出 CIDR。
link_check_allow_cidrs = []
```

`database_path` 由 `data_dir` 推导，不可配置。

`public_url` 与 `trusted_proxies` 目前只是被读进配置，服务端没有任何地方消费
它们（`X-Forwarded-For` 的信任、以及对外可见BaseUrl 都还没接线）。在它们有实现
之前不要把部署依赖建立在它们之上。

## 首次使用

1. 打开 `http://<host>:8080/`，未初始化的实例会自己跳到初始化页：第一个账号即管理员
   （`/auth/setup` 成功后永久关闭）。
2. 建一个 Space（书签容器）。
3. 在扩展里填实例地址并配对：扩展注册设备 → `POST /device/bindings` 绑定 Space
   → 绑定进入 `pending_initial`。
4. 首次对账由**服务端**规划并回答（匹配、歧义问题、计划预览），扩展只负责把
   计划落到浏览器并 `complete`。绑定随后进入 `active`，之后的增量同步走 `/sync`。
5. 解绑会撤销服务端绑定；换设备凭证会丢弃上一台设备的本地副本。

新增设备重复 3–4。备份恢复后所有绑定回到 `pending_initial`，需要按这条路径重连，
不会自动 active。

公开注册默认关闭：管理员在 后台 → 系统设置 → 注册模式 切到 `open`，登录页才会出现
注册入口。这样注册出来的账号是普通用户（拿不到管理员角色），并自带一个默认 Space。
`GET /api/v1/system/status` 是这些判断的匿名读面——实例是否已初始化、注册是否开放；
`/settings` 有会话门槛，匿名访客读不到。

## 开发命令

CI（[.github/workflows/ci.yml](./.github/workflows/ci.yml)）跑的就是这些，
所以本地绿灯等于 CI 绿灯。工具版本：Go 以 `server/go.mod` 为准，
Node 22 + `packageManager` 里钉住的 pnpm。

| 命令 | 内容 |
| --- | --- |
| `pnpm typecheck` | 各包 `tsc --noEmit` |
| `pnpm test` | Vitest：协议、REST 契约、扩展核心、web 逻辑 |
| `pnpm test:go` | `go test ./...` |
| `pnpm test:go:race` | `go test -race ./...`（并发与任务队列只在带 race 时算测过） |
| `pnpm test:fixtures` | 两组 golden 协议/REST fixture 的漂移检查 |
| `pnpm dev` | Vite 开发服务器，`/api` 代理到 `:8081` |
| `pnpm dev:test` | 一键启动独立 Go + Vite 测试环境，关闭 Mock |
| `pnpm e2e:api` | 对已启动的测试环境执行真实 HTTP API E2E |
| `pnpm dev:extension` | WXT 扩展开发模式 |
| `pnpm build:extension` | `wxt build` → `extension/.output/chrome-mv3`（解压目录，开发时手动加载） |
| `pnpm build:extension:zip` | `wxt zip` → `extension/.output/pontis-chromium-<version>.zip`（发布产物） |

`pnpm test` 用 `--no-bail`：默认的 `-r` 在第一个失败包停下，后面的包根本没跑到，
聚合退出码会替人撒谎。

### 一键启动测试环境

需要 Node 22+、项目指定版本的 pnpm、Go 和 curl。脚本可从任意目录调用；缺少
前端依赖时自动执行 `pnpm install --frozen-lockfile --prod=false`，每次启动都会编译当前后端。

```sh
./scripts/test-env.sh                 # 保留测试数据
./scripts/test-env.sh --reset-db      # 清空测试数据库及其备份，再启动
# 也可使用 pnpm dev:test / pnpm dev:test --reset-db
```

前端：`http://127.0.0.1:5180`；后端：`http://127.0.0.1:8180`。
前端的 `/api` 代理到该后端，并强制 `VITE_API_MOCK=off`。数据位于
`.test-env/data/`，日志为 `.test-env/api.log` 和 `.test-env/web.log`。
脚本忽略部署用的 `config.toml` 和 `PONTIS_DATA_DIR` 等设置，不会重置
`data/` 或 `server/data/`。全新数据库由后端自动迁移，首次使用可在页面创建管理员。

命令在前台运行，显示 `Test environment ready` 后即可使用；Ctrl-C 会停止两个服务，
默认保留数据。重复启动、端口占用或任一服务退出都会报错；不会自动切换端口。
异常强杀后若留下 `.test-env/run.lock/`，先确认其中 `*.pid` 对应的进程均已停止，
再删除该锁目录。需要换端口时：

```sh
./scripts/test-env.sh --api-port 8181 --web-port 5181
```

在另一个终端运行接口 E2E：

```sh
pnpm e2e:api
# 对应上面的自定义端口：
PONTIS_E2E_API_URL=http://127.0.0.1:8181 \
PONTIS_E2E_WEB_URL=http://127.0.0.1:5181 pnpm e2e:api
```

E2E 直接使用 HTTP 接口初始化、登录和创建数据，不经过页面操作，也不直接写 SQL。
空库会创建测试账号 `e2e` / `pontis-e2e-pass`；已有数据库则登录该账号。
如果此前通过页面创建了其他账号，用 `PONTIS_E2E_USERNAME` 和
`PONTIS_E2E_PASSWORD` 指定它，或停止环境后用 `--reset-db` 重新开始。
每次测试创建独立的测试 Space，便于重复运行和排查；这些测试数据保留到显式重置。

覆盖前端代理与后端实例一致性、认证拒绝、Cookie 与 Bearer 会话、书签树操作、
非法移动回滚及退出登录。它验证真实 API 与代理的组合，不覆盖浏览器渲染或扩展同步；
扩展的双 profile 测试仍使用 `pnpm e2e:dual-profile`。

## 迁移失败时

启动时按文件名顺序应用 `server/migrations/*.sql`，**每个文件一个事务**，成功后
才写 `schema_migrations` 版本行。因此：

- 失败的文件整体回滚，之前的版本保持不变；服务拒绝启动并打印
  `apply migration 0000NN_xxx.sql: <sqlite 错误>`。
- 没有 down 迁移。要回到旧 schema 只能恢复备份，或者换一个数据目录。
- 反复启动是安全的：已记录的版本会跳过。
- 排查用 SQLite 客户端打开 `<data_dir>/pontis.db`，读
  `SELECT version, applied_at FROM schema_migrations ORDER BY version;`
  就能知道停在哪一步。日志里的文件名即失败的那一步。

数据库锁冲突（另一个进程占着同一文件）也发生在启动阶段，症状是服务不起来，
而不是运行中丢数据。

## 备份与恢复演练

备份不是"文件躺在那儿"，它只有在能恢复之后才叫可靠。演练一遍：

1. 建备份：Web 的 Space → 备份页，或
   `POST /api/v1/spaces/{spaceID}/backups`（会话 Token）。目录里应出现一个
   `<Space 名>-<时间>-manual.json`，但**存储键是不可读的 UUID**——文件名只是给人看的。
2. **先验证它能恢复，再相信它。** 在另一个数据目录起一个实例（或用另一个 Space），
   调用 `POST /api/v1/spaces/{spaceID}/backups/{backupID}/restore`。恢复会：
   完整校验备份（格式标记、负载版本、所属 Space、树结构：唯一 id、父可解析、
   书签带 URL）→ 把导出顺序重排成父先子后 → 分配新的 epoch →
   把所有绑定退回 `pending_initial`。校验不过就完全不碰现役数据。
3. 恢复动作自己会先拍一份 *safety* 备份：那是明确的恢复前状态，出错时退回它。
4. 恢复后的设备必须通过正式的首次对账路径重连（见"首次使用"第 3–4 步）。
   如果这一步需要手工改数据库才能过，那是缺陷，请当作 bug 记录。
5. 离线客户端带着待发的 `CREATE`/`DELETE` 回连：应当是服务端规划一次合并，
   而不是把本地操作抹掉。

同名 Space、同一秒创建的两个备份必须是两个不同的物理对象。删除失败要留下可重试
的记录，不能把 catalog 删掉却把文件留在磁盘上。

## 已知边界

Alpha 阶段的范围与未完成项记在
[next-development-plan.md](next-development-plan.md)，逐条缺陷见
[review.md](review.md)。已知值得注意的几点：

- 服务端与扩展曾各有一套合并算法；对账生命周期已统一到服务端，扩展那套已删除
  （`extension/src/core/sync/verifyReplica.ts` 只剩客户端的校验与修复）。
- **没有 CSRF token**：会话 Cookie 是 HttpOnly + Lax，且带 cookie 的写请求必须与
  实例自身同源（`public_url` 或请求 Host；开发模式两端都是回环地址时允许不同端口）。
  在这套同源拓扑下这比双提交 token 更强，所以那层没做——触发条件记在 docs/09 §8。
  `trusted_proxies` 目前只用于判断"能否相信 `X-Forwarded-Proto`"，
  `X-Forwarded-For` 仍无人消费。
- 真实浏览器的双端收敛有脚本（`pnpm build && pnpm e2e:dual-profile`，见 docs/21 §10），
  但它要开窗口、要 macOS 上的 Chrome for Testing，**CI 不跑**：CI 仍然只覆盖
  假 adapter + httptest + 真浏览器无关的那几层。
- 没有 lint 命令：`eslint` 既不是任何包的依赖，也没有配置文件。
