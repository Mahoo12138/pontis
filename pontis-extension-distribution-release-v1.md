# Pontis 浏览器扩展分发与 Release 方案（V1）

> 状态：拟定的 V1 发布基线  
> 日期：2026-10-14  
> 适用范围：Pontis Monorepo（`server/`、`web/`、`extension/`）  
> 目标阶段：未上架浏览器商店的小规模自托管发布（Early Release）

## 1. 背景与结论

Pontis 已采用 Go Server、内嵌 React Web UI 和 WXT 浏览器扩展。初期用户数量少，暂不计划将扩展公开上架 Chrome Web Store 或 Microsoft Edge Add-ons，希望用户在自己的 Pontis 实例内下载扩展并安装。

**V1 采用「构建时将扩展 ZIP 嵌入 Go 二进制，运行时由 Go HTTP 服务分发」的方案。** 这使 Docker 和裸二进制共享同一套下载资源，无需额外部署静态文件服务器，也不需要在运行时安装 Node.js。扩展与 Web UI 的构建产物分开，但都随同一 Server Release 交付。

同时明确：**Chrome/Edge 的「加载已解压的扩展程序」是开发者模式安装路径，不是商店安装的替代品。** 该路径用于受信任的小规模用户，不承诺无提示安装或商店级自动升级。正式 Firefox 用户则应下载经过 Mozilla 签名的 XPI，而不是把未签名 ZIP 当作可长期安装的 Firefox 扩展。

### 1.1 V1 必须实现

- Server Release 内包含一个可安装的 Chromium ZIP；若 Firefox 已完成签名，则另外包含 XPI。
- Pontis Web 的「设备」页提供扩展下载、安装指南、升级指南、版本与校验信息。
- 扩展 ZIP 是 WXT 生产构建输出，ZIP 根目录包含 `manifest.json`；不分发源代码目录或整个 Monorepo。
- 发布流水线生成构建元数据（版本、SHA-256、适用浏览器、协议兼容范围）。
- 手动升级优先保留原有扩展 ID 和浏览器 Profile，不能要求卸载重装。
- 在真实 Chrome/Edge Profile 中验证首次安装、升级、离线修改保护与恢复流程。

### 1.2 V1 明确不做

- 不自行开发 Chrome/Edge 的远程代码自动安装或热更新机制。
- 不提供用户上传任意 ZIP 来替换正式 Release 的功能。
- 不强制绑定扩展版本与 Server 版本完全相同；只校验能力及同步协议兼容性。
- 不以额外安装器、守护进程或系统级权限来绕过浏览器安装限制。
- 不把私有用户配置、登录 Token、Device Credential、服务器私钥写进扩展安装包。

## 2. 浏览器分发策略

| 平台 | V1 分发产物 | 用户安装方式 | 更新策略 | 状态 |
|---|---|---|---|---|
| Chrome | Chromium MV3 ZIP | 解压至固定目录，开启开发者模式，加载已解压扩展 | 原目录替换文件并重新加载 | 首批支持 |
| Edge | 同一 Chromium MV3 ZIP（通过实机兼容测试后） | `edge://extensions` 加载已解压扩展 | 同上 | 首批支持 |
| Firefox Desktop | **Mozilla Unlisted 签名的 XPI** | 网站下载签名 XPI 或「从文件安装」 | 初期手动；后续可设计自托管更新清单 | 完成签名后支持 |
| Safari | 不提供 | — | — | V1 范围外 |

Chrome 官方将本地加载未打包扩展定位为开发与自用路径；普通消费者的直接扩展安装通常需要 Chrome Web Store，受管理环境有企业策略例外。因此下载页必须标明「手动安装／开发者模式」，不能宣称「一键安装」。

Firefox 的未公开上架与未签名是两个概念。可以申请 Mozilla 的 Unlisted 签名，之后自行托管最终签名的 XPI；未经签名的开发 ZIP 不能作为正式 Firefox Release 提供。

## 3. 分发架构与模块边界

```text
Git Tag / Release Pipeline
   ├── web/         → Vite build → web/dist
   └── extension/   → WXT build → Chromium ZIP
                               └→ Firefox unsigned ZIP → AMO Unlisted 签名 XPI（可选）
                         ↓
             scripts/stage-distribution
                         ↓
server/internal/distribution/artifacts/
   ├── pontis-chromium-vX.Y.Z.zip
   ├── pontis-firefox-vX.Y.Z.xpi  （可选）
   └── manifest.json
                         ↓
                   go:embed
                         ↓
             Go Binary / Docker Image
                         ↓
           Pontis Web「设备 → 安装扩展」
                         ↓
                用户下载与手动安装
```

**职责边界：**

- `extension/`：负责产生跨浏览器可安装产物，以及扩展自身本地数据的兼容升级。
- `server/`：负责嵌入与提供不可变 Release 产物、版本清单及下载接口；不运行构建工具。
- `web/`：负责安装／升级教程、版本展示与下载入口；普通用户可访问，不隐藏在管理员系统设置下。
- `scripts/`：负责跨语言构建编排、文件校验、产物 staging 与 Release 清单生成。

## 4. Monorepo 推荐文件结构

```text
pontis/
├── server/
│   ├── cmd/server/
│   └── internal/
│       └── distribution/
│           ├── embed.go
│           ├── handler.go
│           └── artifacts/             # CI 生成，不提交原始二进制
│               ├── manifest.json
│               ├── pontis-chromium-v0.1.0.zip
│               └── pontis-firefox-v0.1.0.xpi
├── web/
│   └── src/
│       └── routes/                  # 新增设备页中的安装界面或独立下载页
├── extension/
│   └── ...
├── scripts/
│   ├── stage-distribution.mjs
│   └── release.mjs                # 可选
└── ...
```

目录为推荐结构。已经存在的 Web `go:embed` 资源目录保持不变，不需要强行为了扩展分发而迁移整个 Web 文件系统。

**关键实现约束：** Go 的 `//go:embed` 不能直接引用 Go 包之外的 `../extension/dist`。构建必须先复制所需产物到 `server/` 内的嵌入目录，再执行 `go build`。嵌入的是 ZIP/XPI 原始字节；这些文件已经压缩，不需要再套一层 gzip。

## 5. Release 构建流水线

生产构建必须由固定 Git Commit / Tag 和 lockfile 驱动，禁止 Docker 容器启动时执行 `pnpm install` 或临时拉取“最新”扩展代码。

建议阶段：

1. **准备**：检出 Tag，校验 `go.sum` 与 `pnpm-lock.yaml`，记录 commit SHA。
2. **质量门槛**：执行 Go/TypeScript 的静态检查、单元测试、协议测试和必要的浏览器集成测试。
3. **Web 构建**：生成 `web/dist`，按现有流程嵌入 Go Server。
4. **Chromium 构建**：通过 WXT 生成生产扩展 ZIP，核对 Manifest、权限、版本和文件内容。
5. **Firefox 构建（可选）**：使用 Firefox 目标编译，向 AMO 的 Unlisted 渠道提交签名，取得最终签名 XPI 后才纳入分发。
6. **生成分发清单**：对每个最终 ZIP/XPI 计算 SHA-256，记录版本、大小、浏览器目标与兼容约束。
7. **Staging**：复制完整产物进入 `server/internal/distribution/artifacts/`，严格禁止目录穿越及额外文件混入。
8. **编译 Server**：使用 `go build`，生成裸二进制和多架构 Docker 镜像。
9. **烟测**：启动新数据库容器，打开 Web 下载页，下载产物并与构建前 SHA-256 对比。
10. **发布**：推送版本 Tag、Docker 镜像与可选 GitHub Release 备份产物。

WXT 的 CLI 提供 `wxt zip` 和 `-b, --browser` 选项。概念命令：

```bash
# 在 extension/ 目录执行（以当前锁定版本的 WXT CLI 为准）
pnpm exec wxt zip -b chrome --mv3

# Firefox：构建待签名产物，再提交 Mozilla 签名
pnpm exec wxt zip -b firefox
```

不要假定 ZIP 一定输出到固定路径；staging 脚本应使用项目锁定的 WXT 输出配置，读取真实文件并验证 ZIP 结构，不通过模糊通配符“随便选最新一个”。

## 6. Go 内嵌与下载 API

可以由 `distribution` 包统一管理 Release Artifact：

```go
package distribution

import "embed"

//go:embed artifacts/*
var artifacts embed.FS
```

建议接口如下：

| 方法 | URL | 用途 |
|---|---|---|
| GET | `/api/v1/distribution/extensions` | 当前实例可下载的扩展清单 |
| GET | `/downloads/extensions/chromium/v0.1.0.zip` | 固定版本的 Chromium ZIP |
| GET | `/downloads/extensions/firefox/v0.1.0.xpi` | 已签名 Firefox XPI（存在时） |
| HEAD | 与下载 URL 相同 | 内容长度、ETag、Content-Type 等 |

路由是建议契约，正式实现可使用统一命名规范，但同一版本的下载 URL 必须不可变。所有可下载路径应由编译时清单与服务端白名单映射，不允许把请求 URL 任意拼成磁盘路径或 `embed.FS` 的路径。

下载响应：

- ZIP：`Content-Type: application/zip`。
- Firefox XPI：`Content-Type: application/x-xpinstall`（用于 Firefox 网站安装）；如果页面明确是“保存文件”，需确认浏览器实际行为。
- `Content-Length` 与真实嵌入字节一致。
- `ETag` 可以使用内容摘要；版本 URL 不可变。
- `Content-Disposition` 按下载／安装方式选择，Chromium ZIP 使用 `attachment`。
- 提供 SHA-256 校验值和产物大小；客户端下载后不执行远端代码。

V1 默认可以要求登录后访问安装页面及下载接口；若需支持未登录设备引导，可选择公开静态产物下载。无论是否公开，ZIP 中都不能包含任何账户或实例秘密。认证策略应统一，避免“页面要求登录，但文件直链错误地提供用户私有数据”这种设计。这里只分发公共软件包，不承担敏感文件下载能力。

## 7. Release 清单格式

以下为建议格式，所有示例数据仅用于说明：

```json
{
  "release": "v0.1.0",
  "commit": "<git-commit-sha>",
  "artifacts": [
    {
      "platform": "chromium",
      "version": "0.1.0",
      "file": "/downloads/extensions/chromium/v0.1.0.zip",
      "sha256": "<actual-sha256>",
      "size_bytes": 0,
      "manifest_version": 3,
      "sync_protocol_versions": [1],
      "min_server_version": "0.1.0"
    }
  ]
}
```

不公开不存在的 Firefox Artifact。`release` 代表当前 Server 的分发批次，`artifacts[].version` 是扩展版本，两者**允许不同**。扩展通过自己的 `manifest.version` 与 Server 分发清单比较，并判断协议版本及功能兼容，不应使用字符串大小比较代替规范版本比较。

当 Server 暂无更高版本的扩展时，它只表示“本实例内嵌包是哪个版本”，不等于浏览器商店或上游 GitHub 一定不存在更新。

## 8. Pontis Web 的入口与页面

推荐将入口放在普通用户可见的「设备」页面：

```text
设备
├── 已连接的设备
├── 添加设备
└── 安装 Pontis 浏览器扩展
    ├── Chrome / Edge
    │   ├── 下载 ZIP
    │   ├── SHA-256 / 版本 / 发布时间
    │   ├── 首次安装说明
    │   └── 手动升级说明
    └── Firefox（签名产物存在时）
        ├── 下载／安装 XPI
        └── 安装与更新说明
```

UI 延续 **Cold Rational Workspace**：平面布局、清晰步骤与低干扰状态；不放在「管理 → 系统设置」下，不制造一个需要管理员权限才能获取客户端的入口。

页面应明确提示：

- 当前版本与所支持浏览器。
- 安装包来自当前 Pontis 实例，而不是浏览器商店。
- Chrome/Edge 安装需要开发者模式。
- 不应删除、移动加载中的解压目录。
- 手动升级前建议确保同步完成；不能把“导出书签”当成覆盖 IndexedDB 事务状态的等价备份。
- 如果升级后出现 `RECOVERY_REQUIRED`，应走 Pontis Recovery 流程，不清空本地数据或卸载重装。

## 9. Chromium 首次安装

对 Chrome/Edge，推荐写成如下用户操作：

1. 从 Pontis「设备 → 安装浏览器扩展」下载 ZIP。
2. 解压至**稳定的永久目录**，如 Windows 的 `%LOCALAPPDATA%/Pontis/Extension` 或 macOS 的 `~/Applications/Pontis/Extension`。目录路径只是示例，关键是以后不变。
3. 在地址栏打开 `chrome://extensions` 或 `edge://extensions`。
4. 开启「开发者模式」，选择「加载已解压的扩展程序」。
5. 选择**直接包含 `manifest.json` 的目录**，而不是 ZIP 文件或外层套娃目录。
6. 验证扩展显示在列表中，检查扩展 ID；打开扩展，配置 Pontis Server 并完成授权和首次同步。
7. 若浏览器弹出开发者模式警告，应如实说明这是手动安装带来的提示，不指导用户关闭安全保护功能。

官方文档参见文末 Chrome 与 Microsoft Edge 安装说明。

## 10. 升级、扩展 ID 与数据保护

Pontis 扩展不只是 UI：本地 IndexedDB 保存 Binding、Mapping、Pending Operations、Inbox、Expected Mutations 和水位线等数据。**升级成功的定义不是页面能打开，而是同一浏览器 Profile 中上述状态连续、能继续同步且不会静默丢失尚未上传的修改。**

### 10.1 版本与扩展 ID

- 在 Chrome/Edge，扩展 ID 是本地扩展存储与安装身份的重要依据；版本升级应保持扩展 ID 不变。
- 开发模式下可研究 Manifest `key` 公钥字段，使解压后的扩展 ID 更稳定。`key` 是**公开信息**，绝不将 `.pem` 私钥嵌入 ZIP。
- 没有稳定 `key` 时，固定加载路径通常也很重要，但不能把“同目录就一定同 ID”作为未经验证的保证；应在真实浏览器中断言 ID。
- 未来上架商店后 ID 可能变化；从手动版迁移到商店版需要独立迁移／重新配对方案，不能假设扩展本地数据库自然继承。

### 10.2 V1 手动升级流程

1. 在扩展中查看是否有 `QUEUED` 或未完成 Recovery，尽量先完成同步。
2. 下载新 ZIP，验证 SHA-256。
3. 将当前稳定目录复制到本地备份目录，保留原扩展文件；**不卸载旧扩展**。
4. 在临时目录解压新包，验证 Manifest 和预期扩展 ID / 版本；再替换稳定目录中的文件，确保不会残留旧 JS Chunk。
5. 在 `chrome://extensions` / `edge://extensions` 点击「重新加载」。
6. 验证扩展 ID、Device 身份、Binding 数量、IndexedDB schema、未完成操作数量与同步一致性。
7. 如果出现失败，先保留证据并走恢复流程；回退扩展代码不等于可以回退已经升级的 IndexedDB Schema。

替换文件的部署脚本应处理失败恢复，尽量避免在文件替换到一半时执行重载；文件更新方案需要按 Windows/macOS 路径与权限分别测试。

### 10.3 版本提示，不执行远程代码

扩展可在设置页显示「本实例提供更新版本」，通过 `GET /api/v1/device/extensions` 获取元数据，比较版本和兼容范围。扩展只持有设备凭据、从不持有 Web 会话，因此该清单需要一个设备作用域的读取入口；它与会话入口返回同一份内容，不做任何过滤。V1 只提供下载及升级指导，**不自动拉取 ZIP 中的 JS 作为运行时代码执行**。

版本比较按点分数字逐段进行，不用字符串大小比较；版本相同或更旧时保持沉默。任何失败（离线、旧版服务端没有该路由、响应不合形状）都表现为「没有提示」，而不是错误弹窗。

## 11. Firefox Unlisted 签名分发

如果计划在 V1 支持 Firefox Desktop：

1. 使用 WXT 构建 Firefox 目标产物；固定 Gecko Add-on ID，例如邮箱风格的稳定标识。
2. 使用 AMO Developer Hub 或 `web-ext sign --channel=unlisted` 提交签名，并等待成功返回**签名 XPI**。
3. 发布流水线校验签名产物版本、ID、大小与 SHA-256，再嵌入 Go。
4. Web 通过 `application/x-xpinstall` 提供签名 XPI；用户可从 Firefox 网站下载/安装，或从附加组件管理界面安装文件。
5. 后续若做自托管自动更新，必须为签名 XPI 配置有效的 Firefox `browser_specific_settings.gecko.update_url` 和 HTTPS 更新清单，并保证该地址长期稳定。

在未完成签名之前，下载页显示「Firefox 暂未开放」，不得把 WXT 生成的普通 ZIP 改后缀为 `.xpi` 充当正式安装包。AMO 签名凭据仅用于 CI 秘密配置，不进入 Server Binary 或 ZIP。

## 12. Docker 与裸二进制交付

推荐一次 Tag 同时产生：

```text
pontis-server-linux-amd64
pontis-server-linux-arm64
pontis-server-darwin-arm64
pontis-server-windows-amd64.exe
ghcr.io/<owner>/pontis:vX.Y.Z
```

上面的名称仅为示例。Docker 的 Node 与 Go 编译阶段可使用 multi-stage build，**最终镜像只包含 Server Binary、必要的 TLS 根证书及运行目录**；Web/Extension 静态字节已经嵌入 Go，无须再挂载单独的 ZIP volume。

可选在 GitHub Releases 额外附上相同 ZIP/XPI 和 manifest，作为非 Docker 用户的备用下载位置，但 Pontis Web 的安装包必须与当前运行实例的内嵌 Release 保持一致。

不能仅靠 Server Release 的 Tag 断言扩展一定兼容。应独立声明：

- `server_version`
- `extension_version`
- `http_api_version`
- `sync_protocol_versions`
- `database_schema_version`

兼容判断优先依据协议能力、版本范围与真实测试结果。**Server 更新不能破坏仍在使用旧扩展的少量用户**；如确有不兼容升级，须在发布说明中标注及提示先升级扩展。

## 13. 安全与维护约束

- 安装包必须来源于可信 Tag / Commit 的 CI 构建；提交依赖锁文件。
- `ZIP/XPI → manifest.json`、最终 SHA-256、下载回传字节一致性都纳入自动校验。
- 下载接口使用固定 artifact 白名单，拒绝路径穿越；不要从用户提交的文件名直接访问 `embed.FS`。
- 不嵌入 Token、Session、设备 ID、用户书签数据、真实生产 Secret 或签名私钥。
- 生产服务建议 HTTPS；校验码有助于发现下载损坏，但 SHA-256 **不能单独证明发布者身份**，仍需可信下载渠道及可选的 Release 签名。
- 不把升级失败处理成「清空 IndexedDB」「删除 Binding」「重装扩展」。
- 浏览器的开发者模式安装路径有额外操作及提示，文案不得伪装成浏览器官方商店安装。
- 由于每个 Pontis 实例跟随自身 Server Release 分发包，扩展更新频率高于 Server 时应重新评估改为独立 Release Artifact 服务。

## 14. 发布验收（Release Gate）

以下事项没有全部完成时，不应把「已支持手动安装和升级」列为正式能力。

### 14.1 安装与分发

- [ ] Chromium ZIP 顶层有有效的 `manifest.json`，不是源码包。
- [ ] Web 下载页面、下载链接、版本、SHA-256、安装说明一致。
- [ ] Docker 内下载的字节与 Release 生成文件 SHA-256 完全一致。
- [ ] 新 Chrome Profile 安装、登录、首次绑定、首次同步完整通过。
- [ ] 新 Edge Profile 完成同样操作。
- [ ] 浏览器重启后扩展仍保持正常安装与连接。
- [ ] 用户未安装扩展时也能访问相关安装说明；正式下载权限符合产品策略。

### 14.2 数据连续性与升级

- [ ] 固定安装目录同路径升级后 Extension ID 保持稳定。
- [ ] 同 Profile 中 Device ID、Binding、Local Mapping、watermark 保留。
- [ ] 升级前存在离线 Pending Operations，升级后不会被无提示丢弃。
- [ ] 下载失败、ZIP 损坏、解压失败、替换中断不会破坏旧扩展安装。
- [ ] IndexedDB Migration 失败时保留数据并显示可恢复错误。
- [ ] 服务端离线时扩展仍保留本地状态，恢复联网后继续同步。
- [ ] Server 与 Extension 各自升级的兼容矩阵通过测试。
- [ ] 不兼容的 Sync Protocol 显示明确错误，不静默清空本地数据。

### 14.3 Firefox（若本批次发布）

- [ ] 完成 Mozilla Unlisted 签名，产物为签名 XPI。
- [ ] Add-on ID 稳定，Firefox 正式版安装及重启正常。
- [ ] XPI 下载使用合适 MIME 类型，校验 SHA-256 与版本。
- [ ] Firefox 特有 API 的首次同步、重启和升级测试通过。

### 14.4 发布流程

- [ ] Release Build 来自确定 Tag 与依赖锁文件，不含手工覆盖产物。
- [ ] Tag、Server Binary、Docker、Artifact Manifest 中版本来源一致且可追溯。
- [ ] 新数据库 Docker 启动、Web 可访问、安装包可下载。
- [ ] Docker 镜像中无需 Node.js、pnpm 或 WXT 运行时。
- [ ] Release Notes 记录安装方式、已知限制与升级说明。

## 15. 开发实施顺序

| 优先级 | 任务 | 完成标志 |
|---|---|---|
| P0 | 固定 WXT Chromium 产物构建与校验 | 可重复生成 ZIP，包含正确 Manifest |
| P0 | 分发清单生成、Go embed、下载接口 | Docker 与裸二进制可返回一致字节 |
| P0 | 设备页安装说明与下载 UI | Chrome/Edge 用户可按说明安装 |
| P0 | 扩展身份与状态连续性升级测试 | 不卸载升级，原本地状态保留 |
| P0 | 空库首次同步与真实浏览器回归 | 用户不需开发者直接改数据库/状态 |
| P1 | 扩展检查本实例可用新版本并提示 | 仅提示更新，不执行远端代码 |
| P1 | 自动化 Release CI、多架构 Docker、Release Notes | 一次 Tag 得到所有目标产物 |
| P1 | Firefox Unlisted 签名及安装 | 签名 XPI 可用于正式 Firefox |
| P2 | 独立扩展 Release、真正商店分发、迁移工具 | 用户增长后按需求推进 |

**是否进入下一阶段的判断：** 先让一位没有开发背景的可信测试用户，在全新 Chrome/Edge Profile 中按 Web 页面指引完成安装、首次同步与一次手动升级；升级前后既有书签与离线修改全部得到保护。达到这一点，Pontis 的 Early Release 分发链才能认为完成。

## 16. 待确认的发布决策

1. 初期只向已有账户开放下载，还是允许登录前下载软件包？建议 **下载页随普通用户设备管理开放**，未登录可保留简短安装指南；静态安装包可按部署需求开放。
2. Chrome/Edge 是否共用同一个 ZIP？建议首批共用，但通过双方真实安装测试后才能在页面同时标注支持。
3. Firefox 是否进入首批 Release？建议不阻塞 Chromium 首次发布，签名完成后再纳入。
4. 是否公开 GitHub Releases 镜像产物？建议可选，但运行中实例应始终提供对应二进制内嵌版本。
5. 扩展代码与 Server 不同步更新时如何分发？V1 允许重新构建 Server Release；需求增长后再拆分独立 Artifact 通道。

## 17. 官方参考资料

- [Google Chrome — Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Google Chrome — Distribute your extension（自托管与商店分发限制）](https://developer.chrome.com/docs/extensions/how-to/distribute)
- [Microsoft Edge — Sideload and reload extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/getting-started/extension-sideloading)
- [WXT — Publishing and ZIP packaging](https://wxt.dev/guide/essentials/publishing.html)
- [WXT — `wxt zip` CLI](https://wxt.dev/api/cli/wxt-zip)
- [Mozilla — Signing and distribution](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)
- [Mozilla — Self-distribution](https://extensionworkshop.com/documentation/publish/self-distribution/)
- [Mozilla — Installing self-distributed add-ons](https://extensionworkshop.com/documentation/publish/install-self-distributed/)
- [Mozilla — Updating your extension](https://extensionworkshop.com/documentation/manage/updating-your-extension/)

---

**最终决策：** Pontis V1 采用 **Go Binary 内嵌 ZIP/XPI + Web 下载指引 + 浏览器手动安装/升级**，将其定位为可测试、可维护的小规模 Early Release 方案；数据连续性与真实浏览器验收必须先于扩大分发范围。未来用户规模扩大时，逐步迁移至浏览器商店与更完善的自动更新机制。
