# dsh-plugin-codex-link

在 DSH 里驾驶 Codex：**切换 Codex 会话、发送指令、实时读取运行过程、取回最终结果**。

- Codex 侧**不需要安装任何插件**：插件使用 Codex 自带的 `codex app-server`（JSON-RPC over stdio）。
- DSH 侧只依赖宿主提供的 `ctx.tools` 服务；插件本身零 npm 依赖（只用 Node 内置模块）。
- 默认交互工作区：`C:\Users\Bolin\Desktop\DSH\Wechat`
- 默认会话名：`微信工作区（DSH）`（不存在时自动创建）

## 能力

| 需求 | 工具 |
|---|---|
| 查看/切换指定 Codex 会话 | `codex_threads` / `codex_use` |
| 发送指令、运行中追加或中止 | `codex_send`（`mode=auto/steer/interrupt`） |
| 读取运行过程（工具调用、命令、文件改动、错误） | `codex_watch`（游标续读） |
| 取最终回答、耗时、token 用量 | `codex_result` |
| 查询 5 小时 / 7 天额度与重置时间 | `codex_usage` |
| 健康检查（连接、版本、绑定） | `codex_status` |
| 把 Codex 窗口带到项目 | `codex_open_project` |

## 工具

### codex_status

查看 app-server 连接状态、Codex 可执行文件路径与版本、默认工作区/默认会话、当前 DSH 会话绑定。排查问题先调它。

### codex_threads

参数：`query?`（标题搜索）、`limit?`（默认 15，上限 50）、`all?`（`true` 时列出全部会话）。

返回：序号、短 ID、标题、目录、状态（`idle`/`active`）、更新时间。

### codex_use

参数：`thread`（必填：完整 ID / ID 前缀 ≥6 位 / `codex_threads` 序号 / 标题 / 标题片段）、`create?`（`true` 时在默认工作区新建会话）。

唯一匹配才绑定；多义时返回候选列表。绑定持久化到 `<DSH_HOME>/codex-link/bindings.json`，DSH 重启后仍然生效。

### codex_send

参数：`text`（必填）、`thread?`、`mode?`（`auto`/`steer`/`interrupt`）、`wait?`。

- 会话空闲：`turn/start` 开新回合；
- 本插件发起的回合并未结束：`steer` 追加输入；
- 其它 Codex 客户端正在写该会话：明确返回 `BUSY_THREAD`，不抢写；
- `wait=true`：工具内等待结束并直接返回回答。

### codex_watch

参数：`thread?`、`cursor?`、`waitMs?`（默认 8000，上限 20000）、`detail?`（`summary`/`full`）。

返回自游标以来的归一化事件：`turn_started`、`tool_call`、`tool_result`、`thinking`、`plan`、`message`、`approval_denied`、`error`、`warning`、`turn_completed`。`detail=full` 额外返回命令输出与流式片段。

### codex_result

参数：`thread?`、`turnId?`。返回状态、耗时、token 用量与最终回答；优先用本地事件缓存，缺失时回查 app-server。

### codex_interrupt

参数：`thread?`。中止当前回合。

### codex_usage

返回套餐类型、5 小时窗口（已用/剩余百分比、重置时间、距重置时长）、7 天窗口。数据来自 `account/rateLimits/read`，不是估算。

### codex_open_project

参数：`cwd?`。调用 `codex app <目录>` 把 Codex 桌面端切到该项目。**线程级窗口聚焦没有官方 API**，见「已知限制」。

## 安装

本插件以 `dsh.bundle.patch` 的形式插入 desktop profile。desktop profile 由 DSH 桌面端独占管理，不能用命令行 `dsh plugin --profile desktop add`。

**推荐：**桌面端 DSH → Plugins → 安装 → 填本仓库的绝对路径（插件管理器支持绝对路径/`file:` spec）→ 重启 DSH。

回退方案（插件页不可用时）：

1. 备份 `C:\Users\Bolin\.dsh\profiles\desktop\package.json`；
2. 在 `dependencies` 加 `"dsh-plugin-codex-link": "link:C:\\Users\\Bolin\\Desktop\\DSH\\codex-link"`；
3. 在 `dsh.profile.bundles` 末尾追加 `"dsh-plugin-codex-link"`；
4. 在 profile 目录用 DSH 自带的 pnpm 执行安装，重启 DSH。

## 配置

配置写在 `cordis.patch.yml`（或在 profile 的 `cordis.patch.yml` 里覆盖）。注意 patch 对 `config` 是整块替换，覆盖时必须写全想保留的键。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `workspaceRoot` | `C:\Users\Bolin\Desktop\DSH\Wechat` | 默认交互工作区 |
| `defaultThreadName` | `微信工作区（DSH）` | 默认会话名 |
| `codexPath` | `null` | 显式指定 codex.exe；null 时动态发现 |
| `sandbox` | `workspace-write` | 新建会话的 Codex 沙箱 |
| `approvalPolicy` | `never` | 新建会话的审批策略 |
| `networkAccess` | `false` | 沙箱是否允许网络 |
| `approvals` | `deny` | 收到审批请求时：`deny` 拒绝并记录 / `allow` 自动批准（高风险） |
| `startupTimeoutMs` | `20000` | app-server 初始化超时 |
| `requestTimeoutMs` | `600000` | 单次 RPC / 等待回合的超时 |
| `watchDefaultWaitMs` | `8000` | `codex_watch` 默认短等 |
| `watchMaxWaitMs` | `20000` | `codex_watch` 最大短等 |
| `eventBufferLimit` | `2000` | 每会话事件缓冲上限 |
| `summaryChars` | `500` | summary 单事件字符上限 |
| `fullChars` | `4000` | full 单事件字符上限 |
| `focusMode` | `off` | 窗口聚焦模式（v1 只支持 off/project） |

## 使用流程

1. `codex_threads`（可选）→ `codex_use` 绑定目标会话；
2. `codex_send` 发指令，拿到 `turnId`；
3. `codex_watch` 循环读进度（建议每轮 8 秒，最多 3 条进度播报）；
4. `codex_result` 取最终回答与用量；
5. 需要中止：`codex_interrupt`。

微信渠道建议：一轮任务最多 3 条进度 + 1 条最终结果，避免打满 10 条消息配额。

## 错误码

| 错误码 | 含义 | 处理 |
|---|---|---|
| `CODEX_NOT_FOUND` | 找不到可用的 codex.exe | 确认已安装 Codex，或配置 `codexPath` |
| `APP_SERVER_UNAVAILABLE` | app-server 启动/连接失败 | 查看 stderr 摘要，检查 Codex 是否可运行 |
| `THREAD_NOT_FOUND` | 会话不存在/被归档 | 用 `codex_threads` 重新选择 |
| `AMBIGUOUS_THREAD` | 引用匹配到多个会话 | 用序号或完整 ID |
| `BUSY_THREAD` | 会话被其它客户端占用 | 等回合结束，或改用 `steer` |
| `NOT_RUNNING` | 没有正在运行的回合 | 无需中止 |
| `TURN_TIMEOUT` | 等待回合超时 | 继续 `codex_watch` 或 `codex_interrupt` |
| `RPC_TIMEOUT` / `RPC_ERROR` | app-server 请求超时/失败 | 重试或重启 Codex |

## 安全与边界

- app-server 只通过 stdio 通信，不监听端口、不联网。
- 新建会话默认 `workspace-write` + `approvalPolicy=never` + 禁用网络；需要更高权限时显式改配置。
- 审批请求默认**拒绝并记录**为 `approval_denied` 事件；`approvals=allow` 会自动批准，风险自负。
- 不修改 Codex 的会话文件；只在选中会话里追加回合。
- DSH 卸载/退出时终止子进程；Windows 用 `taskkill /T /F` 兜底防孤儿进程。

## 已知限制

- **Codex 桌面端可能不会实时刷新插件新建的回合**。若刷新后仍看不到，重开该会话；v2 会补 `codex queue` + rollout 增量读取的回退路径。
- **`thread/list` 不返回空会话**：刚创建、还没有任何回合的会话不会出现在 `codex_threads` 里（Codex 服务端行为）。插件把默认会话 ID 记在绑定文件的 `__default__` 键中，避免重复新建。
- **线程级窗口聚焦没有官方 API**：`codex://` 深链在本机未注册可执行处理器，v1 只做逻辑切换与项目级窗口操作；键盘 UI 自动化留作 v2 可选（默认关闭）。
- 同一会话被桌面端和 DSH 同时写入时，以 `BUSY_THREAD` 明确拒绝，不并发抢写。
- Codex 更新会更换 bin 哈希目录；插件每次启动按 mtime 重新发现，路径失效时会再次探测。
- 审批应答按 Codex 0.165 的 `ReviewDecision` 形状（`{denied:{rejection}}`）；更老版本可能需要调整。
- **Codex 自身的网络/证书问题会直接表现为回合失败**（例如 `workspace routing discovery failed`、`codex doctor` 报 provider endpoints unreachable）。这是 Codex 与网络环境问题，不是插件逻辑问题；可用 `node scripts/integration.mjs --protocol-only` 单独验证本地协议链路。

## 开发与测试

```bash
node --test test                # 单元测试（47 项）
node tools/check.mjs            # 静态检查
node scripts/integration.mjs    # 真实 Codex 集成测试（会消耗少量额度）
node scripts/integration.mjs --protocol-only   # 只验证本地协议链路，不触发模型调用
```

结构：

```
lib/config.js        配置解析与钳制
lib/codex-binary.js  codex.exe 动态发现
lib/rpc-client.js    按行 JSON-RPC 客户端
lib/app-server.js    子进程生命周期
lib/threads.js       会话匹配/发送/中止/结果
lib/events.js        通知 → 进度事件 + 游标
lib/bindings.js      DSH 会话 → Codex 会话绑定
lib/tools.js         工具规格
lib/prompt.js        system prompt 指南
lib/index.js         Cordis 入口装配
```

## 许可

MIT。参考了作者早前的 `dsh-plugin-infj-pet` 的打包/测试风格与 `dsh-peak-runner` 的宿主插件写法，见 `CHANGELOG.md`。
