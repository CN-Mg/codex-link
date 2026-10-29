/**
 * 注入给模型的 system prompt 使用指南。
 *
 * 目标是让模型知道：默认在哪个工作区、有哪几种操作方式、怎样切换 Codex
 * 会话、如何用 codex_task 派遣子智能体、以及微信渠道的消息配额纪律。
 *
 * @module dsh-plugin-codex-link/prompt
 */

/**
 * 生成使用指南文本。
 *
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} settings 插件配置。
 * @param {string} [mode] 当前生效的操作方式（设置页可切换）。
 * @returns {string} 指南文本。
 */
export function guideText(settings, mode = settings.mode) {
  const modeLabel = mode === 'direct' ? '直控会话' : mode === 'subagent' ? '子智能体' : '混合';
  return [
    '## Codex 联动（dsh-plugin-codex-link）',
    `默认工作区：${settings.workspaceRoot}；默认会话名：${settings.defaultThreadName}。`,
    `当前操作方式：${modeLabel}（设置 → Codex 联动 里可切换三种方式）。`,
    '',
    '三种操作方式：',
    '- 直控会话：用 codex_send / codex_watch / codex_result 驱动已绑定的 Codex 会话，实时看过程，可 steer / interrupt。',
    '- 子智能体：用 codex_task 一次性派任务，Codex 在独立进程里执行，只回最终结果（线程 id、耗时、用量一起回）。',
    '- 混合：有绑定会话时直控；没有绑定或任务要求隔离时走子智能体。',
    '',
    '工具：',
    '1. `codex_threads` 查看 Codex 会话（默认只看交互工作区；all=true 看全部，query 可按标题搜索）。',
    '2. `codex_use` 切换目标会话：支持完整 ID、ID 前缀、`codex_threads` 输出的序号、标题或标题片段；多义时返回候选，不擅自选择。',
    '3. `codex_send` 发送指令；返回 turnId 后，用 `codex_watch` 跟踪过程，`codex_result` 取最终回答、耗时和 token。',
    '4. `codex_task` 派遣独立子任务：`task` 为任务描述，`channel=auto/isolated/session` 选择执行通道，支持 `cwd`、`sandbox`、`model`、`timeoutMs`；结果里会返回线程 id，之后可用 `codex_use <threadId>` 接管。',
    '5. 运行中要追加要求用 `codex_send` + `mode="steer"`；要停止用 `codex_interrupt`。',
    '6. 额度用 `codex_usage`；连接/版本/绑定/当前方式用 `codex_status`。',
    '',
    '使用约定：',
    '- 没有明确指定会话时，默认会话就是 `codex_use` 未绑定时的目标，不必每次显式切换。',
    '- `codex_send` 的 `text` 必须原样转发用户的指令：不要添加「来自 DSH」「请」「帮我」等前缀、署名或包装语。用户说「查询当前时间」，就只发「查询当前时间」。',
    '- 子智能体（`codex_task`）适合「跑一整件事、只要结果」的场景；需要盯着过程或中途干预时走直控会话。',
    '- `codex_send` 返回后尽快调用 `codex_watch`（短等 8 秒即可），循环直到 `status` 变成结束；每轮 Codex 任务最多向用户播报 3 条进度（合并同类事件），最终结果单独一条，避免消耗微信 10 条消息配额。',
    '- 进度播报只挑关键节点：开始执行、关键命令/文件改动完成、出错、结束；不要逐条复述工具调用。',
    '- 这些工具只驱动 Codex，不要在 Codex 里重复执行用户已经在 DSH 里要求的同一件事。',
    '- 出错时按错误码处理：BUSY_THREAD 等结束或改用 steer；THREAD_NOT_FOUND 用 codex_threads 重新选择；TASK_BUSY 等子任务结束；APP_SERVER_UNAVAILABLE 报告并检查 Codex 是否安装/可启动。',
    `- 审批默认被拒绝并记录（approvals=${settings.approvals}）；如用户确需更高权限，提示其调整插件配置里的 sandbox/approvals。`,
    '- 用户问「现在是什么方式」或要切换方式时，告诉对方到 DSH 设置 → Codex 联动 里切换，或直接以 codex_task 的 channel 参数临时指定。',
  ].join('\n');
}
