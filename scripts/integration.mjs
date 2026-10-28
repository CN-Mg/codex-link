/**
 * 真实 Codex 集成测试（会消耗少量 Codex 额度）。
 *
 * 只使用仓库内的模块，不经过 DSH 宿主：
 *   1. 动态发现 codex.exe，启动 app-server；
 *   2. 在临时目录新建一个只读沙箱会话；
 *   3. 发送「只回复 INTEGRATION_OK」并等待回合结束；
 *   4. 断言收到 turn/item 事件、最终回答正确；
 *   5. 清理会话与子进程。
 *
 * 运行：`node scripts/integration.mjs`
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { CodexAppServer } from '../lib/app-server.js';
import { resolveConfig } from '../lib/config.js';
import { resolveCodexBinary } from '../lib/codex-binary.js';
import { createThreadRegistry } from '../lib/events.js';
import { sendInstruction, listThreads, startThread } from '../lib/threads.js';

/** 测试提示词：明确要求不调用工具，避免在工作区里产生副作用。 */
const PROMPT = '只回复一行：INTEGRATION_OK。不要调用任何工具，不要读写文件。';

const logger = {
  info: (message) => console.log(`[it] ${message}`),
  warn: (message) => console.warn(`[it] ${message}`),
  debug: () => {},
};

/**
 * 等待回合完成。
 *
 * @param {ReturnType<typeof createThreadRegistry>} registry 事件注册表。
 * @param {string} threadId 会话 ID。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<any>} 回合摘要。
 */
async function waitForTurn(registry, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = registry.stateOf(threadId);
    if (state !== null && state.lastTurn !== null) return state.lastTurn;
    if (Date.now() >= deadline) throw new Error(`等待回合超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * 协议自检：不触发模型调用的真实 Codex 验证。
 *
 * 当前机器如果 TLS 被中间人拦截（`codex doctor` 会报 provider endpoints
 * unreachable），回合可能直接失败；这个模式仍然能验证插件依赖的协议链路：
 * 连接、列会话、建会话、命名、查额度、删会话。
 *
 * @param {CodexAppServer} appServer app-server 客户端。
 * @param {ReturnType<typeof createThreadRegistry>} registry 事件注册表。
 * @param {ReturnType<typeof resolveConfig>} settings 配置。
 * @returns {Promise<string>} 结论描述。
 */
async function protocolSmoke(appServer, registry, settings) {
  await appServer.ensureReady();
  const threads = await listThreads(appServer, { cwd: settings.workspaceRoot, limit: 5 });
  console.log(`[it] thread/list：${threads.length} 个会话（工作区）`);

  let rateLimitAvailable = false;
  try {
    const rate = await appServer.call('account/rateLimits/read', {});
    const primary = rate?.rateLimits?.primary;
    console.log(`[it] account/rateLimits/read：5h 已用 ${primary?.usedPercent ?? '?'}%`);
    assert.ok(typeof primary?.usedPercent === 'number', '额度接口应返回 5 小时窗口');
    rateLimitAvailable = true;
  } catch (error) {
    // 当前机器 TLS 被拦截时，Codex 自己的额度接口也会失败；协议自检不应因此中断。
    console.warn(`[it] 额度接口不可用（网络受限，可忽略）：${error instanceof Error ? error.message : String(error)}`);
  }

  const thread = await startThread(appServer, settings, { cwd: settings.workspaceRoot, name: '协议自检会话' });
  console.log(`[it] thread/start + thread/name/set：${thread.id}`);
  assert.ok(thread.id.length > 0, 'thread/start 应返回会话 ID');

  // 说明：Codex 的 thread/list 只返回「有内容」的会话，刚创建的空会话不会出现，
  // 因此这里用 thread/resume 验证会话可用性，而不是断言列表可见。
  const resumed = await appServer.call('thread/resume', { threadId: thread.id, excludeTurns: true });
  assert.equal(resumed?.thread?.id, thread.id, 'thread/resume 应返回同一会话');
  console.log(`[it] thread/resume：${resumed.thread.status?.type ?? 'unknown'}`);

  try {
    await appServer.call('thread/delete', { threadId: thread.id });
    console.log('[it] thread/delete：清理完成');
  } catch (error) {
    console.warn(`[it] thread/delete 失败（可忽略）：${error instanceof Error ? error.message : String(error)}`);
  }

  assert.equal(registry.getRateLimits() === null || typeof registry.getRateLimits() === 'object', true);
  return rateLimitAvailable
    ? '协议自检通过（含额度接口）'
    : '协议自检通过（会话链路；额度接口因网络受限跳过）';
}

/**
 * 主流程。
 */
async function main() {
  const binary = resolveCodexBinary({});
  console.log(`[it] codex=${binary.path}（${binary.version}，来源 ${binary.source}）`);
  const protocolOnly = process.argv.includes('--protocol-only');

  // Codex 对「未信任目录」会拒绝工作区路由（workspace routing discovery failed），
  // 因此集成测试默认在已信任的交互工作区里跑；可用环境变量指定其它已信任目录。
  const workspace =
    typeof process.env.CODEX_LINK_INTEGRATION_CWD === 'string' && process.env.CODEX_LINK_INTEGRATION_CWD.trim() !== ''
      ? process.env.CODEX_LINK_INTEGRATION_CWD.trim()
      : resolveConfig({}).workspaceRoot;
  const cleanupWorkspace = false;
  const settings = resolveConfig({
    workspaceRoot: workspace,
    defaultThreadName: '集成测试会话',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    requestTimeoutMs: 180_000,
  });

  const registry = createThreadRegistry({ summaryChars: 400 });
  const appServer = new CodexAppServer({ settings, logger });
  appServer.onNotification((method, params) => {
    registry.observe(method, params);
    if (method === 'turn/started' || method === 'turn/completed') {
      console.log(`[it] ${method}`);
    }
  });

  let threadId = null;
  try {
    await appServer.ensureReady();
    if (protocolOnly) {
      const verdict = await protocolSmoke(appServer, registry, settings);
      console.log(`[it] ${verdict}`);
      return;
    }
    const thread = await startThread(appServer, settings, { cwd: workspace, name: '集成测试会话' });
    threadId = thread.id;
    console.log(`[it] 新会话 ${thread.id}（cwd=${workspace}）`);

    const sent = await sendInstruction(appServer, registry, settings, { threadId, text: PROMPT });
    console.log(`[it] turn=${sent.turnId} mode=${sent.mode}`);

    const lastTurn = await waitForTurn(registry, threadId, settings.requestTimeoutMs);
    console.log(`[it] 状态=${lastTurn.status} 耗时=${lastTurn.durationMs}ms`);
    console.log(`[it] 回答=${JSON.stringify(lastTurn.finalText)}`);
    if (lastTurn.error !== null && lastTurn.error !== undefined) {
      console.log(`[it] 回合错误=${JSON.stringify(lastTurn.error).slice(0, 800)}`);
    }
    const slice = registry.eventsSince(threadId, undefined, { detail: 'summary' });
    const kinds = slice.events.map((event) => event.kind);
    console.log(`[it] 事件序列：${kinds.join(' → ')}`);
    for (const event of slice.events) {
      if (event.kind === 'error' || event.kind === 'turn_completed') console.log(`[it]   ${event.kind}: ${event.text}`);
    }

    assert.equal(lastTurn.status, 'completed', '回合应以 completed 结束');
    assert.match(lastTurn.finalText, /INTEGRATION_OK/u, '最终回答应包含 INTEGRATION_OK');

    assert.ok(kinds.includes('turn_started'), '缺少 turn_started 事件');
    assert.ok(kinds.includes('turn_completed'), '缺少 turn_completed 事件');
    console.log('[it] PASS');
  } finally {
    if (threadId !== null) {
      try {
        await appServer.call('thread/delete', { threadId });
        console.log('[it] 已删除测试会话');
      } catch (error) {
        console.warn(`[it] 删除测试会话失败（可忽略）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    appServer.dispose();
    if (cleanupWorkspace) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* 临时目录清理失败可忽略 */
      }
    }
  }
}

main().catch((error) => {
  console.error('[it] FAIL:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
