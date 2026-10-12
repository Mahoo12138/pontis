# 21. 开发顺序、测试策略与 syncsim

## 1. 开发原则

先验证 Domain/Protocol correctness，再写 Browser UI。

不要一写出 `/sync` 就立刻冲去做 Chrome Extension。

## 2. 推荐实现顺序

### Phase 1 — Foundation

- Go monorepo/server skeleton；
- config；
- SQLite driver；
- migrations；
- logging/error model；
- ID/time helpers。

### Phase 2 — Canonical Core

- SyncSpace；
- RootSlot；
- Node repository；
- CREATE / UPDATE / MOVE / DELETE；
- tree validation/order。

### Phase 3 — Revision History

- revision allocation；
- journal；
- tombstone；
- ChangeSet / Undo snapshot。

### Phase 4 — Auth / Device

- setup/user/session；
- Device registration；
- Binding；
- Receipt。

### Phase 5 — Sync Engine

- operation envelope；
- conflict dimensions；
- causality；
- rebase；
- `/sync`。

### Phase 6 — syncsim

- fake replicas；
- multi-device concurrent operations；
- crash/network injection；
- convergence checks。

### Phase 7 — Reconciliation

- matcher/planner；
- Initial；
- Full Resync；
- Recovery；
- snapshots/artifacts。

### Phase 8 — Extension

- WXT；
- Browser Adapter；
- Dexie local replica；
- event capture；
- remote apply；
- recovery UI。

### Phase 9 — Web/product modules

- Bookmark Explorer；
- Organizer/Search；
- Backup；
- Publication/Plaza；
- Diagnostics。

## 3. Pure Algorithm Tests

`canonical/sync/reconcile` 尽量可以纯 Go test，不启动 HTTP/SQLite（除 repository-specific code）。

重点：

- cycle rejection；
- same-field conflict；
- different-field merge；
- same-binding causal ordering；
- stale anchor rebase；
- exact matcher ambiguity；
- LIS reorder；
- protected descendant replace planning。

## 4. SQLite Integration Tests

不要 Mock SQLite。

使用 temporary database + real migrations 验证：

- foreign keys；
- transaction rollback；
- WAL/locking；
- revision allocation；
- journal/receipt atomicity；
- recursive CTE delete；
- cross-space transfer；
- migration upgrade。

## 5. 第一个核心 Tree Test

建议最早做：

```text
Create:
main
├── Development
│   ├── GitHub
│   └── Go
└── Reading

Move GitHub → Reading
Delete Development

Assert:
Reading/GitHub survives
Go deleted
Development deleted
Journal continuous
Tombstones correct
```

随后：

- move folder under descendant → TREE_CYCLE + rollback + revision unchanged；
- recursive delete → descendant tombstones + one top-level canonical DELETE；
- sibling reorder → only moved semantic node structure_revision changes。

## 6. syncsim

建议作为一等开发工具：

```text
Fake Server
├── Fake Edge
├── Fake Firefox
└── Fake Web UI
```

Fake Browser 模拟：

- Browser tree；
- mirror；
- pending outbox；
- remote inbox；
- applied/received watermark；
- crash/restart。

## 7. Fault Injection

随机插入：

```text
network drop
duplicate request
response loss
client crash
server restart
delayed apply
offline editing
out-of-order client arrival
```

关键 crash point：

- before/after SQLite commit；
- Server commit before response；
- client response before IDB commit；
- expectation persisted before Browser API；
- Browser API success before checkpoint；
- change applied before watermark advance。

### 并发交错

一次请求的"检查"与它的"落库"之间，另一个写入者可以提交。syncsim 用同一个 SQLite 文件的第二个连接，在一次 round 的指定读取点之后提交这些写入：Restore 换 epoch、Journal GC 抬 floor、另一个 Device 的 CREATE 落在 Snapshot 的两次读取之间、round 结束时的水位写失败。因此每条边界测试断言的是实际发生过的交错，而不是理论上可能的交错。

## 8. Protocol Invariants

最终 bring all replicas online 并 drain queues 后：

```text
Browser Canonical Projection
== Server Canonical Tree
```

除非存在明确 unresolved conflict/recovery。

并保证：

> 所有 offline-created new data 要么存在于 Canonical Tree，要么存在明确 recovery/conflict record，绝不静默消失。

## 9. Golden Protocol Fixtures

Go 与 TypeScript 共用 JSON fixtures：

```text
sync-request-v1.json
sync-response-v1.json
sync-response-empty-v1.json
operation-create-v1.json
operation-move-v1.json
error-epoch-mismatch.json
reconcile-client-snapshot-v1.json
reconcile-server-snapshot-v1.json
reconcile-snapshot-nodes-v1.json
reconcile-session-planned-v1.json
reconcile-steps-v1.json
reconcile-session-completed-v1.json
```

双方同时验证 encode/decode，防 wire schema 漂移。

对账生命周期的 golden 文件由 Go 的 wire DTO 生成，TypeScript 一侧有两处读取
同一批文件：`packages/protocol` 的共享 codec，以及扩展真正收线时用的边界校验
器（`parseReconciliationEnvelope`/`parseSteps`/`parseServerSnapshotPage`）。
只有后者通过，才说明扩展实际会收到的那份 JSON 是可用的。

Web 消费的 REST 响应另有一批 golden 文件，在 `fixtures/api/`：它们由真实
router + 干净 SQLite 走完 setup → 建 Space → 建节点 → 注册设备 → 绑定 →
建备份/计划/任务之后**从 HTTP 响应里抓下来**，不是拿 wire DTO 现场 marshal，
所以 handler 忘了初始化一个 slice 也会被抓到。TypeScript 一侧由
`packages/api/src/contract.ts` 的运行时校验器读取同一批文件（见该目录
README）。`@pontis/api` 此前只做 `res.json() as T`——断言不改变运行时的值，
这类形状差异只会变成浏览器里的一片空白。

## 10. Web / Extension Tests

Web：

```text
Vitest
React Testing Library
Playwright E2E
```

Extension Core：Vitest + Fake Browser Adapter/Dexie test DB。

### 真实浏览器 E2E：两个 profile 收敛

Fake adapter + httptest 两侧都用自己的替身，跨界的形状差异只有真机能看见。这一步是脚本化的：

```sh
pnpm build && pnpm e2e:dual-profile        # 需要能开窗口，CI 不跑
```

`scripts/e2e-dual-profile.mjs` 用 Node 的全局 fetch/WebSocket 直接说 DevTools 协议，
不引入 playwright 依赖。它做的事：起一个干净数据目录的服务端 → 建号建空间预置 2 个书签 →
构建 E2E 扩展产物 → 开两个独立 profile → 在扩展自己的 options 页里填配对表单、选空间与挂载目录、
创建绑定 → 等两边都 active 并确认服务端的树被写进了两个真实书签栏 → 一边建一个书签、
两边各点一次"立即同步" → 断言服务端与**两个浏览器**都持有 4 个节点、没有重复、没有需要人工处理的状态。
失败时会打印两侧的 replica 快照（bindings / localNodes / pendingOps / remoteChanges / diagnostics）
与页面尾部文本。

跑法里的两个硬约束：

- **扩展 id** 由加载路径决定：`sha256(绝对路径)` 前 32 个十六进制字符，每个半字节映射成 `a-p`，
  于是可以直接 navigate 到 `chrome-extension://<id>/options.html`。
- **host 权限**：配对时 `chrome.permissions.request` 的气泡是浏览器原生 UI，自动化点不到，
  而且它只在**真实用户手势**里才会答应——`element.click()` 不算，所以点击一律用
  `Input.dispatchMouseEvent`。免掉气泡的办法是 E2E 构建开关（`extension/wxt.config.ts` 读
  `PONTIS_E2E_ORIGIN`，把服务端 origin 放进 `host_permissions` 并输出到 `.e2e-output/`，
  发布产物 `.output/chrome-mv3` 不受影响）。**实测过并否定**的路线：往 profile 的
  `Default/Secure Preferences` 里写 `active_permissions.explicit_host` 想造出"预授权 profile"，
  重启后 Chrome 不认（`permissions.contains` 仍为 false）。
- 启动参数必须带 `--use-mock-keychain`：否则 macOS 会在第一次写 cookie 时弹
  "Chromium Safe Storage" 钥匙串授权，profile 里所有 fetch 都堵在它后面，症状看起来像配对卡死。

手工排查（不跑脚本，自己开浏览器点）时还会踩到这些：

- 改完代码必须清 profile 的 `Default/Service Worker`、`Default/Extension Scripts`、
  `Default/Code Cache`，否则 Chrome 继续跑缓存里的旧 SW 脚本，症状是"代码明明改了、
  行为没变"。`chrome.runtime.reload()` 之后扩展页面会短暂 `ERR_BLOCKED_BY_CLIENT`，
  只能重启浏览器。
- 服务端有意不发 CORS，发布产物靠 `optional_host_permissions` + 配对时
  `chrome.permissions.request` 拿权限：人点一次「允许」之后，同一 profile 一直有效。
- `chrome.storage.local.get(key)` 解析成 `{key: value}` 包装对象，不是 value。核心里
  的 KV 抽象与它不同，这层形状差异只能留在 `runtime/kvArea()`。
- 扩展只在 headed + persistent context 下能加载；没有装 Chrome stable 的机器上，用
  Playwright 自带 Chromium 或 `Google Chrome for Testing.app` 的绝对路径
  （`launchOptions.executablePath`）即可，别为此装一遍浏览器。
- MCP 入口不要写 `npx -y @playwright/mcp@<ver>`：registry 慢的时候进程起不来，`/mcp reload`
  之后整个 server 直接消失。用已缓存的 `.../node_modules/.bin/playwright-mcp` 绝对路径，
  冷启动不碰网络。
- 测试浏览器要按 profile 目录精确杀（`pgrep -f "<profile 路径>"`），别按二进制名 kill：
  服务端和浏览器都在同一个临时目录下时，一条 `pkill -f pontis-alpha` 会顺手把 Playwright
  的浏览器干掉，MCP 连接就此卡死，只能重启。

键盘可达性（真机过一遍，非断言脚本）：从文档开头 Tab 8 次到达书签树（一个 tab 停靠点，
行与行之间用方向键走，行本身不进 Tab 环——一个 Space 几百个书签时逐行 Tab 不可用）；
↑↓ 移动、← 折叠/回父、→ 展开、Home/End、空格切换选择、Delete 打开删除确认；
`ContextMenu` 键或 Shift+F10 在光标行上打开行菜单，菜单内 ↑↓/Home/End 走位、Enter 执行、
Esc 关闭并把焦点交回树；删除确认对话框锁住 Tab 环并在关闭后把焦点还回树。
行菜单的 ⋯ 按钮 `tabIndex={-1}`：它是鼠标可见性，键盘走菜单键这条路。

事件回环要有测试覆盖：任何"同步自己写进浏览器"的路径，测试必须把 adapter 的监听器接到
EventProcessor 上（见 `expectedMutationEcho.test.ts`）。否则 provisional expectation
被谁消费、echo 晚到会不会把同步自己的改动当成用户编辑，mock 全都测不出来——真实浏览器
里它的症状是服务端长出重复节点。

Dexie 事务里不能等浏览器。`chrome.*` 的 Promise 在宏任务里落地，而 Dexie 一看任务队列
翻空就把事务提交掉，事务体内任何后续请求都会撞上 `TransactionInactiveError` /
`PrematureCommitError`，整轮 sync 被 catch 吞成一条 warn。所以"读浏览器 → 开事务 → 只写
Dexie"是唯一合法顺序（`remoteChangeApplier` 的 `readOrder()` / `writeOrder()` 就是为此
拆开的）。这条在 mock 里默认测不出来：假 adapter 的 Promise 是微任务，事务永远不会提前
提交。要用 `remoteChangeApplier.test.ts` 里的 `onMacrotasks()` 包一层，把每个 adapter
方法都推到一个 `setTimeout` 之后——只有这样才能重现真实 Chromium 的时序。

双向收敛现在由 `pnpm e2e-dual-profile` 断言：A、B 各自 active 之后，服务端 4 个节点、
两个浏览器都看到 4 个、镜像里 A 有 B 建的 `From B`、B 有 A 建的 `From A`，且没有重复节点。
注意它是**拉式**的：B 的创建落到 rev 4 之后，A 只有在自己再跑一轮时才会收到，所以脚本在
服务端确认之后又点了一次"立即同步"——这不是掩盖问题，协议本来就不往设备推。

另一个曾经手工踩出来的坑仍然成立：第二个 profile 若从第一个 rsync 而来，会连同第一个设备
的 binding 行一起复制过去，于是同一 profile 里出现两个同 Space 的 binding，旧的那个每轮
`NOT_BINDING_OWNER`。这不是 bug 的复现路径而是 profile 复制的产物，但它暴露了同一件事：
本地永远无法拥有这个 binding，重试没有意义，所以 coordinator 把它当成终止态处理
（`needs_recovery` + 一条 error 诊断），和 `EPOCH_MISMATCH` 走同一出口。脚本用的是两个
全新 profile，不走这条路。

- 复制出来的 profile 若删过 `Service Worker` / `Default/Code Cache` 可能再也起不来（进程
  起来就退出，Playwright 报 `Target page, context or browser has been closed`）。这时不要
  抢救它，重新 rsync 一份 + 重新配对，比修 profile 快。

## 11. Release Testing

Release 前至少：

- new install bootstrap；
- migration from previous schema；
- web dist embedded serving；
- Docker data persistence；
- Full + Partial Binding；
- duplicate request / lost response；
- epoch restore + recovery；
- backup restore validation。

## 12. 根命令与 CI

CI（`.github/workflows/ci.yml`）不另立一套命令，跑的就是根命令，所以本地绿
等于 CI 绿。工具版本以 `server/go.mod` 与 `packageManager` 字段为准。

| 命令 | 内容 |
| --- | --- |
| `pnpm typecheck` | 5 个 workspace 包 `tsc --noEmit` |
| `pnpm test` | `pnpm -r --no-bail test`：protocol/扩展的 Vitest、`packages/api` 的 REST 契约、web 的 tree/safe-url |
| `pnpm test:go` | `go test ./...` |
| `pnpm test:go:race` | `go test -race ./...`，并发与任务队列的边界只在带 race 时才算测过 |
| `pnpm test:fixtures` | 两组 golden 协议/REST fixture 的漂移检查 |
| `pnpm e2e:dual-profile` | 两个真实 Chromium profile 经真服务端收敛（见 §10；要开窗口，CI 不跑） |
| `pnpm build` | web 的 `tsc --noEmit && vite build`（**不等于**可部署产物，见 PR-F1） |
| `pnpm --filter @pontis/extension build` | `wxt build` → `extension/.output/chrome-mv3` |

`-r --no-bail` 是刻意的：默认的 `-r` 在第一个失败包停下，后面的包根本没跑到，
聚合命令的退出码因而会替人撒谎。曾经有两个包声明了 `test` 脚本却没有任何测试
文件，`vitest` 以 1 退出——这类"脚本存在但永远失败"和"没脚本"是两种不同的
问题，前者会被读成红灯，后者会被读成绿灯。

没有 lint 命令。`eslint` 既不是任何包的依赖，仓库里也没有配置文件，那条脚本
从来跑不起来；要么按原设计把它装齐并写完配置，要么就别留一个必然失败的入口。

## 起始页的真实浏览器矩阵

[起始页 V1](./features/start-page-v1.md) §19-§20 的验收不能由 UI 快照测试或 Fake API 测试替代：

1. 阶段 A/B 可用假凭据与本地缓存做单元验证，但来源配置、离线缓存、撤销与多标签一致性需要在真实 Chromium Profile 与真实 Server 上跑通。
2. Edge、Chrome、Firefox 分别报告结果；在 Chromium 上通过不代表 Firefox 通过。
3. 接管产物需覆盖安装、更新、禁用、卸载与恢复原生新标签页；标准同步扩展必须验证「普通升级不会新增覆盖声明」。
4. 响应式至少覆盖 1366×768、1920×1080 与 375px 窄屏，并纳入长标题、200% 缩放、键盘操作与深浅主题。
5. 性能与数据量预算（首屏、10,000 节点本地搜索、快照大小）报告时必须附浏览器版本、CPU、缓存大小与样本分布，不只报告最快一次。
