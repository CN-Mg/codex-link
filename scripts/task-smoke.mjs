/**
 * 子智能体通道冒烟测试（真实 Codex，消耗少量额度）。
 *
 * 验证 `codex_task` 的 isolated 通道：`codex exec --json` 起独立进程，
 * 解析事件流并返回最终回答。运行：`node scripts/task-smoke.mjs`
 */

import { resolveConfig } from '../lib/config.js';
import { TaskRunner } from '../lib/task.js';

const logger = {
  info: (message) => console.log(`[task] ${message}`),
  warn: (message) => console.warn(`[task] ${message}`),
  debug: () => {},
};

const settings = resolveConfig({});
const runner = new TaskRunner({ settings, logger });

try {
  const result = await runner.run({ task: '查询当前时间，只回复时间', timeoutMs: 180_000 });
  console.log(`[task] ok=${String(result.ok)} thread=${String(result.threadId)} 耗时=${String(result.durationMs)}ms`);
  console.log(`[task] 回答=${JSON.stringify(result.text)}`);
  if (result.usage !== null) console.log(`[task] usage=${JSON.stringify(result.usage)}`);
  if (!result.ok) {
    console.log(`[task] 失败：${String(result.errorCode)} ${String(result.errorDetail)}`);
    process.exitCode = 1;
  }
} finally {
  runner.dispose();
}
