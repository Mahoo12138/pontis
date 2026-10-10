# Pontis

自托管的跨浏览器书签同步平台：Go 服务端 + 嵌入的 Web 控制台 + 浏览器扩展。
设计与决策记录在 [docs/](./docs/README.md)，界面权威见 [PRODUCT.md](PRODUCT.md) 与 [DESIGN.md](DESIGN.md)。

**当前状态：内部 Alpha。** 单个可执行文件已经可以跑起来（构建与演练见下），
但还没有把真实书签库当作唯一副本的条件，也未开放公网注册。Firefox 适配排在
Chromium Alpha 之后。

## 构建一个产物

发布构建需要 Node（编译前端）与 Go，运行它只需要那个二进制：

```sh
pnpm install
pnpm build          # web 编译 → 暂存进 server/internal/webui/dist → go build
./server/pontis -config config.toml
```

`pnpm build` 依次做三件事：`@pontis/web` 的 `vite build`、
`scripts/stage-web-dist.mjs` 把 dist 拷进 `server/internal/webui/dist`
（`go:embed` 只能看见本包目录）、`go build -o server/pontis ./cmd/server`。
单独跑 `pnpm build:web` 只产出 `web/dist/`，**那不是可部署产物**。

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

1. 打开 `http://<host>:8080/`，第一个账号即管理员（`/auth/setup` 成功后永久关闭）。
2. 建一个 Space（书签容器）。
3. 在扩展里填实例地址并配对：扩展注册设备 → `POST /device/bindings` 绑定 Space
   → 绑定进入 `pending_initial`。
4. 首次对账由**服务端**规划并回答（匹配、歧义问题、计划预览），扩展只负责把
   计划落到浏览器并 `complete`。绑定随后进入 `active`，之后的增量同步走 `/sync`。
5. 解绑会撤销服务端绑定；换设备凭证会丢弃上一台设备的本地副本。

新增设备重复 3–4。备份恢复后所有绑定回到 `pending_initial`，需要按这条路径重连，
不会自动 active。

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
| `pnpm --filter @pontis/extension build` | `wxt build` → `extension/.output/chrome-mv3` |

`pnpm test` 用 `--no-bail`：默认的 `-r` 在第一个失败包停下，后面的包根本没跑到，
聚合退出码会替人撒谎。

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

- 服务端与扩展曾各有一套合并算法；对账生命周期已经统一到服务端，
  扩展里那套（`initialSync.ts`）仍在被若干路径调用。
- 真实浏览器（unpacked 扩展 + 真服务端）的双端收敛目前是**手工**流程，
  见 docs/21 §10；没有自动化 E2E。
- 没有 lint 命令：`eslint` 既不是任何包的依赖，也没有配置文件。
