/**
 * queue 回退通道冒烟测试（真实 Codex，会真的把消息投进指定会话）。
 *
 * 验证：`codex queue` 能投递消息 → 目标会话执行 → rollout 增量读到过程与结果。
 * 默认目标会话取环境变量 `CODEX_QUEUE_THREAD`，否则用示例值。
 *
 * 运行：`node scripts/queue-smoke.mjs <threadId>`
 */

import { join } from 'node:path';

import { codexHome, resolveCodexBinary } from '../lib/codex-binary.js';
import { queueMessage } from '../lib/queue-bridge.js';
import { RolloutTail } from '../lib/rollout-tail.js';

const threadId = process.argv[2] ?? process.env.CODEX_QUEUE_THREAD ?? '';
if (threadId === '') {
  console.error('用法：node scripts/queue-smoke.mjs <threadId>');
  process.exitCode = 2;
}

const binary = resolveCodexBinary({});
console.log(`[queue-smoke] codex=${binary.path}（${binary.version}）`);
console.log(`[queue-smoke] thread=${threadId}`);

const tail = new RolloutTail({ sessionsRoot: join(codexHome(), 'sessions'), threadId });
if (!tail.ensureLocated()) {
  console.error('[queue-smoke] 找不到该会话的 rollout 文件');
  process.exitCode = 1;
} else {
  tail.startAtEnd();
  const queued = await queueMessage({ binaryPath: binary.path, threadId, text: '查询当前时间' });
  console.log(`[queue-smoke] 已投递 message=${String(queued.messageId)}`);

  const deadline = Date.now() + 180_000;
  let completed = null;
  while (Date.now() < deadline && completed === null) {
    const slice = tail.poll();
    for (const event of slice.events) console.log(`[queue-smoke] [${event.kind}] ${event.text}`);
    if (slice.completed !== null) completed = slice.completed;
    if (completed === null) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (completed === null) {
    console.error('[queue-smoke] 等待结果超时');
    process.exitCode = 1;
  } else {
    console.log(`[queue-smoke] 完成：${JSON.stringify(completed).slice(0, 500)}`);
  }
}
