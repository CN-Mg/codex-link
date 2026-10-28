# Codex app-server 协议笔记

本文件记录插件依赖的 Codex app-server 行为与验证环境，方便 Codex 升级后排查。

## 验证环境

- 日期：2026-10-28
- Codex CLI：`0.165.0-alpha.1.2`
- 可执行文件：`%LOCALAPPDATA%\OpenAI\Codex\bin\08d187884f2330d1\codex.exe`（hash 目录会随更新变化）
- 平台：Windows
- 连接方式：`codex.exe app-server --listen stdio://`

## 传输

- stdio，每行一个 JSON 对象（newline-delimited JSON）。
- 请求：`{"jsonrpc":"2.0","id":<number>,"method":"...","params":{...}}`
- 响应：`{"jsonrpc":"2.0","id":<number>,"result":{...}}` 或 `{"id":<number>,"error":{"code":...,"message":"..."}}`
- 通知：`{"jsonrpc":"2.0","method":"...","params":{...}}`
- 服务端请求（需要客户端应答）：带 `id` 与 `method`，例如审批请求；客户端用同样的 `id` 回 `result`。

## 初始化

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"dsh-plugin-codex-link","title":"DSH Codex Link","version":"0.1.0"},"capabilities":null}}
```

实测不需要再发 `initialized` 通知。

## 使用到的方法

| 方法 | 用途 | 关键参数 |
|---|---|---|
| `initialize` | 建立连接 | `clientInfo`、`capabilities` |
| `thread/list` | 列会话 | `cwd`、`searchTerm`、`limit`、`archived`、`sortKey=updated_at`、`sortDirection=desc`、`useStateDbOnly=true` |
| `thread/start` | 新建会话 | `cwd`、`sandbox`（`read-only`/`workspace-write`/`danger-full-access`）、`approvalPolicy` |
| `thread/resume` | 恢复/加入会话 | `threadId`、`excludeTurns=true` |
| `thread/name/set` | 设置标题 | `threadId`、`name` |
| `turn/start` | 发指令 | `threadId`、`input:[{type:"text",text,text_elements:[]}]` |
| `turn/steer` | 追加输入 | `threadId`、`expectedTurnId`、`input` |
| `turn/interrupt` | 中止回合 | `threadId`、`turnId` |
| `thread/turns/list` | 回查回合 | `threadId`、`limit`、`sortDirection` |
| `thread/delete` | 删除测试会话 | `threadId` |
| `account/rateLimits/read` | 查额度 | 无 |

## 使用到的通知

| 通知 | 用途 |
|---|---|
| `turn/started` | 回合开始（`turn.id`） |
| `turn/completed` | 回合结束（`turn.status`、`durationMs`、`items`、`error`） |
| `item/started` / `item/completed` | 命令、文件改动、MCP 调用、助手消息、计划等 |
| `item/agentMessage/delta` | 流式回答片段 |
| `item/commandExecution/outputDelta` | 命令输出片段 |
| `item/fileChange/outputDelta` | 文件改动输出片段 |
| `thread/tokenUsage/updated` | token 用量 |
| `thread/status/changed` | 会话状态（`idle`/`active`） |
| `account/rateLimits/updated` | 额度更新 |
| `error` / `warning` | 错误与提示 |

## 服务端请求（审批）

| 方法 | 应答 |
|---|---|
| `item/commandExecution/requestApproval` | `{decision: ReviewDecision}` |
| `item/fileChange/requestApproval` | `{decision: ReviewDecision}` |
| `applyPatchApproval` / `execCommandApproval`（旧式） | `{decision: ReviewDecision}` |

本版本 `ReviewDecision` 为：

- `"approved"` / `"approved_for_session"` / `"timed_out"` / `"abort"` / `"approved_mcp_policy_amendment"`
- `{denied:{rejection:string}}`（新版拒绝形状）
- `{approved_execpolicy_amendment:{...}}` / `{network_policy_amendment:{...}}`

插件默认返回 `{denied:{rejection:"..."}}`；`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call` 等未实现请求返回 JSON-RPC 错误（-32601），并在会话里记录事件。

## 额度响应形状（实测）

```json
{
  "ordinaryUsageAllowed": true,
  "rateLimits": {
    "limitId": "codex",
    "primary": {"usedPercent": 5, "windowDurationMins": 300, "resetsAt": 1792929450},
    "secondary": {"usedPercent": 1, "windowDurationMins": 10080, "resetsAt": 1793516250},
    "credits": {"hasCredits": false, "unlimited": false, "balance": "0"},
    "planType": "plus"
  },
  "rateLimitResetCredits": {"availableCount": 0, "credits": []}
}
```

`primary` 为 5 小时窗口，`secondary` 为 7 天窗口；`resetsAt` 为 Unix 秒。

## 并发与写入锁

- Codex 用 `~/.codex/thread-writer-locks/<threadId>.lock` 协调多个写者。
- 插件持有自己的 app-server 进程；若目标会话正被桌面端写入，`thread/resume`/`turn/start` 会失败或返回占用信号，插件统一转成 `BUSY_THREAD`，不抢写。
- 建议 DSH 使用独立会话（默认的「微信工作区（DSH）」），避免与桌面端正在编辑的会话冲突。

## 升级检查清单

1. `codex --version` 是否变化；
2. `codex app-server --help` 是否仍有 `--listen`；
3. 工具是否仍能 `thread/list`、`thread/start`、`turn/start`；
4. 审批请求形状是否仍是 `{decision:...}`；
5. `turn/completed` 的 `items` 是否仍含 `agentMessage`。
