# Sync Protocol Golden Fixtures

Shared JSON fixtures for the `/sync` wire protocol (doc 21 §9). Go 和
TypeScript 双方都必须通过这些文件验证自己的 encode/decode,防止 wire
schema 漂移。

| 文件 | 内容 |
| --- | --- |
| `operation-create-v1.json` | 一个 CREATE Operation envelope(doc 04 §3) |
| `operation-move-v1.json` | 一个 MOVE Operation envelope(含 root parent 与 before_id) |
| `sync-request-v1.json` | `/sync` 请求:两个 operation + watermark |
| `sync-response-v1.json` | `/sync` 返回:operation results + canonical change stream |
| `error-epoch-mismatch.json` | 统一错误封套(doc 08 §16) |

## 事实来源与验证方式

- **Go(server)**:`server/internal/httpapi/fixtures_test.go` 中的 wire
  DTO 是协议编码的事实来源。测试对比 golden 文件,漂移即失败;用
  `go test ./internal/httpapi -run TestGoldenProtocolFixtures -update-fixtures`
  重新生成(仅当协议本身有意变更时)。
- **TypeScript(浏览器扩展,Phase 8)**:扩展的 codec 必须能无修改地
  decode 这些文件,且把等价的结构 encode 成语义相同的 JSON(字段名与
  可选性一致)。纳入扩展的单元测试。
