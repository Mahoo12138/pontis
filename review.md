# Pontis 代码评审与风险清单

评审日期：2026-10-09。仓库：Mahoo12138/pontis。基线：main 的 `6c99a8d8dbaa47f14eede5b9f74c75c5510698c8`，提交时间为 2026-10-06 19:38:53 UTC。

## 1. 结论与验证范围

**下一阶段应由“增加功能模块”转为“打通真实用户流程，并验证数据正确性”。现有代码值得继续建设，不建议推倒重写；但现在不应将真实书签库交给它作为唯一可靠副本，也不宜直接开放多人公网使用。**

仓库已具备 canonical、sync、device、reconcile、backup、changeset、jobs、schedule、organizer 等模块，Web 页面、扩展核心和测试也已有相当实现。主要风险是模块之间没有形成一致的生产调用链，以及模拟器行为比真实环境宽松。

本次通过 GitHub 连接器读取固定提交的路由、服务、SQLite 实现、迁移、扩展核心、适配器、前端路由、构建配置及相关测试。没有修改代码、提交 commit 或创建 Issue/PR。容器无法解析 GitHub 下载域名，远程电脑工具也不可用，因此**没有完整运行仓库的 Go/TypeScript 测试、真实浏览器 E2E 或构建**。提交说明中的测试通过记录属于作者报告，并不是本次复测结果。

另外执行了独立最小复现：Go JSON 空数组语义、备份名称碰撞及路径拼接、扩展排序选择逻辑、恢复时 SQLite 即时外键约束。它们使用本地 Go 1.23.2、Node 22.16.0、Python SQLite 3.46.1，不导入整个仓库，不应冒充仓库回归测试。代码与输出位于 `repro/`。

优先级约定：P1 为真实数据/主流程/多用户安全方面必须先修的问题；P2 为完成产品闭环前需补的实现缺口与工程风险。静态确认表示调用链或条件在代码中可明确定位，不代表已经对部署实例实施利用。

## 2. 关键发现

### R01 · P1 · 新设备没有可达的初始化完成路径

`device.Service.BindSpace` 创建 `pending_initial` Binding；`sync.Service.Sync` 与 `Snapshot` 均要求 `active`。现有 Router 没有暴露 reconciliation plan/commit/complete 或等价的初始化激活流程，`app.Run` 也没有将保留下来的服务端 reconciliation 引擎接入 HTTP。扩展 InitialSyncEngine 使用普通 `/sync` 和 snapshot，因而新安装的正常用户流程会卡在 Binding 状态检查。

测试中的 `bootstrapFlow` 直接调用 `srv.Devices.ActivateBinding(...)`，明确绕过了初始化验证。因此该测试可以验证“已经激活后的同步”，不能证明“新用户首次使用”可用。

修复方向：接入正式初始化生命周期；允许已授权且 pending 的设备读取初始化所需快照；服务端生成并提交经确认的计划，客户端验证后完成 Binding。不要仅在创建 Binding 时无条件置为 active，这会绕过首次合并、覆盖预览和本地数据保护。

验收：从空 SQLite、空扩展存储出发，仅通过公开接口完成 setup、登录、注册设备、绑定、首次对账、正常增量同步。测试不得直接调用 ActivateBinding 或改数据库绕过流程。

代码依据：[server/internal/device/service.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/device/service.go)；[server/internal/httpapi/server.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/httpapi/server.go)；[server/internal/httpapi/httpapi_test.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/httpapi/httpapi_test.go)；[server/internal/sync/snapshot.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/sync/snapshot.go)；[server/internal/app/app.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/app/app.go)；[extension/src/core/sync/initialSync.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/sync/initialSync.ts)。

### R02 · P1 · 空操作同步响应会破坏客户端消费

`handleSync` 只初始化了 `Changes` slice，没有初始化 `OperationResults`。当 `operations` 为空时，后者以 nil slice 经 `encoding/json` 编码为 `null`。扩展 `SyncCoordinator` 却直接执行 `for (const r of resp.operation_results)`，会抛 TypeError；整个接收事务不能提交。

这不是边缘请求：没有本地编辑、仅拉取其他设备修改时，就需要发送空 operations。TypeScript 的 `json as T` 只绕过类型检查，不会改变运行时值。

修复：所有协议数组明确返回 `[]`；接收端对响应结构做运行时验证，错误响应不能推进 received watermark。将 empty response、remote-only、all-conflict、retry、分页纳入实际 HTTP JSON contract tests。

独立复现已得到 `{"operation_results":null,"changes":[]}` 及 TypeError。

代码依据：[server/internal/httpapi/handlers.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/httpapi/handlers.go)；[extension/src/core/sync/syncCoordinator.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/sync/syncCoordinator.ts)；[extension/src/core/transport/client.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/transport/client.ts)；[server/internal/httpapi/fixtures_test.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/httpapi/fixtures_test.go)。

### R03 · P1 · Chromium Adapter 与 Fake Adapter 的删除契约不一致

实际 `createChromiumAdapter.remove` 调用 `chrome.bookmarks.remove`；FakeAdapter.remove 则递归删除整个子树。Chrome 官方 API 中，remove 仅用于书签或空文件夹，非空目录递归删除需使用 removeTree。

因此 Server 发出“删除非空目录”的 Canonical Change 后，Fake 测试可以通过，实际 Chromium 却会失败。另一个需要一并修正的边界是 getNode：真实 `bookmarks.get` 对不存在 ID 的拒绝需要转换为明确的 not-found 结果，而不是依赖返回空数组。

修复：把适配器的删除语义明确定为 removeBookmark/removeSubtree，或在适配器内部识别类型；将真实 API 的 not-found、非空目录和事件顺序约束加入 adapter contract tests。Fake 不应比真实 API 更宽松而掩盖错误。

代码依据：[extension/src/core/browser/chromium.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/browser/chromium.ts)；[extension/src/core/browser/fakeAdapter.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/browser/fakeAdapter.ts)；[extension/src/core/sync/remoteChangeApplier.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/sync/remoteChangeApplier.ts)；[extension/src/entrypoints/background.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/entrypoints/background.ts)。

官方依据：[Chrome bookmarks API](https://developer.chrome.com/docs/extensions/reference/api/bookmarks)。

### R04 · P1 · 未真正执行的远端变化也会推进 applied_revision

`applyCreate` 在找不到目标 parent mapping 时记录 warning，然后调用 advanceTo；update/move 在节点或 parent unmapped 时也采用同样做法。recover 还有在 mirror 不存在时丢弃 expectation 并推进 revision 的分支。

这使 `applied_revision` 从“已验证的连续 Canonical 状态”退化为“已经看过消息”。如果问题发生在本应同步的范围内，服务端之后不会再次补发该变化，浏览器可能缺数据但状态显示已同步。

修复：区分显式排除的投影节点与应存在但缺失的 mapping。后者必须阻止 applied 推进并进入修复；只有真实浏览器状态确认满足，或协议明确可忽略该投影变化时才 ACK。不要用 warning 替代正确性处理。

验收：移除一个本应存在的父 mapping 后下发 CREATE；客户端必须进入明确的可恢复状态，applied 保持前一连续 revision，不能静默跳过。

代码依据：[extension/src/core/sync/remoteChangeApplier.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/sync/remoteChangeApplier.ts)。

### R05 · P1 · 排序执行与崩溃恢复会产生“Mirror 正确、浏览器错误”

存在三个具体问题：

1. 远端 create 没有传入 index，实际适配器也不接收/转发该值，却在 mirror 记录 Server 的 position。
2. browserIndexForPosition 用 browser ID 与 canonical UUID 比较来跳过移动项，同时查找 `position > target` 的 sibling。A0/B1/C2 将 C 移到 0 的简单例子会选中 B 前，得到 A/C/B，而不是 C/A/B。
3. recover 对 MOVE 只检查 parent 相等，不检查顺序。同父重排在“写入 expectation 后、调用 API 前”崩溃，重启即可错误认定操作已完成。

修复：顺序必须以实际浏览器 sibling 序列验证；分清 browser ID/canonical ID；插入与移动统一计算目标位置；移动完成后维护受影响 sibling 的 mirror 状态；恢复确认至少检查 parent 与投影后的相对顺序。

独立复现已得到 `move_C_to_position_0=A,C,B`，同时 parent-only 检查在未移动时返回 satisfied=true。

代码依据：[extension/src/core/sync/remoteChangeApplier.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/sync/remoteChangeApplier.ts)；[extension/src/core/browser/chromium.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/browser/chromium.ts)。

### R06 · P1 · 备份物理文件名存在碰撞及目录逃逸风险

Create 将备份放在共同目录，文件名仅由 `Space.Name + 秒级时间 + kind` 构成，生成的 Backup UUID 没有进入 storage key。同名空间在同一秒创建同种备份时，会写同一路径；os.WriteFile 会覆盖已有内容。不同用户都创建 Personal Space 是正常使用方式，因此这不应依赖人为避免。

Space.Create 只拒绝空名称，没有禁止路径段。名称参与 filepath.Join 后，带 `../` 的名称可以让目标路径离开备份目录，实际影响范围取决于运行账户的文件权限与现有目录。此处确认的是路径逃逸，不夸大为可任意覆盖指定系统文件。

此外，Delete 先删除 catalog，再忽略文件删除错误；创建失败清理同名路径也可能误删先前备份。

修复：存储 key 使用不透明 UUID，必要时加 owner/space 分层；用户可读名称只用于下载文件名。写临时文件后可靠发布；文件与 catalog 使用可恢复的状态转换；删除失败保留可重试记录。

验收：同名双 Space/双用户并发备份、同一秒重复创建、路径段名称、文件写成功但 catalog 插入失败、删除失败。检查彼此内容不会覆盖或误删。

代码依据：[server/internal/backup/backup.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/backup/backup.go)；[server/internal/space/space.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/space/space.go)；[server/internal/app/app.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/app/app.go)。

### R07 · P1 · 恢复流程存在写入顺序、基线与重连问题

备份来自 ListNodes 的 `ORDER BY position,id`，这是跨父目录的排序，不是父节点优先的拓扑序。ReplaceBaseline 按数组顺序逐行 INSERT；nodes 的 parent FK 是即时约束。正常树中，一个位于 root 第 2 项的 Folder，其 position=0 的子项会先于 Folder 导出，恢复时触发 FOREIGN KEY constraint failed。事务回滚会保护原树，但备份无法恢复。

另一个明确不一致是：恢复后 Space.current_revision=0，节点的 created/title/url/structure revision 却全部初始化为 1。同步基线与字段版本不一致，会干扰后续冲突判断。

最后，所有 Binding 被设回 pending_initial，碰上 R01 的不可达状态；旧设备不能自动完成设计中的 Full Resync/Recovery。

修复：先完整验证备份、拓扑排序父先子后写入，或在受控设计下使用延迟约束并完成全树验证；baseline 统一为 epoch 新值、revision/stamps=0；通过真实恢复协议重连。分配新 epoch 与替换应在写事务内检查当前值，不能依赖事务外预读。

独立 SQLite 复现：备份顺序 a-root/c-child/b-folder；按现逻辑重建触发外键错误并回滚。并未直接运行仓库 Restore API。

代码依据：[server/internal/store/sqlite/library.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/store/sqlite/library.go)；[server/internal/store/sqlite/backup.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/store/sqlite/backup.go)；[server/migrations/000002_canonical.sql](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/migrations/000002_canonical.sql)；[server/internal/sync/snapshot.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/sync/snapshot.go)。

### R08 · P1 · 禁用账户没有覆盖 Device Credential

管理员禁用用户时更新 users.status 并删除 sessions。Device.Authenticate 只校验凭据与设备自身 revoked_at；其底层凭据查询不关联 users.status。因此用户网页退出，并不代表其已激活扩展被阻止同步。

修复：Session/API Token/Device 三种认证均校验当前用户状态，后台写入在必要边界重验。暂停与 revoke 的语义可以不同，但 disabled 期间必须全部拒绝。

验收：用户已有 active binding 后由另一管理员禁用；旧 Device Token 对 `/sync`、snapshot、transfer、catalog 的请求都应失败。重新启用是否恢复原凭据，应按统一策略测试。

代码依据：[server/internal/httpapi/admin.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/httpapi/admin.go)；[server/internal/device/service.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/device/service.go)；[server/internal/store/sqlite/device.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/store/sqlite/device.go)。

### R09 · P1 · Link Checker 暴露服务器网络访问能力

httpChecker 仅设置超时、重定向次数和读取长度，直接使用普通 http.Client 请求存储的 URL。这里没有目标 IP/端口/网络策略、DNS 解析后校验、跳转目标重新校验等边界。多用户环境下，该功能就允许用户借服务器访问其本不能直连的地址。

修复：默认拒绝私网/loopback/link-local/metadata 等敏感目标；合法 LAN 扫描由实例管理员明确配置 allowlist，而不是让普通用户随意开关。必须对解析结果、真实连接目标和每次 redirect 进行校验；不通过一次 host 字符串检查后再次自由解析。

验收：仅在本地测试服务器与受控假 resolver/dialer 中验证，不对真实内网进行探测；包括 IPv4/IPv6、DNS 结果变更、公开站点跳转私网、用户信息 URL、非 HTTP scheme、超时与响应限制。

代码依据：[server/internal/organizer/organizer.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/organizer/organizer.go)。

官方参考：[OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。

### R10 · P2 · API Token 已有管理界面，但没有真正接入认证链

token.Service 实现创建、列出、撤销及 Scope 保存，没有按 token hash 认证的接口。普通领域路由使用 requireSession，而 requireSession 只调用 Auth.VerifySession。因而“成功创建 API Token”并不等于外部程序能用它读取书签。

修复：独立建立 API Token principal，执行 token revoked/expiry、user status、scope 与 Space 范围校验；不要将 API Token 当 Session，或因此允许其调用管理端与 Replica 协议。

验收：用真实创建的只读 token 读取指定 Space；写入、跨 Space、跨用户、设备同步、管理员接口均被拒绝；撤销后立即失效。

代码依据：[server/internal/token/token.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/token/token.go)；[server/internal/httpapi/server.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/httpapi/server.go)。

### R11 · P1 风险 · 同步与 Snapshot 的事务边界仍需并发验证

Sync 在事务外检查 Binding/epoch/floor，然后每条 operation 开独立事务，最后单独更新 Binding 水位。Snapshot 同样先读 Space revision，再另行查询 nodes；这并不自动保证两次读取来自同一数据库快照，即使连接池只有一个连接也可能在语句之间被其他请求插入。

风险包括旧 epoch 请求跨过 Restore 后提交、回包 head 与变化范围不一致、revision 标签和 snapshot 内容不对应、receipt 已提交但 max_client_seq 未原子推进。LoadJournalChanges 也没有固定上界参数，应与回包 head 一起确定稳定读取范围。

这是基于代码边界确认的并发风险，本次没有做真实并发/进程崩溃重现，不能声称所有交错均已验证失败。

修复：在同一个写事务中重读关键 epoch/绑定/序列状态，并与 mutation、journal、receipt、seq 水位原子提交；snapshot 用单一 read transaction 捕获 epoch/revision/roots/nodes。是否整个 batch 原子或逐 op 原子必须明确，但任一种都不能绕过这些边界。

代码依据：[server/internal/sync/service.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/sync/service.go)；[server/internal/sync/snapshot.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/sync/snapshot.go)；[server/internal/store/sqlite/sync.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/store/sqlite/sync.go)；[server/internal/store/sqlite/sqlite.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/store/sqlite/sqlite.go)；[server/internal/store/sqlite/backup.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/store/sqlite/backup.go)。

### R12 · P2 · Link Check 仍有独立内存任务与数据竞争

外层 Job System 已存在，但 organizer 仍把每个 Space 最新 run 放在内存 map，通过独立 goroutine 执行。写入 run.Results/Done/FinishedAt 使用 execute 内的局部 mutex；LinkResults 读取同一对象使用 Service.mu，二者不是同一把锁，因此不能形成互斥。

任务取消使外层 handler 退出，但实际请求从 context.Background 派生，不跟随 Job context 停止。结果未持久化，Server 重启不能按 item checkpoint 继续；同一个 Space 并发 run 还会替换 map 中的引用，外层按 Space 轮询可能观察到另一场扫描。

修复：让 Link Check 成为真正的 Job handler，以 job_id+item_id 持久化工作与结果；统一 context 与锁；恢复扫描未完成项；不维护第二套并行任务系统。mail.send 占位处理也不应把“未发送”当成功交付，应禁用能力或明确 skipped/not_configured。

验收：race detector 下同时写结果与读取进度；同 Space 两个 Job 不混结果；取消停止请求；重启恢复剩余工作。

代码依据：[server/internal/organizer/organizer.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/organizer/organizer.go)；[server/internal/app/jobs.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/app/jobs.go)。

## 3. 工程与产品完成度

**可保留的基础。** Go 侧 chi/database/sql/SQLite 的路线清晰；分离 canonical/sync/device/backup 等模块有价值；扩展已围绕 durable queues、expected mutations 和水位组织；Web 已有个人设置与 `/admin/users|jobs|system` 的路由隔离。无需因这些问题改成微服务或更换整个技术栈。

**需要收口的分叉。** 最新合并保留服务端 reconcile 引擎，但现有初始化仍在扩展内自行匹配并通过普通 sync 推进。应以可执行的生产调用链选定单一实现，而不是让多个“文档对应模块”各自通过自己的测试。

**路由栈。** web/package.json 同时列出 TanStack Router 与 react-router-dom，实际 app.tsx 使用后者。此处应作明确 ADR：继续当前路由并更新文档，或安排独立迁移。不要两套长期并存，也不要为了原设计一致性把迁移置于同步正确性之前。

**单二进制交付。** app.Run 当前装配 API；根 build 脚本只面向 Web，未见 dist staging/go:embed 的实际入口。需要补生产构建与静态分发验证。不能把 Web 独立 build 成功当成完整产品可部署。

**真实测试入口。** 已读测试暴露两个重要盲区：手动激活 Binding 绕过用户流程，以及 Fake 的递归删除比 Chromium 实现宽松。下一阶段要把验收条件从“多少包/多少测试通过”改成“哪些用户旅程已通过真实边界”。

代码依据：[server/internal/app/app.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/app/app.go)；[web/src/app.tsx](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/web/src/app.tsx)；[web/package.json](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/web/package.json)；[package.json](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/package.json)；[server/internal/httpapi/httpapi_test.go](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/server/internal/httpapi/httpapi_test.go)；[extension/src/core/browser/fakeAdapter.ts](https://github.com/Mahoo12138/pontis/blob/6c99a8d8dbaa47f14eede5b9f74c75c5510698c8/extension/src/core/browser/fakeAdapter.ts)。

## 4. 暂缓事项

暂缓更复杂的广场版本订阅、智能整理、搜索引擎升级、更多备份 Provider、视觉大改和大规模包重构。简单页面修复可并行，但不应挤占真实首次同步、排序/删除、恢复和权限的验证时间。

不建议继续扩充设计文档来代替验证。只补充能约束本次缺陷的 ADR、协议契约与验收矩阵，例如 applied 水位定义、initial completion、snapshot 原子性、BackupKey 与 Device Auth Policy。

## 5. 最小复现摘要

详见 `repro/results.txt`。其中每项都只是隔离语义检查：

| 项目 | 观察结果 |
|---|---|
| 空 slice 的 HTTP DTO 构造方式 | operation_results=null |
| JS 对该字段 for-of | TypeError |
| 同名、同秒、同 kind 备份 | 文件 key 相同 |
| 用户名称包含父路径段 | 拼接结果离开 backups 目录 |
| C 从 A/B/C 移到 position 0 | 当前 index 选择得到 A/C/B |
| 同父 MOVE 在 API 调用前崩溃 | parent-only probe 错误返回满足 |
| position,id 顺序直接恢复 | 子先父后时外键失败 |

这些检查提高了对缺陷机理的置信度，但不能替代在修复分支中新增真实 Go、Dexie、HTTP 和 Chromium 回归测试。
