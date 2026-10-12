# REST Golden Fixtures

Web 端消费的 REST 响应体（doc 08）。`fixtures/protocol/` 钉住的是
`/sync` 与对账生命周期；这一批钉住 `@pontis/api` 里 `client.get<T>()`
真实读到的形状。

在此之前，`@pontis/api` 只做 `res.json() as T`：类型断言让编译器闭嘴，
不改变运行时的值。服务端把某个数组字段发成 `null`（R02 在 `/sync` 上
就是这么炸的）到浏览器里表现为一片空白列表，而不是一次失败。

## 生成与验证

- **Go（server，事实来源）**：
  `server/internal/httpapi/rest_fixtures_test.go` 起真实 router +
  干净 SQLite，用公开接口走完 setup → login → 建 Space → 建节点 →
  注册设备 → 绑定 → 建备份/计划/任务，把响应体写到这里。
  重新生成：

  ```sh
  cd server && go test ./internal/httpapi -run TestGoldenRESTFixtures -update-rest-fixtures
  ```

  不带 flag 时逐字节比对，漂移即失败。
- **TypeScript（web）**：`packages/api/test/rest-contract.test.ts`
  用 `packages/api/src/contract.ts` 的运行时校验器读取同一批文件，
  并要求每个 fixture 都被某个校验器认领——新增 golden 文件而无人
  校验会让测试失败。

## 归一化了什么

为了文件可复现，写入前只替换时钟与随机值：

| 原始值 | 归一化后 |
| --- | --- |
| UUID | `id-1`、`id-2`… 按首次出现顺序，跨字段引用关系保留 |
| RFC 3339 时间戳 | `2026-01-01T00:00:00Z` |
| 备份文件名里的 `20060102-150405` | `20260101-000000` |
| 备份 `size_bytes` | 固定 1024 |
| 字段名是 `token` / `secret` 的一次性凭据 | `one-time-secret` |
| 重置链接里的 `token=…` | `token=prs_the-reset-token` |
| 测试服务器的 `127.0.0.1:<随机端口>` | `127.0.0.1:8080` |

`size_bytes` 之所以要钉住：备份负载内嵌 `RFC3339Nano` 时间戳，Go 会
去掉小数末尾的零，于是同一棵树在不同秒级时刻产生的字节数不同。契约
要的是"这里有一个数字"，不是这个数字。登录令牌、设备凭据、API Token
的 secret 也一样——它们每次调用都是新随机串，而且只在那一次响应里出
现，契约是"回答里带这个字符串"。

对象键按 `encoding/json` 的字母序写出；JSON 对象顺序无语义。字段名、
可选性、`null` 与 `[]` 的区分、数字与字符串的区分都保持服务端原始
输出——那才是契约。

会写数据的采集（建第二个 Space、发布、导出→预览→应用、跨空间移动、
改资料、改设置、排队/取消任务、恢复、登出、用掉重置链接）排在所有读
取之后执行，所以列表类 fixture 记录的是用户第一次打开页面看到的形状，
而不是测试脚手架留下的痕迹。

## 尚未覆盖

60 个会返回数据的客户端调用现在全部带运行时校验器，`as T` 清零。仍
没有金样本的：

- `POST /admin/jobs/{id}/retry` 的成功响应。这个测试进程里没有 worker，
  取消只是"请求"，job 仍停在 `queued`，而 retry 只接受 failed/cancelled。
  它写回的三个键与 `job-enqueue` 完全相同，所以形状由后者钉住，客户端
  也用同一个校验器。
- 写端点的错误分支（409/422 那些）只在 `error-*` 两个通用信封里钉过。

`packages/api/src/mock/`（`VITE_API_MOCK=on` 时的离线外壳）只造 session 与
`/meta`：它过去附带十个 JSON 当"完整离线数据"，而**没有任何代码读它们**——
`gapHandlers` 是空的，`allHandlers` 里也只有 auth+meta。那十个文件已经删掉，
剩下的这点表面由 `test/mock-contract.test.ts` 管着：既过一遍与真服务端同一个
校验器，也比对键集合与 golden body 一致，免得 mock 少发一个字段、页面却照着
那个形状写组件。默认（`web/.env` 里 `VITE_API_MOCK=off`）不经过 mock。

## 这批文件当场抓到的形状错误

`as T` 不会报的，真实 body 会：

- `POST /publications` 返回 detail（含 `tree`），不是 summary。
- `PATCH /admin/users/{id}` 返回 `fromUser` 的形状，没有 `space_count`
  与 `last_seen_at`，原来却声明成 `AdminUserView`。
- 导入预览的 `counts` 只带实际发生的那几项（`{create: 2}`），不是七项
  全零，而且响应里还有一个声明里漏掉的 `space_id`。
- 实例设置的两个数值是**字符串**（`"24"`、`"16"`，因为存储是 key/value
  文本列），声明写的却是 `number`；而 PATCH 请求侧收的确实是数字，所以
  读与写各自有一个类型。
