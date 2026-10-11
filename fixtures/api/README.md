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
| 重置链接里的 `token=…` | `token=prs_the-reset-token` |
| 测试服务器的 `127.0.0.1:<随机端口>` | `127.0.0.1:8080` |

`size_bytes` 之所以要钉住：备份负载内嵌 `RFC3339Nano` 时间戳，Go 会
去掉小数末尾的零，于是同一棵树在不同秒级时刻产生的字节数不同。契约
要的是"这里有一个数字"，不是这个数字。重置链接同理——契约是"`/reset`
上一个带 token 的链接"，不是那一串随机字节，也不是这次 `httptest`
抢到的端口。

对象键按 `encoding/json` 的字母序写出；JSON 对象顺序无语义。字段名、
可选性、`null` 与 `[]` 的区分、数字与字符串的区分都保持服务端原始
输出——那才是契约。

会写数据的采集（建第二个 Space、发布、导出→预览→应用、跨空间移动）
排在所有读取之后执行，所以列表类 fixture 记录的是用户第一次打开页面
看到的形状，而不是测试脚手架留下的痕迹。

## 尚未覆盖

51 个返回数据的客户端调用里还有 8 个走 `as T`：登录、注册设备、创建
API Token、读写实例设置、修改自己的资料、撤销一次改动、恢复一个备份。
它们的共同点是一次性密钥或"只回一个状态"，需要新的归一化规则才能钉住。

`PATCH /admin/users/{id}` 没有单独的 golden 文件：它返回的就是
`fromUser` 的形状，与 `me.json` 同一个结构体，客户端校验器直接复用
`checkUser`。

`packages/api/src/mock/data/*.json`（`VITE_API_MOCK` 打开时的离线替身）
没有对着这批文件校验过，已知与真服务端不一致：例如 mock 里
`tokens.json` 的 `space_scope` 是真数组，而服务端发的是一段 JSON
字符串。默认配置（`.env` 里 `VITE_API_MOCK=off`）不经过 mock，所以
不影响正常联调；一旦有人依赖 mock 模式做离线开发，它应当先进同一道
契约检查。
