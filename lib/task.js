/**
 * 子智能体执行通道：用 `codex exec --json` 起一个独立进程，解析事件流，
 * 只把最终回答（以及线程 id / 用量 / 耗时）带回 DSH。
 *
 * 与 app-server 通道相比：
 * - 不占用（也不受锁于）桌面端正打开的会话；
 * - 每次任务一个进程，天然隔离上下文；
 * - 缺点是看不到实时过程外的事件流，也无法中途 steer。
 *
 * @module dsh-plugin-codex-link/task
 */

import { spawn, execFileSync } from 'node:child_process';

import { resolveCodexBinary } from './codex-binary.js';

/** 子任务失败。`code` 供工具层直接回传。 */
export class TaskError extends Error {
  /**
   * @param {string} code 稳定错误码。
   * @param {string} message 中文说明。
   */
  constructor(code, message) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

/**
 * 一行一行喂 JSON，尽量减少半行解析失败。
 *
 * @param {string} chunk 新到的数据。
 * @param {{ buffer: string }} state 缓冲状态。
 * @param {(message: any) => void} onMessage 每条完整 JSON 的回调。
 */
function feedLines(chunk, state, onMessage) {
  state.buffer += chunk;
  for (;;) {
    const newline = state.buffer.indexOf('\n');
    if (newline < 0) return;
    const line = state.buffer.slice(0, newline).trim();
    state.buffer = state.buffer.slice(newline + 1);
    if (line === '') continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      // 非 JSON 行（例如 stderr 混入）忽略：最终结果以进程退出码和 turn 事件为准。
    }
  }
}

/** 独立执行 `codex exec` 的子智能体运行器。 */
export class TaskRunner {
  /**
   * @param {{
   *   settings: ReturnType<typeof import('./config.js').resolveConfig>,
   *   resolveBinary?: Function,
   *   spawnImpl?: typeof spawn,
   *   logger?: { info?: Function, warn?: Function } | null,
   *   maxParallel?: number,
   * }} options 依赖注入。
   */
  constructor(options) {
    this.settings = options.settings;
    this.resolveBinary = options.resolveBinary ?? resolveCodexBinary;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.logger = options.logger ?? null;
    this.maxParallel = Number.isSafeInteger(options.maxParallel) && options.maxParallel > 0 ? options.maxParallel : 2;
    /** @type {Set<import('node:child_process').ChildProcess>} */
    this.children = new Set();
  }

  /** @returns {number} 正在运行的子任务数。 */
  get activeCount() {
    return this.children.size;
  }

  /**
   * 跑一个独立子任务。
   *
   * @param {{
   *   task: string,
   *   cwd?: string,
   *   sandbox?: string,
   *   model?: string | null,
   *   timeoutMs?: number,
   * }} request 请求。
   * @returns {Promise<{
   *   ok: boolean,
   *   text: string,
   *   threadId: string | null,
   *   durationMs: number,
   *   usage: any,
   *   errorCode?: string,
   *   errorDetail?: string,
   * }>} 执行结果。
   */
  async run(request) {
    const task = typeof request.task === 'string' ? request.task.trim() : '';
    if (task === '') throw new TaskError('EMPTY_PROMPT', '任务内容不能为空');
    if (this.children.size >= this.maxParallel) {
      throw new TaskError('TASK_BUSY', `同时运行的 Codex 子任务已达上限（${this.maxParallel}），请等其中一个结束。`);
    }

    const binary = this.resolveBinary({ configuredPath: this.settings.codexPath });
    const cwd =
      typeof request.cwd === 'string' && request.cwd.trim() !== '' ? request.cwd.trim() : this.settings.workspaceRoot;
    const sandbox =
      typeof request.sandbox === 'string' && ['read-only', 'workspace-write', 'danger-full-access'].includes(request.sandbox)
        ? request.sandbox
        : this.settings.sandbox;
    const timeoutMs =
      Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : this.settings.requestTimeoutMs;

    /** @type {string[]} */
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '--sandbox', sandbox];
    if (typeof request.model === 'string' && request.model.trim() !== '') args.push('--model', request.model.trim());
    args.push('--', task);

    const startedAt = Date.now();
    const child = this.spawnImpl(binary.path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    this.children.add(child);

    /** @type {{ text: string, threadId: string | null, usage: any, failure: string | null, errorText: string | null }} */
    const collected = { text: '', threadId: null, usage: null, failure: null, errorText: null };
    const stdoutState = { buffer: '' };
    /** @type {string[]} */
    const stderrTail = [];

    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) =>
      feedLines(String(chunk), stdoutState, (message) => {
        if (message === null || typeof message !== 'object') return;
        const type = message.type;
        if (type === 'thread.started' && typeof message.thread_id === 'string') {
          collected.threadId = message.thread_id;
          return;
        }
        if (type === 'item.completed' && message.item?.type === 'agent_message' && typeof message.item.text === 'string') {
          collected.text = message.item.text;
          return;
        }
        if (type === 'item.completed' && message.item?.type === 'error' && typeof message.item.message === 'string') {
          collected.errorText = message.item.message;
          return;
        }
        if (type === 'turn.completed') {
          collected.usage = message.usage ?? null;
          return;
        }
        if (type === 'turn.failed') {
          collected.failure = typeof message.error?.message === 'string' ? message.error.message : 'turn failed';
          return;
        }
        if (type === 'error' && typeof message.message === 'string') {
          collected.errorText = message.message;
        }
      }),
    );
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text === '') return;
      stderrTail.push(text);
      if (stderrTail.length > 20) stderrTail.shift();
      this.logger?.debug?.(`[codex-link] task stderr: ${text.slice(0, 300)}`);
    });

    const exit = await new Promise((resolve) => {
      let settled = false;
      /** @param {{ code: number | null, signal: string | null, timedOut: boolean }} outcome */
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        this.#kill(child);
        settle({ code: null, signal: 'timeout', timedOut: true });
      }, timeoutMs);
      child.once('error', (error) => {
        this.logger?.warn?.(`[codex-link] task 启动失败：${error instanceof Error ? error.message : String(error)}`);
        settle({ code: null, signal: 'error', timedOut: false });
      });
      child.once('close', (code, signal) => settle({ code, signal, timedOut: false }));
    });

    this.children.delete(child);
    const durationMs = Date.now() - startedAt;
    const stderrSuffix = stderrTail.length === 0 ? '' : `（stderr：${stderrTail.slice(-2).join(' | ').slice(0, 400)}）`;

    if (exit.timedOut) {
      return {
        ok: false,
        text: collected.text,
        threadId: collected.threadId,
        durationMs,
        usage: collected.usage,
        errorCode: 'TASK_TIMEOUT',
        errorDetail: `子任务超过 ${timeoutMs}ms 未完成，已终止。`,
      };
    }
    if (collected.failure !== null || exit.code !== 0) {
      return {
        ok: false,
        text: collected.text,
        threadId: collected.threadId,
        durationMs,
        usage: collected.usage,
        errorCode: 'TASK_FAILED',
        errorDetail: `${collected.failure ?? `codex exec 退出码 ${String(exit.code)}`}${stderrSuffix}`,
      };
    }
    return {
      ok: true,
      text: collected.text,
      threadId: collected.threadId,
      durationMs,
      usage: collected.usage,
    };
  }

  /**
   * 结束一个子进程（Windows 连树终止）。
   *
   * @param {import('node:child_process').ChildProcess | null} child 子进程。
   */
  #kill(child) {
    if (child === null) return;
    try {
      child.kill();
    } catch {
      /* 可能已退出 */
    }
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
      } catch {
        /* 已退出 */
      }
    }
  }

  /** 插件卸载时终止所有仍在运行的子任务。 */
  dispose() {
    for (const child of this.children) this.#kill(child);
    this.children.clear();
  }
}
