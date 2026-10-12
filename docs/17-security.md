# 17. 安全模型与威胁边界

## 1. 信任边界

系统不宣称在攻击者已经取得 Server 主机/root、进程、SQLite 与 instance key 后仍能保护 Private Bookmark/Secrets。

重点防御：

- 跨用户越权；
- Session/Token 泄漏；
- CSRF/XSS；
- SSRF；
- 恶意 Import/Backup/Publication；
- Proxy/Header spoof；
- 错误日志泄密；
- Extension Credential 过权；
- 无边界资源消耗。

## 2. Authorization / IDOR

资源 ID 永远不是 capability。

```text
space_id
node_id
backup_id
publication_id
```

都必须结合 Principal 权限检查。

Private resource 统一 Owner Boundary；Repository query 能带 owner filter 时进一步纵深防御。

## 3. Session

Opaque Server-side Session：

```text
HttpOnly
Secure
SameSite=Lax
```

Server 只存 token hash。

Login 成功创建全新 Session，避免 fixation。

## 4. CSRF

Session-authenticated mutation API：

```text
SameSite=Lax
+ Origin validation
```

CSRF token 这一层未实现，理由与补上的触发条件见 doc 09 §8。

Bearer Device/API tokens 不依赖 Cookie。

## 5. CORS

生产 Web UI 与 API 同源，默认不启用泛化 CORS。

Browser Extension 使用 host permission + Device Credential。

禁止为了 Extension 设置：

```text
Access-Control-Allow-Origin: *
```

覆盖所有 API。

## 6. XSS / CSP

Bookmark title/url、folder name、Publication 内容全部不可信。

React 默认 escaping；不要使用 `dangerouslySetInnerHTML` 渲染用户内容。

若支持 Markdown，必须 sanitize。

生产 CSP 目标：

```text
default-src 'self'
script-src 'self'
connect-src 'self'
```

其余按实际 build 最小化放行，不默认 unsafe-eval。

## 7. URL Scheme

Sync/Import 保存 raw URL，不做 normalization。

但 Web UI click policy 独立：

- http/https 正常打开；
- custom scheme 明确提示；
- `javascript:` Bookmarklet 可以保存/导入，但**绝不能在 Server Web UI Origin 中执行**。

Bookmarklet 可提供“复制代码”之类安全操作。

## 8. Publication

Publication 来自其他用户，内容同样不可信。

Import Publication 只复制数据，不能主动访问每一个 URL。

外链使用 appropriate `noopener noreferrer`，并显示目标 host。

## 9. Link Checker SSRF

默认 network policy 建议 `Public Only`。

可由管理员显式允许 LAN，用于 Home Assistant/NAS/router 等自托管书签。

无论模式都要：

- resolve hostname；
- 验证实际连接 IP；
- redirect 每跳重新校验；
- 防 DNS rebinding；
- 限制 metadata/link-local/special ranges；
- timeout；
- redirect count；
- response bytes；
- global/per-host concurrency。

Link Checker 使用独立无状态 HTTP client，不携带 Server cookies/Authorization。

URL userinfo/query 等敏感片段在 log/diagnostics 中必须 redact。

## 10. Extension Token

跨浏览器无统一 OS Keychain，V1 Device Secret 存 `browser.storage.local`。

因此必须 least privilege：

- 只能 own device/binding replica operations；
- 不给 broad account/private API；
- 支持 Server-side revoke；
- diagnostic export 不包含 token。

Manifest 只申请实际需要权限，例如 bookmarks/storage/alarms 与用户配置 Server host permission。

## 11. Server Secret Store

SMTP Password、WebDAV、S3 Secret、OAuth Refresh Token 等 Web UI 可配置 Secret 使用 encrypted Secret Store。

实例首次启动生成 `data/instance.key`，Secret ciphertext 存 SQLite。

目标是防 accidental DB dump/log/diagnostic exposure，不宣称对已控制主机的攻击者保密。

Secret：

- API GET 不回显原文；
- 不进入 Bookmark Logical Backup；
- 不进入 diagnostic bundle；
- 不进入 logs。

## 12. Import / Backup Input

即使是系统自己的 backup archive，Restore 前仍视为不可信：

- checksum；
- format/schema version；
- max sizes；
- node/tree validation；
- duplicate ID；
- cycles；
- parent validity。

不要任意解压路径，避免 Zip Slip。

## 13. Bound Everything

限制：

- HTTP body；
- sync operations per batch；
- snapshot size；
- import nodes；
- tree depth；
- title/url length；
- Job concurrency；
- request timeout；
- Link response bytes。

对于单机自托管服务，这比给所有 API 粗暴低速率 limiter 更关键。

## 14. Login / Reset Rate Limit

重点保护：

- login；
- register；
- forgot password；
- invite redemption；
- extension login。

采用短期退避/速率限制，不使用容易被 DoS 的永久 account lockout。

## 15. Reverse Proxy

默认不信任：

```text
X-Forwarded-For
X-Forwarded-Proto
X-Forwarded-Host
```

只有来源匹配配置的 trusted proxy CIDR 才解析。

Password Reset / Invite Link 永远基于管理员配置的 `public_url`，不信任 Host header，防 host poisoning。

## 16. 安全日志

统一 Redaction：

- password；
- session/CSRF/API/device tokens；
- reset/invite token；
- SMTP/S3/WebDAV secret；
- full sensitive URL；
- private title 默认不写。

## 17. 供应链

提交：

```text
go.sum
pnpm-lock.yaml
```

CI frozen lockfile。

Release 记录 server version、commit、Go version、extension version，便于诊断与漏洞响应。

## 起始页的隐私与执行边界

[起始页 V1](./features/start-page-v1.md) §16 补充以下约束：

1. 标题、URL 与文件夹名称一律按文本渲染；只有 `http:` / `https:` 可导航，且实际跳转使用**校验后的解析结果**，不是存储的原始字符串。
2. `javascript:`、`data:`、`file:`、浏览器内部协议与其他未支持协议在 V1 只提供复制，不在 Web 或扩展 origin 内执行；包含混淆控制字符的地址不得在校验后原样绕过。
3. 页面打开不触发对每个网站的自动请求，也不调用第三方 favicon 服务；图标缺失时使用中性占位。
4. 书签搜索在本地快照内完成，搜索词不发送到 Server 或第三方；网页搜索只在用户显式提交后发生网络导航，不经 Server 代理。
5. 日志只记录错误码、数量、耗时与受控内部标识，不记录搜索词、完整书签 URL 或请求体。
6. **Server 无法远程收回已落到离线设备上的明文缓存**：本机解除来源或解除配对时立即清理；远程侧的撤销（设备被吊销、账户被禁用、空间被解除绑定）要等设备重新联机并被验证后才生效，文案不得承诺离线设备上的即时远程擦除。
7. 起始页沿用所需 Server 的 host permission，仅为浏览器默认搜索申请 `search`；不因新页面申请 history、cookies 或注入能力。
