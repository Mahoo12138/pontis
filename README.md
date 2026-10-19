# Pontis

自托管的跨浏览器书签同步平台：Go 服务端 + 嵌入的 Web 控制台 + 浏览器扩展。
设计与决策记录在 [docs/](./docs/README.md)，界面权威见 [PRODUCT.md](PRODUCT.md) 与 [DESIGN.md](DESIGN.md)。

**当前状态：内部 Alpha，已发布 [v0.1.0-alpha.2](docs/releases/v0.1.0-alpha.2.md)。**
单个可执行文件已经可以跑起来（构建与演练见下），
但还没有把真实书签库当作唯一副本的条件；公开注册默认关闭，要由管理员显式开启。
Firefox 适配排在 Chromium Alpha 之后。

## 构建一个产物

发布构建需要 Node（编译前端）与 Go，运行它只需要那个二进制：

```sh
pnpm install
pnpm build          # web 编译 → 扩展打包 → 两份产物暂存进 server/ → go build
./server/pontis -config config.toml
```

`pnpm build` 依次做六件事：`@pontis/web` 的 `vite build`、`@pontis/extension` 的
`wxt zip` 与 `wxt zip:newtab`（同一份代码的两种打包）、`scripts/stage-web-dist.mjs` 与
`scripts/stage-distribution.mjs` 分别把 Web dist 和两个扩展 ZIP 拷进各自的
`server/internal/*/`（`go:embed` 只能看见本包目录）、最后 `go build -o server/pontis ./cmd/server`。
单独跑 `pnpm build:web` 只产出 `web/dist/`，**那不是可部署产物**。

扩展安装包是随二进制一起交付的：用户在 Web 的「设备」页下载本实例内嵌的那一份，
按开发者模式手动加载。有两个包可选——标准同步扩展，以及额外接管新标签页的起始页扩展，
装一个即可（详见分发文档 §16.6）。校验、清单与下载接口的形状见
[扩展分发与 Release 方案](pontis-extension-distribution-release-v1.md) 与 docs/21 §12。

没有配置文件的机器上直接 `./server/pontis` 也能起：默认监听 `:8080`，数据目录
`./data`。

## 部署

打一个 `vX.Y.Z` 的 tag 就会产出全部目标产物（`.github/workflows/release.yml`）：四个平台的
裸二进制挂到 GitHub Release，多架构镜像推到 `ghcr.io/<owner>/pontis`。预发布标记为
prerelease，镜像只推版本标签；正式版才更新镜像的 `latest`。
发布说明取自 `docs/releases/<tag>.md`，缺这个文件工作流会直接失败——
安装方式、已知限制与升级说明是发布的一部分，不是事后补的装饰。

```sh
docker run -d --name pontis -p 8080:8080 -v pontis-data:/data \
  ghcr.io/mahoo12138/pontis:v0.1.0-alpha.2
```

镜像的最终层只有服务端二进制、TLS 根证书和一个数据目录，没有 Node.js、pnpm 或 WXT 运行时。
它以 uid `65532` 运行：具名卷的属主继承自镜像，可直接写；改用宿主目录 bind mount 时属主由
宿主决定，需要先让该目录对 65532 可写，否则启动日志会报写不进数据目录。

裸二进制下载后先核对摘要再运行：

```sh
sha256sum --check SHA256SUMS
```

浏览器扩展不随这些渠道分发——它只从你自己的实例的「设备」页下载，保证装的一定是与运行
实例配套的那一份。

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

`public_url` 与 `trusted_proxies` 都已接线：前者决定带 Cookie 的写请求必须携带的
Origin、会话 Cookie 是否标记 `Secure`，以及密码重置链接里的主机名；后者列出允许
通过 `X-Forwarded-Proto` 报告外部协议的对端。放在反向代理后面时两者都要配：
`Secure` 是按请求算出来的，配错的方向两种都不安静——HTTP 实例上多打 `Secure`，
登录会静默失效（Cookie 根本不会回传）；HTTPS 上漏打，会话 Token 就可能被降级请求
带出去。Origin 不匹配时写请求直接返回 `ORIGIN_MISMATCH`。

仍然成立的边界：`X-Forwarded-For` 没有任何消费者——服务端不记录也不按客户端地址
限流，所以 `trusted_proxies` 目前只影响协议判断，不构成日志或限流上的信任链。

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

CI（[.github/workflows/ci.yml](./.github/workflows/ci.yml)）包括 Go vet/build/race tests、
客户端类型与单元测试、单二进制和分发冒烟，以及 Linux + Xvfb 下两个真实 Chromium
Profile 的同步验证。下面列出本地入口；只跑单元测试不能替代构建产物或双 Profile 验收。
工具版本：Go 以 `server/go.mod` 为准，Node 22 + `packageManager` 里钉住的 pnpm。

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
| `pnpm e2e:dual-profile` | 两个真实 Chromium Profile 的同步与同目录重建后状态保留；先执行 `pnpm build` |
| `pnpm dev:extension` | WXT 扩展开发模式 |
| `pnpm build:extension` | `wxt build` → `extension/.output/chrome-mv3`（解压目录，开发时手动加载） |
| `pnpm build:extension:zip` | `wxt zip` → `extension/.output/pontis-chromium-<version>.zip`（标准同步扩展） |
| `pnpm build:extension:zip:newtab` | `wxt zip:newtab` → `extension/.output-newtab/pontis-chromium-newtab-<version>.zip`（接管新标签页） |

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
- 没有 down 迁移。要保留旧状态并回到旧 schema，需恢复迁移前的整实例离线备份并使用
  对应旧版本程序；Space 备份不能替代它。也可以另建空数据目录。
- 反复启动是安全的：已记录的版本会跳过。
- 排查用 SQLite 客户端打开 `<data_dir>/pontis.db`，读
  `SELECT version, applied_at FROM schema_migrations ORDER BY version;`
  就能知道停在哪一步。日志里的文件名即失败的那一步。

数据库锁冲突（另一个进程占着同一文件）也发生在启动阶段，症状是服务不起来，
而不是运行中丢数据。

## 备份与恢复演练

Space 备份与整实例备份用途不同：Space 备份保存该空间的书签树和 Canonical UUID，
不能恢复账号、设备凭证、任务历史或数据库 schema；整实例离线备份才用于保留这些状态。
格式与边界见 [导入导出](docs/11-import-export.md) 和 [备份设计](docs/14-backup-retention-gc.md)。

**Space 恢复演练：** 在隔离的测试实例建一个包含多层目录的 Space，按以下流程验证：

1. 在 Web 的 Space → 备份页创建备份，或调用
   `POST /api/v1/spaces/{spaceID}/backups`（会话 Token），记录备份 ID 与原树。
   `<Space 名>-<时间>-manual.json` 是展示名称，磁盘对象使用独立的 UUID 存储键。
2. 修改测试书签后，在**同一个 Space** 调用
   `POST /api/v1/spaces/{spaceID}/backups/{backupID}/restore`。备份目录记录和负载都绑定原
   Space；不能拿 backup ID 恢复到另一个 Space，也不能只复制 JSON 到空实例后直接调用。
   跨空间复制内容应走导入/导出，新增内容会取得新的 UUID。
3. 核对恢复后的 UUID、标题、URL、父子关系和顺序。恢复会校验负载与树结构、建立新 epoch，
   将绑定退回 `pending_initial`；返回的 `safety_backup_id` 指向恢复前的 Space 状态。
   Safety 备份可供后续显式恢复，**不代表发生故障时会自动回退**。
4. 用隔离的浏览器 Profile 验证恢复后的对账与收敛，再验证离线客户端带着待发的
   `CREATE`/`DELETE` 回连时的处理。如果需要手工改数据库才能继续，应记录为缺陷，
   不能把树恢复成功当作设备恢复成功。

**整实例离线备份与演练：** 先停止服务并确认进程退出，再复制整个 `data_dir`
（包含 `pontis.db`、`backups/` 及目录内其余文件），另存实际配置和对应二进制版本。
不要在运行时直接复制 SQLite 主文件来代替一致备份。验证现有 Space 备份时，可以从这份
完整副本启动隔离实例，使用独立监听端口、匹配的 `public_url` 和测试 Profile；它保留原 Space ID 与备份
目录记录，因此可以按上述原 Space 路径演练。勿让日常浏览器连接演练实例。

迁移只有向前路径。需要退回旧版本时，应停止服务，使用迁移前的完整实例副本与对应旧版本
程序，并重新验证登录、书签和设备同步；Space 备份不能降级 schema。这里描述的是人工
恢复演练方法，跨版本迁移失败后的完整回退仍待验收。

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
- 真实浏览器双端收敛脚本已进入 CI 的 `Two real profiles converge` job（Linux + Xvfb），
  本地入口为 `pnpm build && pnpm e2e:dual-profile`，见 docs/21 §10。它使用预授权测试
  服务端 origin 的专用 E2E 扩展，不能替代发布 ZIP 首装时的真实权限授权验收；同目录
  重建和重启验证的是同一代码版本的状态保留，不能证明跨版本 IndexedDB/schema 迁移或
  Server × Extension 兼容矩阵。Edge 重启、Firefox 及失败升级路径的边界仍见
  [alpha.1 发布说明](docs/releases/v0.1.0-alpha.1.md)。
- 没有 lint 命令：`eslint` 既不是任何包的依赖，也没有配置文件。
