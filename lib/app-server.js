/**
 * Codex app-server 子进程的生命周期管理。
 *
 * 插件在宿主进程里维护**唯一**一个 app-server 子进程（懒启动），所有请求
 * 串行化到这条 stdio 连接上。子进程意外退出时，下一次调用会尝试自动重启
 * 一次（`maxRestarts`），仍失败则本次插件生命周期内直接报错，避免无限拉起。
 *
 * @module dsh-plugin-codex-link/app-server
 */

import { spawn, execFileSync } from 'node:child_process';
import { createRpcSession } from './rpc-client.js';
import { resolveCodexBinary } from './codex-binary.js';

/** 告诉 Codex 是哪个客户端在连；出现在 app-server 的日志与会话元数据里。 */
export const CLIENT_INFO = Object.freeze({
  name: 'dsh-plugin-codex-link',
  title: 'DSH Codex Link',
  version: '0.4.0',
});

/** app-server 不可用时抛出的错误，`code` 固定为 `APP_SERVER_UNAVAILABLE`。 */
export class AppServerError extends Error {
  /**
   * @param {string} message 面向用户的中文说明。
   * @param {Error} [cause] 原始错误。
   */
  constructor(message, cause) {
    super(message);
    this.name = 'AppServerError';
    this.code = 'APP_SERVER_UNAVAILABLE';
    this.cause = cause;
  }
}

/** app-server 的标准输入输出管线。 */
export class CodexAppServer {
  /**
   * @param {{
   *   settings: ReturnType<typeof import('./config.js').resolveConfig>,
   *   resolveBinary?: typeof resolveCodexBinary,
   *   spawnImpl?: typeof spawn,
   *   logger?: { debug?: Function, warn?: Function, info?: Function } | null,
   *   maxRestarts?: number,
   * }} options 依赖注入点。
   */
  constructor(options) {
    this.settings = options.settings;
    this.logger = options.logger ?? null;
    this.resolveBinary = options.resolveBinary ?? resolveCodexBinary;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.maxRestarts = Number.isSafeInteger(options.maxRestarts) ? options.maxRestarts : 1;

    /** @type {'stopped' | 'starting' | 'ready' | 'failed'} */
    this.state = 'stopped';
    /** @type {import('node:child_process').ChildProcess | null} */
    this.proc = null;
    /** @type {ReturnType<typeof createRpcSession> | null} */
    this.session = null;
    /** @type {{ path: string, version: string, source: string } | null} */
    this.binaryInfo = null;
    this.disposed = false;
    this.restarts = 0;
    /** @type {Error | null} */
    this.lastError = null;
    /** @type {string[]} */
    this.stderrTail = [];
    /** @type {Promise<void> | null} */
    this.starting = null;
    /** @type {Set<(method: string, params: any) => void>} */
    this.notificationHandlers = new Set();
    /** @type {((request: { id: unknown, method: string, params: any }) => Promise<unknown> | unknown) | null} */
    this.serverRequestHandler = null;
  }

  /**
   * 订阅所有 Codex 通知。
   *
   * @param {(method: string, params: any) => void} handler 处理函数。
   * @returns {() => void} 取消订阅。
   */
  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * 设置服务端请求（审批、用户输入等）的处理函数。
   *
   * @param {((request: { id: unknown, method: string, params: any }) => Promise<unknown> | unknown) | null} handler 处理函数。
   */
  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }

  /**
   * 确保连接就绪；必要时启动子进程。
   *
   * @returns {Promise<void>} 就绪后 resolve。
   * @throws {AppServerError} 已卸载或多次启动失败时抛出。
   */
  async ensureReady() {
    if (this.disposed) throw new AppServerError('插件已卸载，无法再连接 Codex');
    if (this.state === 'ready' && this.session !== null && !this.session.closed) return;
    if (this.starting !== null) return this.starting;
    if (this.state === 'failed') {
      throw new AppServerError(
        `Codex app-server 多次启动失败：${this.lastError?.message ?? '未知原因'}${this.#stderrSuffix()}`,
        this.lastError ?? undefined,
      );
    }
    this.starting = this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * 启动子进程并完成 `initialize`。
   *
   * @returns {Promise<void>} 就绪后 resolve。
   */
  async #start() {
    this.state = 'starting';
    this.stderrTail = [];
    let binary;
    try {
      binary = this.binaryInfo ?? this.resolveBinary({ configuredPath: this.settings.codexPath });
    } catch (error) {
      this.state = 'stopped';
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw new AppServerError(this.lastError.message, this.lastError);
    }
    this.binaryInfo = binary;

    let proc;
    try {
      proc = this.spawnImpl(binary.path, ['app-server', '--listen', 'stdio://'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.state = 'stopped';
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw new AppServerError(`无法启动 Codex app-server：${this.lastError.message}`, this.lastError);
    }

    const session = createRpcSession({
      readable: proc.stdout,
      writable: proc.stdin,
      defaultTimeoutMs: this.settings.requestTimeoutMs,
      logger: this.logger,
    });
    session.setServerRequestHandler((request) => {
      if (this.serverRequestHandler === null) {
        return { error: { code: -32601, message: `未处理的客户端请求：${request.method}` } };
      }
      return this.serverRequestHandler(request);
    });
    session.onAny((method, params) => {
      for (const handler of this.notificationHandlers) {
        try {
          handler(method, params);
        } catch (error) {
          this.logger?.warn?.(`[codex-link] 通知处理失败（${method}）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    proc.stderr?.setEncoding?.('utf8');
    proc.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text === '') return;
      this.stderrTail.push(text);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      this.logger?.debug?.(`[codex-link] codex stderr: ${text.slice(0, 500)}`);
    });
    proc.on('exit', (code, signal) => {
      this.#handleExit(code, signal);
    });

    this.proc = proc;
    this.session = session;
    try {
      await session.request(
        'initialize',
        { clientInfo: CLIENT_INFO, capabilities: null },
        { timeoutMs: this.settings.startupTimeoutMs },
      );
      this.state = 'ready';
      this.lastError = null;
      this.logger?.info?.(`[codex-link] 已连接 Codex app-server（${binary.version || '未知版本'}）`);
    } catch (error) {
      try {
        session.close('initialize 失败');
      } catch {
        /* 忽略关闭失败 */
      }
      this.#killProc(proc);
      this.proc = null;
      this.session = null;
      this.state = 'stopped';
      this.lastError = error instanceof Error ? error : new Error(String(error));
      throw new AppServerError(
        `Codex app-server 初始化失败：${this.lastError.message}${this.#stderrSuffix()}`,
        this.lastError,
      );
    }
  }

  /**
   * 子进程退出后的状态收敛。
   *
   * @param {number | null} code 退出码。
   * @param {NodeJS.Signals | null} signal 信号。
   */
  #handleExit(code, signal) {
    this.session?.close(`app-server 已退出（code=${String(code)}, signal=${String(signal)}）`);
    this.session = null;
    this.proc = null;
    if (this.disposed) {
      this.state = 'stopped';
      return;
    }
    this.restarts += 1;
    this.lastError = new Error(`app-server 意外退出（code=${String(code)}, signal=${String(signal)}）`);
    this.state = this.restarts > this.maxRestarts ? 'failed' : 'stopped';
    this.logger?.warn?.(`[codex-link] ${this.lastError.message}；重启次数=${this.restarts}/${this.maxRestarts}`);
  }

  /**
   * 发起一次 RPC 调用。
   *
   * @param {string} method 方法名。
   * @param {unknown} [params] 参数。
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] 选项。
   * @returns {Promise<any>} 响应结果。
   */
  async call(method, params, options = {}) {
    await this.ensureReady();
    const session = this.session;
    if (session === null) throw new AppServerError('Codex app-server 连接不可用');
    try {
      return await session.request(method, params, {
        timeoutMs: options.timeoutMs ?? this.settings.requestTimeoutMs,
        signal: options.signal,
      });
    } catch (error) {
      if (error?.code === 'APP_SERVER_UNAVAILABLE') {
        throw new AppServerError(`Codex app-server 连接中断：${error.message}${this.#stderrSuffix()}`, error);
      }
      throw error;
    }
  }

  /** @returns {string} stderr 尾部，便于把诊断放进错误文本。 */
  #stderrSuffix() {
    if (this.stderrTail.length === 0) return '';
    const tail = this.stderrTail.slice(-3).join(' | ').slice(0, 600);
    return `（codex stderr：${tail}）`;
  }

  /**
   * 强制结束子进程（Windows 用 taskkill 连树终止）。
   *
   * @param {import('node:child_process').ChildProcess | null} proc 子进程。
   */
  #killProc(proc) {
    if (proc === null) return;
    try {
      proc.stdin?.end();
    } catch {
      /* 忽略 */
    }
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
    if (process.platform === 'win32' && typeof proc.pid === 'number') {
      try {
        execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
      } catch {
        /* 进程可能已退出 */
      }
    }
  }

  /**
   * 关闭连接并结束子进程；插件卸载时调用。
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.session?.close('插件已卸载');
    this.session = null;
    const proc = this.proc;
    this.proc = null;
    this.state = 'stopped';
    this.#killProc(proc);
  }
}
