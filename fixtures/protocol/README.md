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
| `sync-response-empty-v1.json` | 纯拉取轮次:两个协议数组都是 `[]` 而不是 `null` |
| `error-epoch-mismatch.json` | 统一错误封套(doc 08 §16) |
| `reconcile-client-snapshot-v1.json` | 首次对账提交的浏览器快照(doc 08 §10) |
| `reconcile-server-snapshot-v1.json` | 冻结的 Canonical 快照元数据(doc 08 §9) |
| `reconcile-snapshot-nodes-v1.json` | 快照节点分页:cursor 是该快照自己的 offset |
| `reconcile-session-planned-v1.json` | `plan` 的应答:session + ambiguity issue + plan 预览 |
| `reconcile-steps-v1.json` | Client apply steps(doc 08 §13) |
| `reconcile-session-completed-v1.json` | `complete` 的应答:session + 写回的 binding |

## 事实来源与验证方式

- **Go(server)**:`server/internal/httpapi/fixtures_test.go` 中的 wire
  DTO 是协议编码的事实来源。测试对比 golden 文件,漂移即失败;用
  `go test ./internal/httpapi -run TestGoldenProtocolFixtures -update-fixtures`
  重新生成(仅当协议本身有意变更时)。
- **TypeScript(浏览器扩展)**:扩展的 codec 必须能无修改地 decode 这些
  文件,且把等价的结构 encode 成语义相同的 JSON(字段名与可选性一致)。
  两处都在跑:`packages/protocol/test/fixtures.test.ts` 校验共享 codec,
  `extension/src/core/protocol/reconcileWire.test.ts` 用扩展自己的边界
  校验器(`parseReconciliationEnvelope`、`parseSteps`、
  `parseServerSnapshotPage`)读取同一批 golden 文件,并反向 encode
  `reconcile-client-snapshot-v1.json`。
