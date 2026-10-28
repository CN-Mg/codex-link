/**
 * 注入给模型的 system prompt 使用指南。
 *
 * 目标是让模型知道：默认在哪个工作区、怎样切换 Codex 会话、如何用
 * codex_watch 播报进度，以及微信渠道的消息配额纪律。
 *
 * @module dsh-plugin-codex-link/prompt
 */

/**
 * 生成使用指南文本。
 *
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} settings 插件配置。
 * @returns {string} 指南文本。
 */
export function guideText(settings) {
  return [
    '## Codex 联动（dsh-plugin-codex-link）',
    `默认工作区：${settings.workspaceRoot}；默认会话名：${settings.defaultThreadName}。`,
    '你可以把 Codex 当作一个可独立执行的编码代理来驱动：',
    '1. `codex_threads` 查看 Codex 会话（默认只看交互工作区；需要全部时传 all=true）。',
    '2. `codex_use` 切换目标会话：支持完整 ID、ID 前缀、`codex_threads` 输出的序号、标题或标题片段；多个匹配会返回候选，不会擅自选择。',
    '3. `codex_send` 发送指令；返回 turnId 后，用 `codex_watch` 跟踪过程，用 `codex_result` 取最终回答、耗时和 token。',
    '4. 运行中要追加要求用 `codex_send` + `mode="steer"`；要停止用 `codex_interrupt`。',
    '5. 额度用 `codex_usage`；连接/版本/绑定状态用 `codex_status`。',
    '',
    '使用约定：',
    '- 没有明确指定会话时，默认会话就是 `codex_use` 未绑定时的目标，不必每次显式切换。',
    '- `codex_send` 返回后尽快调用 `codex_watch`（短等 8 秒即可），循环直到 `status` 变成结束；每轮 Codex 任务最多向用户播报 3 条进度（合并同类事件），最终结果单独一条，避免消耗微信 10 条消息配额。',
    '- 进度播报只挑关键节点：开始执行、关键命令/文件改动完成、出错、结束；不要逐条复述工具调用。',
    '- 这些工具只驱动 Codex，不要在 Codex 里重复执行用户已经在 DSH 里要求的同一件事。',
    '- 出错时按错误码处理：BUSY_THREAD 等结束或改用 steer；THREAD_NOT_FOUND 用 codex_threads 重新选择；APP_SERVER_UNAVAILABLE 报告并检查 Codex 是否安装/可启动。',
    `- 审批默认被拒绝并记录（approvals=${settings.approvals}）；如用户确需更高权限，提示其调整插件配置里的 sandbox/approvals。`,
  ].join('\n');
}
