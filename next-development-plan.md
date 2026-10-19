# Pontis 下一阶段开发计划

## 当前计划（2026-10-18）

发布基线：`b8901c5` / [`v0.1.0-alpha.2`](docs/releases/v0.1.0-alpha.2.md)。
以下三轮是当前推进顺序；文末原 A–F 计划保留为历史依据，不再当作全部待开发清单。
按阶段验收推进，不承诺日历工期；本轮工作区实现仍待整体验证与交付，未发布新版本。

### 已具备的基础与仍待验收的边界

- 已有服务端权威对账、增量同步与恢复、备份/撤销、任务、导入导出、发布广场及多用户权限。
  Alpha.2 已包含空间重命名与空空间删除、嵌套多选删除修复、同步调度去重和扩展设置页重构。
- 搜索已有跨空间标题/URL 子串匹配与结果定位；整理已有精确/疑似重复检测、失效链接检查与
  所选删除；起始页已有授权来源、目录浏览、搜索及外观配置。后续应补全流程，不重复造页面。
- CI 已含 Go race tests、客户端检查、单二进制/扩展分发冒烟，以及 Linux + Xvfb 的两个真实
  Chromium Profile。已有同目录重建后身份、绑定与离线改动保留验证；这不等于跨版本迁移。
- 仍待验收：实际发布 ZIP 的首次权限授权、Edge 重启、Server × Extension 跨版本组合、
  升级中断/迁移失败及人工回退、完整备份恢复后设备继续同步。Firefox 适配后置。

### 第一轮：可靠性收口（当前轮）

| 工作项 | 本轮范围 | 当前状态 |
| --- | --- | --- |
| 扩展立即同步 | 修正 popup 点击未调用同步函数，覆盖等待、重复点击、失败重试与暂停绑定 | 已实现，组件回归与类型检查通过；待整体验证 |
| 失效链接条件删除 | 保留扫描 URL 校验，删除事务内核对复检时的 URL/URL 修订及 epoch/节点创建修订；变化返回 `node_changed` | 实现中，待并发回归及集成验收 |
| 发布身份与更新提示 | 保留数字 manifest 版本；提供 release/commit 身份，校验精确 clean tag 或 Docker 显式合法 tag、ZIP 标记与 catalog 一致性，正确比较预发布版本；更新仍由用户手动执行 | 实现中，待构建与产物验证 |
| 双 Profile 与文档 | 验证实际 popup 入口、双端收敛及同目录重建；校准 CI、备份恢复方法与当前计划 | 验证中；文档已更新，待整体验证后复核 |

出口：从用户点击到 worker 与真实书签树的链路可运行；整理并发变化不会误删；实例显示的
发布身份与实际安装包一致；失败不会被写成成功。分别记录组件、HTTP/SQLite、构建产物和
真实 Profile 的证据，不用其中一层替代另一层。条件删除保护复检到删除之间的变化，尚未改变
复检前已发生恢复时的历史扫描语义。长任务 checkpoint 和迁移前备份不在本轮实现范围。

依据：[客户端与扩展](docs/05-client-replica-and-extension.md)、
[整理与搜索](docs/12-organizer-and-search.md)、
[扩展分发与 Release](pontis-extension-distribution-release-v1.md)、
[开发与测试](docs/21-development-and-testing.md)。

### 第二轮：同步状态与搜索

- 同步状态清楚展示本机待上传、远端待应用、最后成功、连接/错误原因及下一步；从 popup
  定位对应 Binding 的恢复操作，协议细节留在展开诊断中。沿用现有状态，不另存一套权威状态。
- 搜索增加空间/目录范围、路径、稳定相关性排序和域名筛选，保留查询条件与结果定位。
  按真实书签规模验证响应速度，再决定分页与服务端查询；不直接引入全文索引。

出口：断网后有本地改动、部分 Binding 异常、暂停后恢复都能读懂并继续；多空间同名书签、
中文/URL 混合查询、结果节点变化、大树和部分读取失败时，查找与定位仍可用。
依据：[诊断与状态](docs/16-diagnostics-observability.md)、
[整理与搜索](docs/12-organizer-and-search.md)、[信息架构](docs/24-information-architecture.md)。

### 第三轮：整理与恢复体验

- 重复组允许选择保留项，展示目录位置与删除清单；整理支持限定范围，问题链接支持分类与
  所选复查，区分暂时不可达和确认失效。继续保留用户主动选择、条件删除和撤销。
- 恢复流程展示将影响的 Space、备份时间、设备与离线改动处理，并给出恢复后的验证入口；
  明确 Space 备份与整实例离线备份边界，补足恢复后设备回连与人工回退演练。

出口：有意重复不被自动删除，扫描过期/部分失败可解释且可重新处理；恢复后的书签树和
在线、离线设备都经正式协议验证，不以“恢复接口成功”代替用户重新可用。
依据：[整理与搜索](docs/12-organizer-and-search.md)、
[初始化与恢复](docs/06-initial-resync-recovery.md)、[备份](docs/14-backup-retention-gc.md)、
[撤销与活动](docs/15-undo-activity.md)。

## 历史计划：从最初基线到内部 Alpha

以下保留原 A–F 目标与回归矩阵，供追溯当时的缺陷和设计动机；当前状态以上面的计划为准。

基线：`6c99a8d8dbaa47f14eede5b9f74c75c5510698c8`。配套评审见 [review.md](review.md)。

## 目标

下一阶段目标不是覆盖所有设计模块，而是得到一个可以用测试账户、真实 Chromium Profile 和可恢复备份验证的内部 Alpha：新安装可用、双端可收敛、失败不谎报成功、恢复后能继续用，且多用户请求不会越过授权边界。

按阶段验收推进，不先承诺日历工期。完成标准是下面的用户旅程与故障用例，而不是类、文件或页面数量。

## 阶段 A：建立真实联调基线，打通首次同步

### PR-A1：非 Mock 的最短用户流程

为固定 main 建立可复现开发环境和基础 CI：Go tests、TS typecheck/unit tests、共享协议 JSON 验证。新增真实 HTTP smoke fixture，使用干净 DB 和临时浏览器数据；不要直接激活 Binding。

验收流程：setup → 登录 → 创建 Space → 注册设备 → 创建 Binding → 读取初始化资料 → 选择保守 merge → 服务端提交 → 客户端验证完成 → 正常 sync。

先加入失败测试再修复 R01、R02。空请求返回数组，生产初始化流程与测试流程一致。

### PR-A2：单一 reconciliation 调用链

将 Server 已有 reconciliation 模块接入 Application Service/HTTP/Extension。编排状态、snapshot 引用、plan revision、commit 幂等、complete 幂等必须真实持久化。无效 plan 不能静默重新规划后执行。

前端只负责本地扫描、local_ref/browser_id 映射、Apply 与验证；Server 负责匹配/计划。可以复用现有代码，但不要保留两套权威合并算法。

**阶段出口：新扩展从零配置成功，不依赖数据库手动改状态；重复 commit/complete 不重复创建节点；无本地操作也能拉取远端更新。**

## 阶段 B：修复浏览器执行与崩溃一致性

### PR-B1：Adapter contract 与排序

修复 R03/R05。明确 createAt、moveTo、removeSubtree、getNode-not-found 语义；Fake 与 Chromium 实现执行同一契约测试。

必须覆盖：非空目录删除；在首/中/尾创建；同父重排；跨父移动；多个相同 URL；同名文件夹；多个 Root；不支持的 separator/本地容器；浏览器 ID 与 canonical ID 不相等。

引入每个 Binding 的 single-flight 协调，不能让 alarm、手动同步、worker wake、recovery 同时回放同一 inbox。内存锁只负责当前运行期并发，恢复依赖持久记录。

### PR-B2：applied watermark 与本地编辑保护

修复 R04。应用无法确认则停止推进并进入 repair/recovery；不得跳过未知 mapping。expected mutation 先记录再调用 API，恢复时基于真实 Browser 检查全部必要属性和顺序。

补充故障点：expectation 前/后、API 前/后、mirror commit 前/后、Inbox commit 前/后、Pending settle 前/后。覆盖 HTTP 在途期间用户继续编辑，确保旧回包不会吞掉新建内容或改写其因果基线。

**阶段出口：两份真实 Chromium Profile 与 Server 在队列清空后，UUID 投影、title、URL、parent、顺序全部一致；注入重启后不重复、不错序，不以忽略差异换取绿色状态。**

## 阶段 C：Server 事务和备份恢复成为可靠底线

### PR-C1：备份存储键与恢复

优先修复 R06/R07，尤其现有测试数据已用于真实书签时应尽早独立提交。Key 改为 opaque UUID；迁移现有 catalog 不盲猜同名文件所有者；给已有碰撞提供检测/告警。

捕获备份使用一致 read snapshot；Restore 完整验证格式/版本/大小/树，再按拓扑写入；epoch 与 baseline stamps 一致；安全备份是明确、可读的恢复前状态。

测试：同名双用户同时备份；路径名称；文件/DB 之间失败；至少三层嵌套且父在非零位置；空 Space；恢复原 UUID；失败 rollback；恢复后第一个 update；离线客户端携带 CREATE/DELETE 回连。

### PR-C2：epoch/receipt/seq 原子边界

修复 R11。明确同步 operation 的提交边界；将 epoch、binding state、max seq 验证放在写事务内，并保证 receipt 与 seq 状态一致落库。响应的 head/changes 要有一致上界；snapshot 的 epoch/revision/nodes 来自同一读取快照。

用可控 barrier 构造：旧 epoch 请求通过早期校验后发生 Restore；receipt commit 前后断进程；同 Binding 重叠请求；重试 body 不同；GC 与拉取并发；max seq 已提交后旧 seq 重来。

**阶段出口：备份先被验证能恢复，才被标识为可靠；恢复后的既有设备和离线设备都能通过正式协议回到 active。**

## 阶段 D：多用户与对外 API 的发布门槛

### PR-D1：统一 Principal/资源授权

修复 R08/R10。实现 API Token authentication、scope、Space 范围、撤销/过期、禁用账户即时拒绝。Device token 不能变为通用账号令牌。给 API/Session/Device 分别测试允许与拒绝矩阵。

补全 Account Security：重置 token 的消费与密码变更应有原子边界；Session Cookie/CSRF/Origin/公开 URL 配置按部署模式验证；不能把不存在的发送能力显示成邮件已发出。

### PR-D2：受控网络检查

修复 R09。只在授权的网络策略下进行 Link Check，默认公网检查；地址/端口、解析、拨号、redirect 的验证必须一致，测试使用本地假服务。结果分类不等于自动删除建议，删除前重新检查目标 UUID 与扫描时 URL/版本。

**阶段出口：普通用户、管理员、只读/读写 Token、禁用用户、被撤销设备都通过正反权限测试；Link Checker 不能默认探测服务器内网。此前不开放公网注册。**

## 阶段 E：任务系统不再“外层持久、内层内存”

### PR-E1：统一 LinkCheck Job

修复 R12。移除按 Space 保存单个内存 run 的第二套任务机制，扫描项以 job_id 固定，结果与进度持久化。Job ctx 下发到请求；取消停止实际工作；重启只重做未完成项；同 Space 并发不会混结果。

在真实 SQLite 上验证 claim/lease/retry/schedule catch-up，执行 `go test -race` 并使用时间/网络可注入的测试。任务摘要不能把 skipped/not_configured 混成成功。

**阶段出口：用户任务、管理员后台任务看到同一事实；删除计划不删除执行历史，暂停计划不伪装取消正在执行的工作。**

## 阶段 F：内部 Alpha 交付与文档收口

### PR-F1：生产构建

根构建命令统一完成 Web build → dist stage → go:embed → Go binary。验证最终二进制没有 Node 运行时依赖，直接访问 SPA 深链有效，未知 API 不回退 index.html。增加最小部署 README、配置示例、迁移失败说明、备份/恢复演练方法。

锁定工具版本与 lockfile；验证根 pnpm filter 对实际 workspace 名称可匹配。不要把单独 Vite build 当成 release。

### PR-F2：UI 与范围对齐

保留冷灰理性工作台与个人设置/实例管理分离。优先修复状态反馈、键盘可达性和危险操作影响说明，不做大面积视觉重写。

明确路由栈 ADR：当前实际用 React Router；若坚持原定 TanStack Router，独立迁移并测试 deep link/search params，不夹带在同步修复中。没有真正实现的配置项应禁用/移除，而不是允许保存后不生效。

Firefox 适配作为后续兼容性阶段：先让 Chromium Alpha 通过真实环境，再补 Firefox root/separator/API 差异测试。跨浏览器产品完成之前，发布说明不能声称已完整支持 Firefox。

**阶段出口：下载一个产物、指定数据目录即可运行；新用户不借助开发者内部方法完成初始化；关键权限、恢复、双设备 E2E 在 CI 或明确记录的验证流程中通过。**

## 必须进入回归矩阵的场景

| 领域 | 场景 | 预期 |
|---|---|---|
| 首次使用 | 干净 DB + 新 Profile | 正式接口完成初始化 |
| 同步空包 | operations=[]，有/无远端变化 | 数组稳定、接收事务成功 |
| API 契约 | 实际 Go JSON 交给 TS codec | 不使用仅类型断言冒充验证 |
| 删除 | 非空 Folder | 原生 API 正确删除子树 |
| 排序 | 首中尾插入，同父/跨父 MOVE | Browser 与 Canonical 顺序一致 |
| ACK | parent mapping 丢失 | 不跳 applied，触发修复 |
| 崩溃 | API 前后与 IDB 前后 | 重启可确认而非重复猜测 |
| 并发 | alarm + manual + wake | 同 Binding 不重叠消费 |
| 恢复 | 多层树，父节点在后位 | 可恢复，UUID 保留 |
| 世代 | 旧请求与 Restore 交错 | 旧 epoch 不进入新基线 |
| 凭据 | 禁用账户的旧 Device/API Token | 一致拒绝 |
| 对外 API | 指定 Space 的只读 token | 读允许，其余拒绝 |
| 网络 | URL 重定向/解析到禁止地址 | 在连接前拒绝 |
| 任务 | 同 Space 双 Job、取消、重启 | 不混结果，可恢复 |
| 备份 | 同名双用户、同秒、失败清理 | 物理对象不会碰撞/误删 |
| 发布 | 嵌入 Web 后打开深链 | 页面有效，未知 API 为 API 错误 |

## 如何防止下一轮继续出现“模块都有、流程不通”

每个 PR 说明只需回答四件事：修复哪个可观察问题；覆盖什么失败场景；测试经过哪些真实边界；仍有什么限制。涉及协议的 PR 同时调整 Go HTTP JSON 与 TypeScript 消费测试。涉及适配器的 PR 用同一契约测 Fake 和真实包装器。

不以“新增了多少功能页面”“新增了多少测试”作为完成指标。最重要的完成指标是：**从公开入口进入的真实用户流程可运行，错误不会伪装成功，所有数据风险都有可重复的回归测试。**
