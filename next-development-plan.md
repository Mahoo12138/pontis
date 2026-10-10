# Pontis 下一阶段开发计划

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
