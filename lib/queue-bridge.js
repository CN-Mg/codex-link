/**
 * 直控回退通道：当目标 Codex 会话被桌面端占用（active writer）时，用 Codex
 * 官方的 `codex queue` 把消息投递进那个正在打开的会话。
 *
 * `queue` 只负责投递，执行与结果都在 Codex 客户端里；因此结果需要从会话的
 * rollout 文件增量读取（见 `rollout-tail.js`）。
 *
 * @module dsh-plugin-codex-link/queue-bridge
 */

import { spawn, execFileSync } from 'node:child_process';

/** queue 投递失败。 */
export class QueueError extends Error {
  /**
   * @param {string} code 稳定错误码。
   * @param {string} message 中文说明。
   */
  constructor(code, message) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

/**
 * 解析 `codex queue` 的输出，取消息 id。
 *
 * @param {string} output 标准输出/错误合并文本。
 * @returns {string | null} 消息 id。
 */
export function parseQueueOutput(output) {
  const match = /Queued message ([0-9a-f-]+) for thread (\S+)/iu.exec(output ?? '');
  return match === null ? null : match[1];
}

/**
 * 把一条消息投递到指定 Codex 会话（官方 queue 通道）。
 *
 * @param {{
 *   binaryPath: string,
 *   threadId: string,
 *   text: string,
 *   spawnImpl?: typeof spawn,
 *   timeoutMs?: number,
 *   logger?: { debug?: Function, warn?: Function } | null,
 * }} options 参数。
 * @returns {Promise<{ ok: boolean, messageId: string | null, output: string }>} 投递结果。
 */
export async function queueMessage(options) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000;
  const startedAt = Date.now();

  const child = spawnImpl(
    options.binaryPath,
    ['queue', '--thread', options.threadId, '--message', options.text],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );

  /** @type {string[]} */
  const chunks = [];
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', (chunk) => chunks.push(String(chunk)));
  child.stderr?.on('data', (chunk) => chunks.push(String(chunk)));

  const exit = await new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      if (process.platform === 'win32' && typeof child.pid === 'number') {
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 10_000,
          });
        } catch {
          /* 已退出 */
        }
      }
      settle({ code: null, timedOut: true });
    }, timeoutMs);
    child.once('error', (error) => {
      options.logger?.warn?.(`[codex-link] queue 启动失败：${error instanceof Error ? error.message : String(error)}`);
      settle({ code: null, timedOut: false });
    });
    child.once('close', (code) => settle({ code, timedOut: false }));
  });

  const output = chunks.join('').trim();
  if (exit.timedOut) throw new QueueError('QUEUE_TIMEOUT', `queue 投递超时（${timeoutMs}ms）`);
  if (exit.code !== 0) {
    throw new QueueError('QUEUE_FAILED', `queue 投递失败（退出码 ${String(exit.code)}）：${output.slice(0, 500)}`);
  }
  const messageId = parseQueueOutput(output);
  options.logger?.debug?.(`[codex-link] queue 已投递 ${String(messageId)} 用时 ${Date.now() - startedAt}ms`);
  return { ok: true, messageId, output };
}
